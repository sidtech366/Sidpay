require('dotenv').config();
const mongoose = require('mongoose');

const MerchantSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: 'Merchant' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, default: 'password123' },
  businessName: { type: String, default: 'Store' },
  upiId: { type: String, default: '' },
  qrImagePath: { type: String, default: '/uploads/default-qr.jpeg' },
  gmailUser: { type: String, default: '' },
  gmailAppPass: { type: String, default: '' },
  apiKey: { type: String, required: true, unique: true, index: true },
  isOnboarded: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  merchantId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  customerName: { type: String, default: 'Customer' },
  customerEmail: { type: String, default: '' },
  note: { type: String, default: '' },
  status: { type: String, enum: ['PENDING', 'PAID', 'SUCCESS', 'FAILED'], default: 'PENDING', index: true },
  dynamicUpiUrl: { type: String, default: '' },
  dynamicQrDataUrl: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  verifiedAt: { type: Date, default: null },
  paymentDetails: {
    amount: Number,
    sender: String,
    utr: String,
    txnId: String,
    rawText: String,
    timestamp: Date,
    senderName: String,
    source: String,
    date: Date
  },
  // Customer "I have paid" request, reviewed manually by the merchant
  claim: {
    utr: String,
    payerName: String,
    submittedAt: Date,
    status: { type: String, enum: ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] },
    reviewedAt: Date,
    note: String
  }
}, { timestamps: true });

const MerchantModel = mongoose.model('Merchant', MerchantSchema);
const OrderModel = mongoose.model('Order', OrderSchema);

let isConnected = false;

async function connectMongo(uri) {
  const mongoUri = uri || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn('[MongoDB] No MONGODB_URI provided in environment.');
    return false;
  }

  try {
    if (mongoose.connection.readyState === 1) {
      isConnected = true;
      return true;
    }

    console.log('[MongoDB] Connecting to MongoDB Atlas...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 8000,
      autoIndex: true
    });
    isConnected = true;
    console.log('[MongoDB] Connected successfully to MongoDB Atlas (sidpay).');
    return true;
  } catch (err) {
    console.error('[MongoDB] Connection error:', err.message);
    isConnected = false;
    return false;
  }
}

module.exports = {
  MerchantModel,
  OrderModel,
  connectMongo,
  getIsConnected: () => isConnected
};
