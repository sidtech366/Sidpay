const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MerchantModel, OrderModel, connectMongo, getIsConnected } = require('./mongo');

const DB_PATH = path.join(__dirname, '..', 'data', 'store.json');

class Store {
  constructor() {
    this.data = {
      merchants: {},
      orders: {}
    };
    this.mongoReady = false;
    this.loadLocal();
    this.ensureDefaultMerchant();
    this.applyEnvToDefaultMerchant();
    this.initMongo();
  }

  /**
   * Render / .env settings are the source of truth for the default merchant.
   * Change UPI_ID, BUSINESS_NAME, PAYEE_NAME or MERCHANT_PASSWORD in Render,
   * redeploy, and the saved merchant is updated (also in MongoDB).
   */
  applyEnvToDefaultMerchant() {
    const m = this.data.merchants['merch_default'];
    if (!m) return;
    const updates = {};
    const env = (k) => (process.env[k] || '').trim();
    if (env('UPI_ID') && env('UPI_ID') !== m.upiId) updates.upiId = env('UPI_ID');
    if (env('BUSINESS_NAME') && env('BUSINESS_NAME') !== m.businessName) updates.businessName = env('BUSINESS_NAME');
    if (env('PAYEE_NAME') && env('PAYEE_NAME') !== m.name) updates.name = env('PAYEE_NAME');
    if (process.env.MERCHANT_PASSWORD && process.env.MERCHANT_PASSWORD !== m.password) updates.password = process.env.MERCHANT_PASSWORD;
    if (Object.keys(updates).length === 0) return;
    Object.assign(m, updates);
    this.saveLocal();
    if (this.mongoReady) {
      MerchantModel.findOneAndUpdate({ id: m.id }, { $set: updates }).catch(err => {
        console.error('[Store] Mongo env-sync error:', err.message);
      });
    }
    const shown = Object.keys(updates).map(k => k === 'password' ? 'password' : `${k}=${updates[k]}`).join(', ');
    console.log(`[Store] Default merchant updated from settings: ${shown}`);
  }

