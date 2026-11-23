const mongoose = require('mongoose');
const QRCode = require('qrcode');

const MONGODB_URI = (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('<username>'))
  ? process.env.MONGODB_URI 
  : '';

// Mongoose Models
let MerchantModel, OrderModel;
try {
  MerchantModel = mongoose.model('Merchant');
  OrderModel = mongoose.model('Order');
} catch (e) {
  const MerchantSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: String,
    email: { type: String, required: true, lowercase: true },
    password: String,
    businessName: String,
    upiId: String,
    qrImagePath: String,
    gmailUser: String,
    gmailAppPass: String,
    apiKey: { type: String, required: true, unique: true },
    isOnboarded: Boolean,
    createdAt: Date
  }, { timestamps: true });

  const OrderSchema = new mongoose.Schema({
    orderId: { type: String, required: true, unique: true },
    merchantId: { type: String, required: true },
    amount: Number,
    customerName: String,
    customerEmail: String,
    note: String,
    status: { type: String, default: 'PENDING' },
    dynamicUpiUrl: String,
    dynamicQrDataUrl: String,
    createdAt: Date,
    verifiedAt: Date,
    paymentDetails: Object
  }, { timestamps: true });

  MerchantModel = mongoose.model('Merchant', MerchantSchema);
  OrderModel = mongoose.model('Order', OrderSchema);
}

let isMongoConnected = false;
async function initMongo() {
  if (isMongoConnected && mongoose.connection.readyState === 1) return;
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true
  });
  isMongoConnected = true;
}

