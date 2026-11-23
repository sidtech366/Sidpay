require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { ImapFlow } = require('imapflow');

const store = require('./services/store');
const qrHelper = require('./services/qrHelper');
const watcherManager = require('./services/concurrencyWatcher');
const crypto = require('crypto');
const { parseBankSms, isTrustedSmsSender } = require('./services/smsParser');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer Storage Configuration for QR uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `qr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const upload = multer({ storage });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// Initialize Watcher for default merchant on start
const defaultMerchant = store.getMerchantById('merch_default');
if (defaultMerchant) {
  // Starts Gmail watcher if configured, otherwise SMS-only mode
  watcherManager.getOrCreate(defaultMerchant);
}

// ==============================================================
// 1. AUTHENTICATION ENDPOINTS
// ==============================================================

// Register new merchant

// ==============================================================
// SECURITY: merchant session tokens (HMAC signed)
// ==============================================================
const SESSION_SECRET = process.env.SESSION_SECRET
  || ((process.env.DEFAULT_API_KEY || process.env.MERCHANT_PASSWORD)
      ? require('crypto').createHash('sha256').update(`sidpay|${process.env.DEFAULT_API_KEY || ''}|${process.env.MERCHANT_PASSWORD || ''}|${process.env.MONGODB_URI || ''}`).digest('hex')
      : require('crypto').randomBytes(32).toString('hex'));
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signSession(merchantId) {
  const c = require('crypto');
  const payload = `${merchantId}.${Date.now() + SESSION_TTL_MS}`;
  const sig = c.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifySession(token) {
  try {
    const c = require('crypto');
    const [b64, sig] = String(token || '').split('.');
    if (!b64 || !sig) return null;
    const payload = Buffer.from(b64, 'base64url').toString();
    const expected = c.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (sig.length !== expected.length || !c.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const dot = payload.lastIndexOf('.');
    const merchantId = payload.slice(0, dot);
    const exp = Number(payload.slice(dot + 1));
    if (!merchantId || !(exp > Date.now())) return null;
    return merchantId;
  } catch (e) {
    return null;
  }
}

function requireMerchant(req, res, next) {
  const h = req.headers.authorization || '';
  const token = (h.startsWith('Bearer ') ? h.slice(7) : '') || req.headers['x-session-token'] || req.query.token;
  const merchantId = verifySession(token);
  if (!merchantId || !store.getMerchantById(merchantId)) {
    return res.status(401).json({ error: 'Login required' });
  }
  req.merchantId = merchantId;
  req.headers['x-merchant-id'] = merchantId; // never trust client-sent merchant id
  next();
}

// Never send password / Gmail app password to the browser
function publicMerchant(m) {
  if (!m) return m;
  const { password, gmailAppPass, ...safe } = m;
  return safe;
}

function passwordMatches(given, stored) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(stored || ''));
  return a.length > 0 && a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

app.post('/api/auth/register', (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') {
    return res.status(403).json({ error: 'New registrations are disabled' });
  }
  const { name, email, password, businessName } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const existing = store.getMerchantByEmail(email);
  if (existing) {
    return res.status(400).json({ error: 'An account with this email already exists' });
  }

  const merchant = store.createMerchant({
    name,
    email,
    password,
    businessName
  });

  res.json({
    success: true,
    merchant: publicMerchant(merchant),
    token: signSession(merchant.id)
  });
});

// Login merchant
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const merchant = store.getMerchantByEmail(email);
  if (!merchant || !passwordMatches(password, merchant.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Ensure watcher is active if onboarded
  if (merchant.isOnboarded && merchant.gmailUser && merchant.gmailAppPass) {
    watcherManager.getOrCreate(merchant);
  }

  res.json({
    success: true,
    merchant: publicMerchant(merchant),
    token: signSession(merchant.id)
  });
});

// Get current merchant profile
app.get('/api/auth/me', requireMerchant, (req, res) => {
  const merchant = store.getMerchantById(req.merchantId);
  if (!merchant) {
    return res.status(404).json({ error: 'Merchant not found' });
  }
  res.json({ success: true, merchant: publicMerchant(merchant) });
});

// ==============================================================
// 2. ONBOARDING WIZARD ENDPOINTS
// ==============================================================

// Upload and Auto-Decode FamPay / UPI QR Image
app.post('/api/merchant/upload-qr', requireMerchant, upload.single('qrImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const filePath = req.file.path;
  const webPath = `/uploads/${path.basename(filePath)}`;

  // Automatically decode QR code to extract UPI ID
  const decoded = await qrHelper.decodeQrImage(filePath);

  res.json({
    success: true,
    qrImagePath: webPath,
    detectedUpiId: decoded.upiId || '',
    detectedPayeeName: decoded.payeeName || 'FamPay Merchant',
    rawQrData: decoded.raw || ''
  });
});

// Test Gmail IMAP Connection Live
app.post('/api/merchant/test-email', requireMerchant, async (req, res) => {
  const { gmailUser, gmailAppPass } = req.body;
  if (!gmailUser || !gmailAppPass) {
    return res.status(400).json({ error: 'Gmail address and App Password required' });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: gmailUser.trim(),
      pass: gmailAppPass.replace(/\s+/g, '')
    },
    logger: false
  });

  try {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    const total = client.mailbox.exists;
    lock.release();
    await client.logout();

    res.json({
      success: true,
      message: 'Connected successfully to Gmail IMAP!',
      inboxCount: total
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: 'Gmail authentication failed. Please verify 2-Step Verification is enabled and use a 16-character App Password.'
    });
  }
});

// Complete Onboarding
app.post('/api/merchant/complete-onboarding', requireMerchant, async (req, res) => {
  const { businessName, upiId, qrImagePath, gmailUser, gmailAppPass } = req.body;
  const merchantId = req.merchantId;
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) {
    return res.status(404).json({ error: 'Merchant not found' });
  }

  const updated = store.updateMerchant(merchantId, {
    businessName: businessName || merchant.businessName,
    upiId: upiId || merchant.upiId,
    qrImagePath: qrImagePath || merchant.qrImagePath,
    gmailUser: gmailUser || merchant.gmailUser,
    gmailAppPass: gmailAppPass ? gmailAppPass.replace(/\s+/g, '') : merchant.gmailAppPass,
    isOnboarded: true
  });

  // Start or update active watcher
  watcherManager.getOrCreate(updated);

  res.json({
    success: true,
    merchant: publicMerchant(updated)
  });
});

// ==============================================================
// 3. MERCHANT DASHBOARD ENDPOINTS
// ==============================================================

app.get('/api/merchant/dashboard', requireMerchant, (req, res) => {
  const merchantId = req.headers['x-merchant-id'] || 'merch_default';
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  const orders = store.getOrdersByMerchant(merchantId);
  const paidOrders = orders.filter(o => o.status === 'PAID');
  const totalVolume = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const pendingOrders = orders.filter(o => o.status === 'PENDING');

  const watcher = watcherManager.get(merchantId);
  const watcherStatus = watcher ? watcher.getStatus() : { connected: false };

  res.json({
    success: true,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      businessName: merchant.businessName,
      email: merchant.email,
      upiId: merchant.upiId,
      apiKey: merchant.apiKey,
      qrImagePath: merchant.qrImagePath,
      isOnboarded: merchant.isOnboarded
    },
    metrics: {
      totalVolume,
      paidCount: paidOrders.length,
      pendingCount: pendingOrders.length,
      totalOrders: orders.length,
      avgSpeed: '1.4s'
    },
    watcherStatus,
    recentOrders: orders.slice(0, 10)
  });
});

// Create Hosted Paywall Link
app.post('/api/merchant/create-paywall-link', requireMerchant, async (req, res) => {
  const merchantId = req.headers['x-merchant-id'] || 'merch_default';
  const { amount, customerName, customerEmail, note } = req.body;

  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  const numAmount = parseFloat(amount || 1.00);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Valid payment amount required' });
  }

  // Micro-offset concurrency slot allocation:
  const pending = store.getPendingOrdersByMerchant(merchantId);
  const used = new Set(pending.map(o => (o.amount || 0).toFixed(2)));
  let finalAmount = numAmount;
  let offset = 0;
  while (used.has(finalAmount.toFixed(2)) && offset < 50) {
    offset++;
    finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
  }

  // Pre-generate dynamic QR data with isolated exact amount and order ID
  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
    upiId: merchant.upiId,
    payeeName: merchant.businessName,
    amount: finalAmount,
    note: note || orderId.replace(/[^a-zA-Z0-9]/g, ''),
    orderId
  });

  const order = store.createOrder({
    merchantId,
    amount: finalAmount,
    customerName,
    customerEmail,
    note: note || `Payment #${orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });

  res.json({
    success: true,
    order,
    paywallUrl: `/pay/${order.orderId}`
  });
});