  loadLocal() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.merchants) this.data.merchants = {};
        if (!this.data.orders) this.data.orders = {};
      }
    } catch (e) {
      console.warn('[Store] Could not load local store.json, using defaults:', e.message);
    }
  }

  saveLocal() {
    try {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Store] Local save failed:', e.message);
    }
  }

  async initMongo() {
    try {
      const connected = await connectMongo();
      if (!connected) return;
      this.mongoReady = true;

      // Sync existing records to MongoDB or load from MongoDB
      const countMerchants = await MerchantModel.countDocuments();
      if (countMerchants === 0) {
        console.log('[Store] Seeding local data to MongoDB Atlas...');
        await this.syncAllToMongo();
      } else {
        console.log('[Store] Loading data from MongoDB Atlas...');
        await this.loadFromMongo();
      }
      this.applyEnvToDefaultMerchant();
    } catch (err) {
      console.error('[Store] MongoDB sync error:', err.message);
    }
  }

  async syncAllToMongo() {
    try {
      for (const m of Object.values(this.data.merchants)) {
        await MerchantModel.findOneAndUpdate({ id: m.id }, m, { upsert: true, returnDocument: 'after' });
      }
      for (const o of Object.values(this.data.orders)) {
        await OrderModel.findOneAndUpdate({ orderId: o.orderId }, o, { upsert: true, returnDocument: 'after' });
      }
      console.log('[Store] Initial seed to MongoDB Atlas complete.');
    } catch (err) {
      console.error('[Store] Seed to MongoDB failed:', err.message);
    }
  }

  async loadFromMongo() {
    try {
      const merchants = await MerchantModel.find({}).lean();
      for (const m of merchants) {
        this.data.merchants[m.id] = m;
      }
      const orders = await OrderModel.find({}).lean();
      for (const o of orders) {
        this.data.orders[o.orderId] = o;
      }
      this.saveLocal();
      console.log(`[Store] Synced from MongoDB Atlas: ${merchants.length} merchants, ${orders.length} orders.`);
    } catch (err) {
      console.error('[Store] Loading from MongoDB failed:', err.message);
    }
  }

  ensureDefaultMerchant() {
    if (Object.keys(this.data.merchants).length === 0) {
      const defaultId = 'merch_default';
      const defaultApiKey = process.env.DEFAULT_API_KEY || `sid_live_${crypto.randomBytes(16).toString('hex')}`;
      const defaultPassword = process.env.MERCHANT_PASSWORD || crypto.randomBytes(9).toString('base64url');
      if (!process.env.MERCHANT_PASSWORD) {
        console.warn(`[Store] MERCHANT_PASSWORD not set. Generated one-time dashboard password: ${defaultPassword}`);
      }
      const defaultMerchant = {
        id: defaultId,
        name: process.env.PAYEE_NAME || 'SidTech 366',
        email: process.env.GMAIL_USER || 'sidtech366@gmail.com',
        password: defaultPassword,
        businessName: process.env.BUSINESS_NAME || 'SidTech 366',
        upiId: process.env.UPI_ID || '',
        qrImagePath: '/uploads/default-qr.jpeg',
        gmailUser: process.env.GMAIL_USER || 'sidtech366@gmail.com',
        gmailAppPass: process.env.GMAIL_APP_PASS || '',
        apiKey: defaultApiKey,
        isOnboarded: true,
        createdAt: new Date().toISOString()
      };
      this.data.merchants[defaultId] = defaultMerchant;
      this.saveLocal();
    }
  }

  createMerchant(data) {
    const id = `merch_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const apiKey = `sid_live_${crypto.randomBytes(16).toString('hex')}`;
    const merchant = {
      id,
      name: data.name || 'Merchant',
      email: data.email.toLowerCase().trim(),
      password: data.password,
      businessName: data.businessName || `${data.name}'s Store`,
      upiId: data.upiId || '',
      qrImagePath: data.qrImagePath || '/uploads/default-qr.jpeg',
      gmailUser: data.gmailUser || data.email,
      gmailAppPass: data.gmailAppPass || '',
      apiKey,
      isOnboarded: false,
      createdAt: new Date().toISOString()
    };
    this.data.merchants[id] = merchant;
    this.saveLocal();

    // Persist to MongoDB
    MerchantModel.findOneAndUpdate({ id }, merchant, { upsert: true }).catch(err => {
      console.error('[Store] Mongo Merchant insert error:', err.message);
    });

    return merchant;
  }

  getMerchantById(id) {
    return this.data.merchants[id] || null;
  }

  getMerchantByEmail(email) {
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    return Object.values(this.data.merchants).find(m => m.email === clean) || null;
  }

  getMerchantByApiKey(apiKey) {
    if (!apiKey) return null;
    return Object.values(this.data.merchants).find(m => m.apiKey === apiKey) || null;
  }

  updateMerchant(id, updates) {
    const m = this.data.merchants[id];
    if (!m) return null;
    Object.assign(m, updates);
    this.saveLocal();

    // Persist to MongoDB
    MerchantModel.findOneAndUpdate({ id }, { $set: updates }).catch(err => {
      console.error('[Store] Mongo Merchant update error:', err.message);
    });

    return m;
  }

  createOrder(data) {
    const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const order = {
      orderId,
      merchantId: data.merchantId,
      amount: parseFloat(data.amount),
      customerName: data.customerName || 'Customer',
      customerEmail: data.customerEmail || '',
      note: data.note || `Payment #${orderId}`,
      status: 'PENDING',
      dynamicUpiUrl: data.dynamicUpiUrl || '',
      dynamicQrDataUrl: data.dynamicQrDataUrl || '',
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      paymentDetails: null
    };
    this.data.orders[orderId] = order;
    this.saveLocal();

    // Persist to MongoDB
    OrderModel.findOneAndUpdate({ orderId }, order, { upsert: true }).catch(err => {
      console.error('[Store] Mongo Order insert error:', err.message);
    });

    return order;
  }

  getOrder(orderId) {
    return this.data.orders[orderId] || null;
  }

  updateOrder(orderId, updates) {
    const order = this.data.orders[orderId];
    if (!order) return null;
    Object.assign(order, updates);
    this.saveLocal();

    // Persist to MongoDB
    OrderModel.findOneAndUpdate({ orderId }, { $set: updates }).catch(err => {
      console.error('[Store] Mongo Order update error:', err.message);
    });

    return order;
  }

  getOrdersByMerchant(merchantId) {
    return Object.values(this.data.orders)
      .filter(o => o.merchantId === merchantId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getPendingOrdersByMerchant(merchantId) {
    const now = Date.now();
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes maximum pending window
    return Object.values(this.data.orders)
      .filter(o => {
        if (o.merchantId !== merchantId || o.status !== 'PENDING') return false;
        const age = now - new Date(o.createdAt).getTime();
        return age <= MAX_AGE_MS;
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Newest first
  }
}

module.exports = new Store();