module.exports = async ({ req, res, log, error }) => {
  try {
    await initMongo();
  } catch (err) {
    error('MongoDB Connection Error: ' + err.message);
    return res.json({ error: 'Database connection error', details: err.message }, 500);
  }

  const path = req.path || '/';
  const method = req.method || 'GET';
  const headers = req.headers || {};
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    body = {};
  }

  log(`[Appwrite Function] ${method} ${path}`);

  // CORS & Strict No-Cache headers to prevent edge/proxy/browser stale hits
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-merchant-id',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  };

  if (method === 'OPTIONS') {
    return res.text('', 204, corsHeaders);
  }

  // Health
  if (path === '/' || path === '/health') {
    return res.json({
      status: 'online',
      service: 'SidPay Gateway on Appwrite Functions',
      database: 'MongoDB Atlas (Connected)',
      timestamp: new Date().toISOString()
    }, 200, corsHeaders);
  }

  // Create Checkout Order (Dynamic for user or via API Key)
  if (path.includes('/api/v1/checkout/create') && (method === 'POST' || method === 'GET')) {
    const apiKey = headers['x-api-key'] || (headers['authorization'] && headers['authorization'].replace('Bearer ', ''));
    let merchant = null;
    if (apiKey) {
      merchant = await MerchantModel.findOne({ apiKey });
    }
    if (!merchant) {
      merchant = await MerchantModel.findOne({ id: 'merch_default' }) || await MerchantModel.findOne({});
    }
    if (!merchant) {
      return res.json({ error: 'Merchant not configured' }, 404, corsHeaders);
    }

    const { amount, customerName, customerEmail, note } = body;
    const baseAmount = parseFloat(amount || (req.query && req.query.amount) || 199.00);
    const numAmount = isNaN(baseAmount) || baseAmount <= 0 ? 199.00 : baseAmount;

    // Concurrency Slot Allocation: Check active PENDING orders in the last 15 mins
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const activePending = await OrderModel.find({
      merchantId: merchant.id,
      status: 'PENDING',
      createdAt: { $gte: fifteenMinsAgo }
    }).select('amount').lean();

    const usedAmounts = new Set(activePending.map(o => (o.amount || 0).toFixed(2)));
    let finalAmount = numAmount;
    let offset = 0;
    while (usedAmounts.has(finalAmount.toFixed(2)) && offset < 50) {
      offset++;
      finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
    }

    const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const safeNote = (note || `Pay ${orderId}`).replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 24);
    const cleanVpa = (merchant.upiId || '').trim();
    const safeName = (merchant.businessName || 'SidTech 366').replace(/&/g, 'and').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const cleanName = encodeURIComponent(safeName);
    const cleanAmount = Number(finalAmount).toFixed(2);
    const txnRef = encodeURIComponent(orderId);
    const cleanNote = encodeURIComponent(safeNote);
    
    // Strict NPCI UPI Intent URI: keeping '@' raw in pa, adding mode=00
    const upiUri = `upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&tr=${txnRef}&tn=${cleanNote}&cu=INR&mode=00`;

    const qrDataUrl = await QRCode.toDataURL(upiUri, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 400,
      color: { dark: '#0A0D14', light: '#FFFFFF' }
    });

    const newOrder = await OrderModel.create({
      orderId,
      merchantId: merchant.id,
      amount: finalAmount,
      customerName: customerName || 'Customer',
      customerEmail: customerEmail || '',
      note: safeNote,
      status: 'PENDING',
      dynamicUpiUrl: upiUri,
      dynamicQrDataUrl: qrDataUrl,
      createdAt: new Date(),
      verifiedAt: null,
      paymentDetails: null
    });

    return res.json({
      success: true,
      orderId: newOrder.orderId,
      orderCode: newOrder.orderId,
      amount: newOrder.amount,
      currency: 'INR',
      status: 'PENDING',
      paywallUrl: `/pay/${newOrder.orderId}`,
      dynamicUpiUrl: newOrder.dynamicUpiUrl,
      upiUri: newOrder.dynamicUpiUrl,
      dynamicQrDataUrl: newOrder.dynamicQrDataUrl
    }, 201, corsHeaders);
  }

  // Create Paywall Link for Merchant Dashboard or Demo
  if ((path.includes('/api/merchant/create-paywall-link') || path.includes('/api/v1/checkout/create-paywall-link')) && method === 'POST') {
    const merchantId = headers['x-merchant-id'] || 'merch_default';
    const merchant = await MerchantModel.findOne({ id: merchantId }) || await MerchantModel.findOne({});
    if (!merchant) {
      return res.json({ error: 'Merchant not found' }, 404, corsHeaders);
    }

    const { amount, customerName, customerEmail, note } = body;
    const baseAmount = parseFloat(amount || 1.00);
    const numAmount = isNaN(baseAmount) || baseAmount <= 0 ? 1.00 : baseAmount;

    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const activePending = await OrderModel.find({
      merchantId: merchant.id,
      status: 'PENDING',
      createdAt: { $gte: fifteenMinsAgo }
    }).select('amount').lean();

    const usedAmounts = new Set(activePending.map(o => (o.amount || 0).toFixed(2)));
    let finalAmount = numAmount;
    let offset = 0;
    while (usedAmounts.has(finalAmount.toFixed(2)) && offset < 50) {
      offset++;
      finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
    }

    const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const safeNote = (note || `Pay ${orderId}`).replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 24);
    const cleanVpa = (merchant.upiId || '').trim();
    const safeName = (merchant.businessName || 'SidTech 366').replace(/&/g, 'and').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const cleanName = encodeURIComponent(safeName);
    const cleanAmount = Number(finalAmount).toFixed(2);
    const txnRef = encodeURIComponent(orderId);
    const cleanNote = encodeURIComponent(safeNote);
    
    // Strict NPCI UPI Intent URI: keeping '@' raw in pa, adding mode=00
    const upiUri = `upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&tr=${txnRef}&tn=${cleanNote}&cu=INR&mode=00`;

    const qrDataUrl = await QRCode.toDataURL(upiUri, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 400,
      color: { dark: '#0A0D14', light: '#FFFFFF' }
    });

    const newOrder = await OrderModel.create({
      orderId,
      merchantId: merchant.id,
      amount: finalAmount,
      customerName: customerName || 'Customer',
      customerEmail: customerEmail || '',
      note: safeNote,
      status: 'PENDING',
      dynamicUpiUrl: upiUri,
      dynamicQrDataUrl: qrDataUrl,
      createdAt: new Date(),
      verifiedAt: null,
      paymentDetails: null
    });

    return res.json({
      success: true,
      order: newOrder,
      orderId: newOrder.orderId,
      amount: newOrder.amount,
      currency: 'INR',
      paywallUrl: `/pay/${newOrder.orderId}`,
      dynamicUpiUrl: newOrder.dynamicUpiUrl,
      dynamicQrDataUrl: newOrder.dynamicQrDataUrl
    }, 201, corsHeaders);
  }

  // Manual UTR Verification
  if (path.includes('/api/v1/checkout/verify-utr') && method === 'POST') {
    const { orderId, utr } = body;
    if (!orderId || !utr) {
      return res.json({ error: 'Order ID and UTR required' }, 400, corsHeaders);
    }

    const order = await OrderModel.findOne({ orderId });
    if (!order) {
      return res.json({ error: 'Order not found' }, 404, corsHeaders);
    }

    if (order.status === 'PAID') {
      return res.json({
        success: true,
        verified: true,
        order
      }, 200, corsHeaders);
    }

    const cleanUtr = utr.toString().trim();
    const existingWithUtr = await OrderModel.findOne({
      $or: [
        { 'paymentDetails.utr': cleanUtr },
        { 'paymentDetails.txnId': cleanUtr }
      ]
    });

    if (existingWithUtr && Math.abs(existingWithUtr.amount - order.amount) < 0.01) {
      order.status = 'PAID';
      order.verifiedAt = new Date();
      order.paymentDetails = existingWithUtr.paymentDetails;
      await order.save();

      return res.json({
        success: true,
        verified: true,
        order
      }, 200, corsHeaders);
    }

    return res.json({
      success: false,
      verified: false,
      message: 'UTR not yet confirmed by bank notification. Please wait a moment.'
    }, 200, corsHeaders);
  }

  // Checkout Status check
  if (path.includes('/api/v1/checkout/status/') && method === 'GET') {
    const parts = path.split('/');
    const orderId = parts[parts.length - 1];
    const order = await OrderModel.findOne({ orderId });
    if (!order) {
      return res.json({ error: 'Order not found' }, 404, corsHeaders);
    }
    const merchant = await MerchantModel.findOne({ id: order.merchantId });
    return res.json({
      success: true,
      verified: order.status === 'PAID',
      order,
      merchant: {
        businessName: merchant ? merchant.businessName : 'Apex Cloud & Payments',
        upiId: merchant ? merchant.upiId : '',
        qrImagePath: merchant ? merchant.qrImagePath : '/uploads/default-qr.jpeg'
      }
    }, 200, corsHeaders);
  }

  // Secure Digital File Delivery Route - Requires Verified Payment
  if (path.includes('/api/v1/checkout/delivery/') && method === 'GET') {
    const parts = path.split('/');
    const orderId = parts[parts.length - 1].split('?')[0];
    const order = await OrderModel.findOne({ orderId });
    if (!order) {
      return res.json({ error: 'Order not found' }, 404, corsHeaders);
    }

    if (order.status !== 'PAID') {
      return res.json({ 
        error: 'Access Denied', 
        message: 'Payment has not been completed or verified yet. Please complete payment first.' 
      }, 403, corsHeaders);
    }

    // Google Drive URLs kept strictly on server
    const DRIVE_VIEW_URL = (process.env.DELIVERY_VIEW_URL || 'https://sidtech366.vercel.app');
    const DRIVE_DOWNLOAD_URL = (process.env.DELIVERY_DOWNLOAD_URL || process.env.DELIVERY_VIEW_URL || 'https://sidtech366.vercel.app');
    const targetUrl = (req.query && req.query.download === '1') ? DRIVE_DOWNLOAD_URL : DRIVE_VIEW_URL;

    const acceptHeader = (headers['accept'] || '').toLowerCase();
    if (acceptHeader.includes('application/json') || (req.query && req.query.format === 'json')) {
      return res.json({
        success: true,
        verified: true,
        deliveryUrl: DRIVE_VIEW_URL,
        downloadUrl: DRIVE_DOWNLOAD_URL
      }, 200, corsHeaders);
    }

    return res.text('', 302, {
      ...corsHeaders,
      'Location': targetUrl,
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
  }

  // Get Public Checkout Details for Paywall (/api/v1/checkout/:orderId)
  if (path.includes('/api/v1/checkout/') && method === 'GET') {
    const parts = path.split('/');
    const orderId = parts[parts.length - 1];
    const order = await OrderModel.findOne({ orderId });
    if (!order) {
      return res.json({ error: 'Order not found' }, 404, corsHeaders);
    }
    const merchant = await MerchantModel.findOne({ id: order.merchantId });
    return res.json({
      success: true,
      order: {
        orderId: order.orderId,
        orderCode: order.orderId,
        amount: order.amount,
        customerName: order.customerName,
        note: order.note,
        status: order.status,
        upiUri: order.dynamicUpiUrl,
        dynamicUpiUrl: order.dynamicUpiUrl,
        dynamicQrDataUrl: order.dynamicQrDataUrl,
        verifiedAt: order.verifiedAt,
        paymentDetails: order.paymentDetails
      },
      merchant: {
        businessName: merchant ? merchant.businessName : 'Apex Cloud & Payments',
        upiId: merchant ? merchant.upiId : '',
        qrImagePath: merchant ? merchant.qrImagePath : '/uploads/default-qr.jpeg'
      }
    }, 200, corsHeaders);
  }

  // Generic Order Status
  if (path.startsWith('/api/orders/') && method === 'GET') {
    const parts = path.split('/');
    const orderId = parts[parts.length - 1];
    const order = await OrderModel.findOne({ orderId });
    if (!order) {
      return res.json({ error: 'Order not found' }, 404, corsHeaders);
    }
    return res.json({ success: true, order }, 200, corsHeaders);
  }

  // Merchant Profile & Dashboard
  if ((path.includes('/api/merchant/profile') || path.includes('/api/merchant/dashboard')) && method === 'GET') {
    const merchantId = headers['x-merchant-id'] || req.query.merchantId || 'merch_default';
    const merchant = await MerchantModel.findOne({ id: merchantId });
    if (!merchant) {
      return res.json({ error: 'Merchant not found' }, 404, corsHeaders);
    }
    const orders = await OrderModel.find({ merchantId }).sort({ createdAt: -1 }).limit(10);
    const totalOrders = await OrderModel.countDocuments({ merchantId });
    const paidOrders = await OrderModel.find({ merchantId, status: 'PAID' });
    const totalVolume = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

    return res.json({
      success: true,
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        businessName: merchant.businessName,
        upiId: merchant.upiId,
        apiKey: merchant.apiKey,
        qrImagePath: merchant.qrImagePath || '/uploads/default-qr.jpeg',
        isOnboarded: merchant.isOnboarded
      },
      metrics: {
        totalVolume,
        paidCount: paidOrders.length,
        pendingCount: totalOrders - paidOrders.length,
        totalOrders,
        avgSpeed: '1.4s'
      },
      recentOrders: orders
    }, 200, corsHeaders);
  }

  return res.json({ error: 'Route not found: ' + path }, 404, corsHeaders);
};