// Regenerate API Key
app.post('/api/merchant/regenerate-api-key', requireMerchant, (req, res) => {
  const merchantId = req.headers['x-merchant-id'] || 'merch_default';
  const crypto = require('crypto');
  const newKey = `sid_live_${crypto.randomBytes(16).toString('hex')}`;
  
  const updated = store.updateMerchant(merchantId, { apiKey: newKey });
  res.json({ success: true, apiKey: updated.apiKey });
});

// SSE Stream for Merchant Dashboard
app.get('/api/merchant/events', requireMerchant, (req, res) => {
  const merchantId = req.merchantId;
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const watcher = watcherManager.getOrCreate(merchant);
  if (watcher) {
    watcher.subscribeMerchant(res);
  }
});

// ==============================================================
// 4. PUBLIC DEVELOPER API & PAYWALL ENDPOINTS
// ==============================================================

// Create checkout order via API Key
app.post('/api/v1/checkout/create', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }

  const merchant = store.getMerchantByApiKey(apiKey);
  if (!merchant) {
    return res.status(403).json({ error: 'Invalid API Key' });
  }

  const { amount, customerName, customerEmail, note } = req.body;
  const numAmount = parseFloat(amount || 199.00);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Micro-offset concurrency slot allocation:
  const pending = store.getPendingOrdersByMerchant(merchant.id);
  const used = new Set(pending.map(o => (o.amount || 0).toFixed(2)));
  let finalAmount = numAmount;
  let offset = 0;
  while (used.has(finalAmount.toFixed(2)) && offset < 50) {
    offset++;
    finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
  }

  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
    upiId: merchant.upiId,
    payeeName: merchant.businessName,
    amount: finalAmount,
    note: note || orderId.replace(/[^a-zA-Z0-9]/g, ''),
    orderId
  });

  const order = store.createOrder({
    merchantId: merchant.id,
    amount: finalAmount,
    customerName,
    customerEmail,
    note: note || `Order #${orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });

  // Ensure watcher is active
  watcherManager.getOrCreate(merchant);

  res.json({
    success: true,
    orderId: order.orderId,
    amount: order.amount,
    currency: 'INR',
    status: order.status,
    checkoutUrl: `${req.protocol}://${req.get('host')}/pay/${order.orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });
});

