const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { parsePaymentEmail, isTrustedSender } = require('./paymentParser');
const { OrderModel } = require('./mongo');
const store = require('./store');

class ConcurrencyWatcher {
  constructor(config) {
    this.merchantId = config.merchantId;
    this.user = config.user;
    this.pass = config.pass.replace(/\s+/g, '');
    this.client = null;
    this.isConnected = false;
    this.isSyncing = false;
    this.pollInterval = null;
    this.lastSyncTime = null;
    
    // Concurrency tracking
    this.claimedPaymentKeys = new Set(); // UTR, TxnId, UID
    this.parsedUids = new Set(); // Fast deduplication cache
    this.highestUidSeen = 0;
    this.orderStreams = new Map(); // orderId -> Set of res objects (SSE)
    this.merchantStreams = new Set(); // merchant dashboard SSE listeners
    this.recentPayments = [];
    this.isProcessingQueue = false;
  }

  createClient() {
    return new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: this.user,
        pass: this.pass
      },
      logger: false,
      emitLogs: false
    });
  }

  setupClientHandlers(client) {
    client.on('error', (err) => {
      console.error(`[Watcher:${this.merchantId}] IMAP error:`, err.message);
      this.isConnected = false;
    });

    client.on('close', () => {
      this.isConnected = false;
    });

    client.on('exists', (data) => {
      console.log(`[Watcher:${this.merchantId}] Immediate email push! Mailbox total: ${data.count}`);
      this.syncAndProcess(3).catch(() => {});
    });
  }

  async start() {
    try {
      console.log(`[Watcher:${this.merchantId}] Connecting to IMAP for ${this.user}...`);
      this.client = this.createClient();
      this.setupClientHandlers(this.client);

      await this.client.connect();
      this.isConnected = true;
      console.log(`[Watcher:${this.merchantId}] Connected successfully!`);

      // Initial sync of the last 15 emails to populate parsedUids cache
      await this.syncAndProcess(15);

      // Ultra-fast background pulse loop: checks every 1000ms with light UID check
      this.pollInterval = setInterval(() => {
        this.syncAndProcess(3).catch(() => {});
      }, 1000);

    } catch (err) {
      console.error(`[Watcher:${this.merchantId}] Initial connection failed:`, err.message);
      this.isConnected = false;
      setTimeout(() => this.start(), 3000);
    }
  }

  async ensureConnected() {
    if (!this.client || !this.isConnected || !this.client.usable) {
      try {
        if (this.client) {
          try { await this.client.logout(); } catch (e) {}
        }
        this.client = this.createClient();
        this.setupClientHandlers(this.client);
        await this.client.connect();
        this.isConnected = true;
      } catch (err) {
        this.isConnected = false;
        throw err;
      }
    }
  }

  async syncAndProcess(limit = 3) {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      await this.ensureConnected();

      let lock = await this.client.getMailboxLock('INBOX');
      try {
        await this.client.noop();

        const total = this.client.mailbox.exists;
        if (total > 0) {
          const fetchCount = Math.min(total, limit);
          const start = Math.max(1, total - fetchCount + 1);
          const range = `${start}:${total}`;

          for await (let msg of this.client.fetch(range, { envelope: true, source: true, uid: true })) {
            if (this.parsedUids.has(msg.uid)) continue;
            this.parsedUids.add(msg.uid);
            if (msg.uid > this.highestUidSeen) this.highestUidSeen = msg.uid;

            try {
              const parsed = await simpleParser(msg.source);
              if (!isTrustedSender(parsed)) continue;
              const payment = parsePaymentEmail(
                parsed.subject,
                parsed.text,
                parsed.html,
                parsed.date,
                msg.uid
              );

              if (payment) {
                await this.handleIncomingPayment(payment);
              }
            } catch (pErr) {}
          }
        }
      } finally {
        lock.release();
      }

      this.lastSyncTime = new Date();
    } catch (err) {
      this.isConnected = false;
    } finally {
      this.isSyncing = false;
    }
  }

  isPaymentClaimed(payment) {
    if (payment.uid && this.claimedPaymentKeys.has(`UID_${payment.uid}`)) return true;
    if (payment.utr && this.claimedPaymentKeys.has(`UTR_${payment.utr}`)) return true;
    if (payment.txnId && this.claimedPaymentKeys.has(`TXN_${payment.txnId}`)) return true;
    return false;
  }

  claimPayment(payment, orderId) {
    if (payment.uid) this.claimedPaymentKeys.add(`UID_${payment.uid}`);
    if (payment.utr) this.claimedPaymentKeys.add(`UTR_${payment.utr}`);
    if (payment.txnId) this.claimedPaymentKeys.add(`TXN_${payment.txnId}`);
    payment.claimedByOrder = orderId;
    payment.claimedAt = new Date();
  }

  /**
   * CONCURRENCY ENGINE:
   * Safely matches incoming payments with active pending orders without collisions
   */
  async handleIncomingPayment(payment) {
    // Check if already in cache
    const existsInCache = this.recentPayments.find(p =>
      (payment.uid && p.uid === payment.uid) ||
      (payment.utr && p.utr === payment.utr && Math.abs(p.amount - payment.amount) < 0.01)
    );
    if (!existsInCache) {
      this.recentPayments.unshift(payment);
      if (this.recentPayments.length > 50) this.recentPayments.pop();
    }

    // If this payment has already been claimed for an order, ignore
    if (this.isPaymentClaimed(payment)) {
      return;
    }

    // Direct live query to MongoDB Atlas so orders created from Appwrite/Vercel are immediately visible!
    let pendingOrders = [];
    try {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
      pendingOrders = await OrderModel.find({
        merchantId: this.merchantId,
        status: 'PENDING',
        createdAt: { $gte: thirtyMinsAgo }
      }).lean();
    } catch (err) {
      console.warn('[ConcurrencyEngine] Could not fetch from MongoDB, fallback to local store:', err.message);
      pendingOrders = store.getPendingOrdersByMerchant(this.merchantId);
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      return;
    }

    const paymentTime = new Date(payment.date).getTime();
    const pUtr = (payment.utr || '').toLowerCase();
    const pSnippet = (payment.snippet || '').toLowerCase();

    // 1. First Pass: Check for explicit Order ID match in payment snippet / note
    for (const order of pendingOrders) {
      const orderRef = order.orderId.toLowerCase();
      if (pSnippet.includes(orderRef)) {
        if (Math.abs(order.amount - payment.amount) < 0.01) {
          await this.executeOrderMatch(order, payment, 'EXPLICIT_ORDER_REF');
          return;
        }
      }
    }

    // 2. Second Pass: Smart candidate matching
    // Filter pending orders matching amount and within active 20-minute window
    const TWENTY_MINUTES_MS = 20 * 60 * 1000;
    const CLOCK_SKEW_MS = 180 * 1000; // 3 minutes skew tolerance

    const candidates = [];
    for (const order of pendingOrders) {
      const orderCreatedAt = new Date(order.createdAt).getTime();
      const orderStart = orderCreatedAt - CLOCK_SKEW_MS;
      const orderExpiry = orderCreatedAt + TWENTY_MINUTES_MS;

      if (Math.abs(order.amount - payment.amount) < 0.01) {
        if (paymentTime >= orderStart && paymentTime <= orderExpiry) {
          const hasActiveSSE = this.orderStreams.has(order.orderId) && this.orderStreams.get(order.orderId).size > 0;
          const timeDiff = Math.abs(paymentTime - orderCreatedAt);
          candidates.push({
            order,
            hasActiveSSE,
            timeDiff
          });
        }
      }
    }

    if (candidates.length === 0) {
      console.log(`[ConcurrencyEngine] Received payment ₹${payment.amount} (UTR: ${payment.utr || payment.txnId}) but no pending order in window matched.`);
      return;
    }

    // Sort priority:
    // 1. Orders actively being watched in open browser SSE streams
    // 2. Orders closest in time to the payment creation time
    candidates.sort((a, b) => {
      if (a.hasActiveSSE && !b.hasActiveSSE) return -1;
      if (!a.hasActiveSSE && b.hasActiveSSE) return 1;
      return a.timeDiff - b.timeDiff;
    });

    const chosen = candidates[0].order;
    const matchType = candidates[0].hasActiveSSE ? 'ACTIVE_BROWSER_MATCH' : 'CLOSEST_TIME_MATCH';
    await this.executeOrderMatch(chosen, payment, matchType);
  }

  async executeOrderMatch(order, payment, matchType) {
    this.claimPayment(payment, order.orderId);
    
    // 1. Instantly write to MongoDB Atlas
    try {
      await OrderModel.findOneAndUpdate(
        { orderId: order.orderId },
        {
          $set: {
            status: 'PAID',
            verifiedAt: new Date(),
            paymentDetails: payment
          }
        }
      );
    } catch(err) {
      console.error('[ConcurrencyEngine] MongoDB Atlas update error:', err.message);
    }

    // 2. Update local store
    const updatedOrder = store.updateOrder(order.orderId, {
      status: 'PAID',
      verifiedAt: new Date().toISOString(),
      paymentDetails: payment
    }) || order;

    console.log(`[ConcurrencyEngine] ✓ ORDER MATCHED [${matchType}]: Order ${order.orderId} (₹${order.amount}) -> UTR ${payment.utr || payment.txnId}`);

    // Notify dedicated order SSE stream
    this.notifyOrder(order.orderId, {
      type: 'PAYMENT_SUCCESS',
      order: updatedOrder,
      payment
    });

    // Notify merchant dashboard
    this.notifyMerchant({
      type: 'TRANSACTION_VERIFIED',
      order: updatedOrder,
      payment
    });
  }

  /**
   * Subscribe an SSE response object to an order
   */
  subscribeOrder(orderId, res) {
    if (!this.orderStreams.has(orderId)) {
      this.orderStreams.set(orderId, new Set());
    }
    this.orderStreams.get(orderId).add(res);

    res.on('close', () => {
      const set = this.orderStreams.get(orderId);
      if (set) {
        set.delete(res);
        if (set.size === 0) this.orderStreams.delete(orderId);
      }
    });
  }

  notifyOrder(orderId, payload) {
    const clients = this.orderStreams.get(orderId);
    if (clients) {
      const msg = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) {
        try { res.write(msg); } catch (e) {}
      }
    }
  }

  subscribeMerchant(res) {
    this.merchantStreams.add(res);
    res.on('close', () => {
      this.merchantStreams.delete(res);
    });
  }

  notifyMerchant(payload) {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.merchantStreams) {
      try { res.write(msg); } catch (e) {}
    }
  }

  getStatus() {
    return {
      connected: this.isConnected,
      user: this.user,
      lastSyncTime: this.lastSyncTime,
      activeQueuedOrders: store.getPendingOrdersByMerchant(this.merchantId).length,
      claimedCount: this.claimedPaymentKeys.size,
      recentPayments: this.recentPayments.slice(0, 5)
    };
  }

  destroy() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.client) {
      try { this.client.logout(); } catch (e) {}
    }
  }
}

// Global Manager for merchant watchers
class WatcherManager {
  constructor() {
    this.watchers = new Map(); // merchantId -> ConcurrencyWatcher
  }

  getOrCreate(merchant) {
    if (!merchant || !merchant.gmailUser || !merchant.gmailAppPass) return null;
    
    if (this.watchers.has(merchant.id)) {
      return this.watchers.get(merchant.id);
    }

    const watcher = new ConcurrencyWatcher({
      merchantId: merchant.id,
      user: merchant.gmailUser,
      pass: merchant.gmailAppPass
    });
    watcher.start();
    this.watchers.set(merchant.id, watcher);
    return watcher;
  }

  get(merchantId) {
    return this.watchers.get(merchantId) || null;
  }
}

module.exports = new WatcherManager();
