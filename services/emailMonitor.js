const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { parsePaymentEmail, isTrustedSender } = require('./paymentParser');

class EmailMonitor {
  constructor(config) {
    this.user = config.user;
    this.pass = config.pass.replace(/\s+/g, '');
    this.client = null;
    this.isConnected = false;
    this.isSyncing = false;
    this.payments = [];
    this.lastSyncTime = null;
    this.syncInterval = null;
    this.listeners = new Set();
    
    // Set of claimed payment identifiers (UID, UTR, TxnID)
    this.claimedKeys = new Set();
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
      console.error('[EmailMonitor] IMAP error:', err.message);
      this.isConnected = false;
    });

    client.on('close', () => {
      console.log('[EmailMonitor] IMAP connection closed.');
      this.isConnected = false;
    });

    client.on('exists', (data) => {
      console.log(`[EmailMonitor] New message event detected! Total count: ${data.count}`);
      this.syncRecentEmails(10).catch(() => {});
    });
  }

  async start() {
    try {
      console.log(`[EmailMonitor] Connecting to Gmail IMAP for ${this.user}...`);
      this.client = this.createClient();
      this.setupClientHandlers(this.client);

      await this.client.connect();
      this.isConnected = true;
      console.log('[EmailMonitor] Connected successfully to Gmail IMAP!');

      // Initial sync of the last 40 emails
      await this.syncRecentEmails(40);

      // Periodically poll for new emails every 3 seconds with NOOP
      this.syncInterval = setInterval(() => {
        this.syncRecentEmails(10).catch(() => {});
      }, 3000);

    } catch (err) {
      console.error('[EmailMonitor] Initial connection failed:', err.message);
      this.isConnected = false;
      setTimeout(() => this.start(), 4000);
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
        console.log('[EmailMonitor] Reconnected to Gmail IMAP successfully.');
      } catch (err) {
        this.isConnected = false;
        throw err;
      }
    }
  }

  async syncRecentEmails(limit = 20) {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      await this.ensureConnected();

      let lock = await this.client.getMailboxLock('INBOX');
      try {
        // Send NOOP to force Gmail server to deliver new messages / update mailbox.exists
        await this.client.noop();

        const total = this.client.mailbox.exists;
        if (total > 0) {
          const start = Math.max(1, total - limit + 1);
          const range = `${start}:${total}`;

          for await (let msg of this.client.fetch(range, { envelope: true, source: true, uid: true })) {
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
                this.addPayment(payment);
              }
            } catch (pErr) {
              // Ignore single message parse error
            }
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

  addPayment(payment) {
    const exists = this.payments.find(p => 
      (payment.uid && p.uid === payment.uid) ||
      (payment.txnId && p.txnId === payment.txnId) ||
      (payment.utr && p.utr === payment.utr && Math.abs(p.amount - payment.amount) < 0.01)
    );

    if (!exists) {
      this.payments.unshift(payment);
      if (this.payments.length > 100) this.payments.pop();

      console.log(`[EmailMonitor] Found payment: ₹${payment.amount} from "${payment.senderName}" (UTR: ${payment.utr || 'N/A'}, Txn: ${payment.txnId || 'N/A'}, Date: ${new Date(payment.date).toLocaleTimeString()})`);

      // Notify SSE listeners
      for (const listener of this.listeners) {
        try { listener(payment); } catch (e) {}
      }
    }
  }

  /**
   * Check if a payment has already been claimed/consumed
   */
  isClaimed(payment) {
    if (!payment) return false;
    if (payment.uid && this.claimedKeys.has(`UID_${payment.uid}`)) return true;
    if (payment.utr && this.claimedKeys.has(`UTR_${payment.utr}`)) return true;
    if (payment.txnId && this.claimedKeys.has(`TXN_${payment.txnId}`)) return true;
    return false;
  }

  /**
   * Mark a payment as claimed by an order
   */
  claimPayment(payment, orderId) {
    if (!payment) return;
    if (payment.uid) this.claimedKeys.add(`UID_${payment.uid}`);
    if (payment.utr) this.claimedKeys.add(`UTR_${payment.utr}`);
    if (payment.txnId) this.claimedKeys.add(`TXN_${payment.txnId}`);
    payment.claimedByOrder = orderId || 'MANUAL';
    payment.claimedAt = new Date();
    console.log(`[EmailMonitor] Payment CLAIMED for order "${orderId}": ₹${payment.amount} (UTR: ${payment.utr || 'N/A'}, UID: ${payment.uid || 'N/A'})`);
  }

  /**
   * Search for an UNCLAIMED payment matching amount, time, or UTR
   */
  async findPayment({ amount, utr, sinceDate, orderId, graceSeconds = 90 }) {
    const targetAmount = amount !== undefined && amount !== null ? parseFloat(amount) : null;
    const cleanUtr = utr ? utr.toString().trim().toLowerCase() : null;
    
    // Strict order session time check:
    // Email must have arrived after (order.createdAt - graceSeconds)
    // graceSeconds (default 90s) allows for slight clock differences between client and mail server
    const minTimestamp = sinceDate ? (new Date(sinceDate).getTime() - graceSeconds * 1000) : (Date.now() - 30 * 60 * 1000);

    // 1. Check in-memory cache
    let found = this.matchInCache(targetAmount, cleanUtr, minTimestamp, orderId);
    if (found) return found;

    // 2. Force immediate live sync with NOOP
    try {
      await this.syncRecentEmails(20);
      found = this.matchInCache(targetAmount, cleanUtr, minTimestamp, orderId);
      if (found) return found;
    } catch (e) {
      console.error('[EmailMonitor] Live search sync error:', e.message);
    }

    return null;
  }

  matchInCache(targetAmount, cleanUtr, minTimestamp, orderId) {
    for (const p of this.payments) {
      // If already claimed by another order, ignore it!
      if (this.isClaimed(p)) {
        if (!orderId || p.claimedByOrder !== orderId) {
          continue;
        }
      }

      const paymentTime = new Date(p.date).getTime();

      // Priority 1: UTR Matching
      if (cleanUtr) {
        const pUtr = (p.utr || '').toLowerCase();
        const pTxn = (p.txnId || '').toLowerCase();
        const pSnippet = (p.snippet || '').toLowerCase();
        if (pUtr.includes(cleanUtr) || pTxn.includes(cleanUtr) || pSnippet.includes(cleanUtr)) {
          if (targetAmount !== null) {
            if (Math.abs(p.amount - targetAmount) < 0.01) {
              return p;
            }
          } else {
            return p;
          }
        }
      }

      // Priority 2: Amount + Timestamp Matching
      if (targetAmount !== null) {
        if (Math.abs(p.amount - targetAmount) < 0.01) {
          // Check that email timestamp is newer than order start time (minus grace period)
          if (paymentTime >= minTimestamp) {
            return p;
          } else {
            // Email was before this order started, log trace
            // console.log(`[EmailMonitor] Candidate ₹${p.amount} arrived at ${new Date(p.date).toLocaleTimeString()} which is earlier than required ${new Date(minTimestamp).toLocaleTimeString()}`);
          }
        }
      }
    }
    return null;
  }

  getStatus() {
    return {
      connected: this.isConnected,
      email: this.user,
      cachedPaymentsCount: this.payments.length,
      claimedCount: this.claimedKeys.size,
      lastSyncTime: this.lastSyncTime,
      recentPayments: this.payments.slice(0, 8).map(p => ({
        amount: p.amount,
        senderName: p.senderName,
        utr: p.utr,
        txnId: p.txnId,
        date: p.date,
        claimed: this.isClaimed(p)
      }))
    };
  }
}

module.exports = EmailMonitor;