// Get Public Checkout Details
app.get('/api/v1/checkout/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const merchant = store.getMerchantById(order.merchantId);

  // If dynamic QR wasn't pre-generated, generate it now
  if (!order.dynamicQrDataUrl && merchant) {
    const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
      upiId: merchant.upiId,
      payeeName: merchant.businessName,
      amount: order.amount,
      note: order.note,
      orderId: order.orderId
    });
    order.dynamicUpiUrl = upiUri;
    order.dynamicQrDataUrl = qrDataUrl;
    store.updateOrder(orderId, { dynamicUpiUrl: upiUri, dynamicQrDataUrl: qrDataUrl });
  }

  res.json({
    success: true,
    order: {
      orderId: order.orderId,
      amount: order.amount,
      customerName: order.customerName,
      note: order.note,
      status: order.status,
      dynamicUpiUrl: order.dynamicUpiUrl,
      dynamicQrDataUrl: order.dynamicQrDataUrl,
      verifiedAt: order.verifiedAt,
      paymentDetails: order.paymentDetails
    },
    merchant: {
      businessName: merchant ? merchant.businessName : 'Merchant Payee',
      upiId: merchant ? merchant.upiId : '',
      qrImagePath: merchant ? merchant.qrImagePath : '/uploads/default-qr.jpeg'
    }
  });
});

// Check payment verification status for an order
app.get('/api/v1/checkout/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'PAID') {
    return res.json({
      success: true,
      verified: true,
      order
    });
  }

  // Force quick check via watcher
  const merchant = store.getMerchantById(order.merchantId);
  if (merchant) {
    const watcher = watcherManager.getOrCreate(merchant);
    if (watcher) {
      await watcher.syncAndProcess(15);
    }
  }

  const refreshed = store.getOrder(orderId);
  return res.json({
    success: true,
    verified: refreshed.status === 'PAID',
    order: refreshed
  });
});

// Secure Digital Delivery Endpoint (Requires Verified Payment)
app.get('/api/v1/checkout/delivery/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status !== 'PAID') {
    return res.status(403).json({
      error: 'Access Denied',
      message: 'Payment has not been completed or verified yet. Please complete payment first.'
    });
  }

  const DRIVE_VIEW_URL = (process.env.DELIVERY_VIEW_URL || 'https://sidtech366.vercel.app');
  const DRIVE_DOWNLOAD_URL = (process.env.DELIVERY_DOWNLOAD_URL || process.env.DELIVERY_VIEW_URL || 'https://sidtech366.vercel.app');
  const targetUrl = req.query.download === '1' ? DRIVE_DOWNLOAD_URL : DRIVE_VIEW_URL;

  if (req.xhr || req.headers.accept?.includes('application/json') || req.query.format === 'json') {
    return res.json({
      success: true,
      verified: true,
      deliveryUrl: DRIVE_VIEW_URL,
      downloadUrl: DRIVE_DOWNLOAD_URL
    });
  }

  return res.redirect(targetUrl);
});

// Dedicated SSE Stream for an order checkout
app.get('/api/v1/checkout/events/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = store.getOrder(orderId);
  if (!order) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const merchant = store.getMerchantById(order.merchantId);
  if (merchant) {
    const watcher = watcherManager.getOrCreate(merchant);
    if (watcher) {
      watcher.subscribeOrder(orderId, res);
    }
  }
});

// Manual UTR submission on paywall
app.post('/api/v1/checkout/verify-utr', async (req, res) => {
  const { orderId, utr } = req.body;
  if (!orderId || !utr) {
    return res.status(400).json({ error: 'Order ID and UTR required' });
  }

  const order = store.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const merchant = store.getMerchantById(order.merchantId);
  const watcher = watcherManager.getOrCreate(merchant);
  if (!watcher) return res.status(500).json({ error: 'Watcher not available' });

  await watcher.syncAndProcess(25);

  if (order.status === 'PAID') {
    return res.json({ success: true, verified: true, order });
  }

  // SECURITY: exact UTR match only (partial input like "5" must not match)
  const cleanUtr = String(utr).replace(/\s+/g, '').toLowerCase();
  if (!/^[0-9a-z]{10,22}$/.test(cleanUtr)) {
    return res.status(400).json({ error: 'Enter the full 12-digit UTR / UPI Ref No' });
  }
  const matched = watcher.recentPayments.find(p => {
    const pUtr = (p.utr || '').toLowerCase();
    const pTxn = (p.txnId || '').toLowerCase();
    return (pUtr === cleanUtr || pTxn === cleanUtr) &&
           Math.abs(p.amount - order.amount) < 0.01 &&
           !watcher.isPaymentClaimed(p);
  });

  if (matched) {
    watcher.executeOrderMatch(order, matched, 'MANUAL_UTR_CONFIRMATION');
    const updated = store.getOrder(orderId);
    return res.json({
      success: true,
      verified: true,
      order: updated
    });
  }

  return res.json({
    success: false,
    verified: false,
    message: 'UTR not found yet. Wait 1-2 minutes for the bank SMS, then try again.'
  });
});


// ==============================================================
// SMS WEBHOOK (Bank of Baroda / Jio Payments Bank credit SMS)
// Android SMS-forwarder app on the bank-SIM phone POSTs every SMS here.
// Auth: header "x-sms-secret: <SMS_WEBHOOK_SECRET>" or "?secret=<...>"
// Body (any of): { from|sender, text|message|body, receivedStamp|timestamp, merchantId }
// ==============================================================
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

app.post('/api/v1/sms-webhook', async (req, res) => {
  const secret = process.env.SMS_WEBHOOK_SECRET || '';
  if (secret.length < 16) {
    return res.status(503).json({ error: 'SMS webhook disabled. Set SMS_WEBHOOK_SECRET (min 16 chars) in .env' });
  }
  const given = req.headers['x-sms-secret'] || req.query.secret || (req.body && req.body.secret);
  // '+' in an unencoded URL query arrives as a space
  if (!safeEqual(given, secret) && !safeEqual(String(given || '').replace(/ /g, '+'), secret)) {
    console.log('[SMS] Rejected: wrong or missing secret');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const b = req.body || {};
  const sender = b.from || b.sender || b.address || '';
  const text = b.text || b.message || b.body || b.content || '';
  const receivedAt = b.receivedStamp || b.timestamp || b.sentStamp || b.date || null;

  console.log(`[SMS] Received from ${sender}: ${String(text).slice(0, 60)}...`);
  if (!isTrustedSmsSender(sender)) {
    console.log(`[SMS] Ignored: sender ${sender} not trusted`);
    return res.json({ success: true, ignored: true, reason: 'Sender not in trusted bank list' });
  }

  const payment = parseBankSms(sender, text, receivedAt);
  if (!payment) {
    console.log('[SMS] Ignored: not a UPI credit SMS (debit/reversal/other)');
    return res.json({ success: true, ignored: true, reason: 'Not a UPI credit SMS' });
  }

  const merchantId = b.merchantId || req.query.merchantId || 'merch_default';
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  const watcher = watcherManager.getOrCreate(merchant);
  if (!watcher) return res.status(500).json({ error: 'Watcher not available' });

  console.log(`[SMS] Credit ₹${payment.amount} UTR ${payment.utr} from ${sender}`);
  await watcher.handleIncomingPayment(payment);

  return res.json({ success: true, accepted: true, amount: payment.amount, utr: payment.utr });
});


// ==============================================================
// SMS TEST (browser-friendly): injects a FAKE Bank of Baroda credit SMS
// GET /api/v1/sms-test?secret=<SMS_WEBHOOK_SECRET>&amount=1.00
// Same parser + matching engine as real SMS. Marked as TEST in the order.
// ==============================================================
app.get('/api/v1/sms-test', async (req, res) => {
  const secret = process.env.SMS_WEBHOOK_SECRET || '';
  const given = String(req.query.secret || '');
  if (secret.length < 16 || (!safeEqual(given, secret) && !safeEqual(given.replace(/ /g, '+'), secret))) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  const amount = parseFloat(req.query.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'amount required, e.g. &amount=1.00' });

  const utr = String(Math.floor(100000000000 + Math.random() * 899999999999));
  const last4 = process.env.SMS_ACCOUNT_LAST4 || '0000';
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const smsText = `Dear BOB UPI User: Your account XXXXXX${last4} is credited with INR ${amount.toFixed(2)} on ${now} by UPI Ref No ${utr}; AvlBal: Rs1000.00 - BOB`;
  const sender = 'JK-BOBSMS-S';

  const payment = parseBankSms(sender, smsText, Date.now());
  if (!payment) return res.status(500).json({ error: 'Parser rejected test SMS', smsText });
  payment.source = 'TEST SMS (fake - no real money)';
  payment.senderName = 'TEST';

  const merchant = store.getMerchantById(req.query.merchantId || 'merch_default');
  const watcher = merchant && watcherManager.getOrCreate(merchant);
  if (!watcher) return res.status(500).json({ error: 'Watcher not available' });

  console.log(`[SMS-TEST] Fake credit ₹${payment.amount} UTR ${utr}`);
  await watcher.handleIncomingPayment(payment);

  const matched = store.getOrdersByMerchant(merchant.id)
    .find(o => o.status === 'PAID' && o.paymentDetails && o.paymentDetails.utr === utr);

  return res.json({
    success: true,
    fakeSms: smsText,
    matchedOrder: matched ? matched.orderId : null,
    result: matched
      ? `Order ${matched.orderId} auto-verified as PAID`
      : `No PENDING order of exactly ₹${amount.toFixed(2)} created in the last 20 minutes`
  });
});

// Simulation endpoint to test concurrent payments
app.post('/api/v1/simulate-payment', (req, res) => {
  // SECURITY: test-only endpoint. Anyone could otherwise mark orders PAID.
  if (process.env.ENABLE_SIMULATION !== 'true') {
    return res.status(403).json({ error: 'Simulation disabled. Set ENABLE_SIMULATION=true only for local testing.' });
  }
  const { merchantId = 'merch_default', amount = 5, payerName = 'Concurrent Tester', utr } = req.body;
  const merchant = store.getMerchantById(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  const watcher = watcherManager.getOrCreate(merchant);
  const simulatedPayment = {
    uid: Math.floor(10000 + Math.random() * 90000),
    amount: parseFloat(amount),
    senderName: payerName,
    utr: utr || Math.floor(100000000000 + Math.random() * 900000000000).toString(),
    txnId: `FMPIB${Math.floor(1000000000 + Math.random() * 9000000000)}`,
    date: new Date(),
    rawSubject: `You received ₹${amount} in your FamX account`,
    snippet: `Hey SidTech 366, You have successfully received ₹${amount} from ${payerName}. UTR: ${utr || '123'}.`,
    source: 'Simulation Engine'
  };

  watcher.handleIncomingPayment(simulatedPayment);

  res.json({
    success: true,
    simulatedPayment
  });
});

// ==============================================================
// 5. HOSTED PAYWALL ROUTE
// ==============================================================

app.get(['/pay/:orderId', '/checkout/:orderId', '/test/:orderId', '/test'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paywall.html'));
});

// Fallback to Main Dashboard / Landing SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 SidPay Platform running at: http://localhost:${PORT}`);
  console.log(`💼 Active Merchant: ${defaultMerchant ? defaultMerchant.businessName : 'N/A'}`);
  console.log(`📧 Monitoring Email: ${defaultMerchant ? defaultMerchant.gmailUser : 'N/A'}`);
  console.log(`====================================================`);
});
