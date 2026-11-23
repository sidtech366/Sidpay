const QRCode = require('qrcode');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');

/**
 * Generate a dynamic UPI payment URI
 */
function buildUpiUri({ upiId, payeeName, amount, note, orderId }) {
  // 1. Payee VPA / UPI ID: Crucial - do NOT percent-encode '@' into '%40'!
  const cleanVpa = (upiId || '').trim();

  // 2. Payee Merchant Name: Format and sanitize
  const safeName = (payeeName || 'SidTech 366').replace(/&/g, 'and').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const cleanName = encodeURIComponent(safeName);

  // 3. Amount: Fixed to 2 decimal places
  const cleanAmount = Number(amount || 1.00).toFixed(2);

  // 4. Transaction Reference & Note
  const orderCode = orderId || `PAY-${Date.now().toString().slice(-6)}`;
  const txnRef = encodeURIComponent(orderCode);
  const cleanNote = encodeURIComponent(note || `Pay ${orderCode}`);

  // Standard NPCI UPI URI: mode=00 is required by strict UPI clients like Paytm
  return `upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&tr=${txnRef}&tn=${cleanNote}&cu=INR&mode=00`;
}

/**
 * Generate dynamic QR Data URL with exact amount pre-configured
 */
async function generateDynamicQrDataUrl({ upiId, payeeName, amount, note, orderId }) {
  const upiUri = buildUpiUri({ upiId, payeeName, amount, note, orderId });
  
  // High quality QR generation with white border
  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: 'H',
    margin: 2,
    scale: 8,
    color: {
      dark: '#0F172A',
      light: '#FFFFFF'
    }
  });

  return { upiUri, qrDataUrl };
}

/**
 * Inspect & decode an uploaded FamPay / UPI QR image
 */
async function decodeQrImage(filePath) {
  try {
    const image = await Jimp.read(filePath);
    const code = jsQR(
      new Uint8ClampedArray(image.bitmap.data),
      image.bitmap.width,
      image.bitmap.height
    );

    if (code && code.data) {
      const raw = code.data;
      // Extract pa= (UPI ID)
      const paMatch = raw.match(/pa=([a-zA-Z0-9.\-_@]+)/i);
      const pnMatch = raw.match(/pn=([a-zA-Z0-9%.\-_]+)/i);

      let upiId = paMatch ? paMatch[1] : null;
      let payeeName = pnMatch ? decodeURIComponent(pnMatch[1]) : null;

      // If raw data is directly an email-like UPI address (e.g. yourname@upi)
      if (!upiId && raw.includes('@')) {
        const directMatch = raw.match(/([a-zA-Z0-9.\-_]+@[a-zA-Z0-9]+)/);
        if (directMatch) upiId = directMatch[1];
      }

      return {
        success: true,
        raw,
        upiId: upiId || '',
        payeeName: payeeName || 'FamPay Merchant'
      };
    }

    return {
      success: false,
      error: 'QR code could not be detected. Please ensure image is clear and contains a UPI QR.'
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  buildUpiUri,
  generateDynamicQrDataUrl,
  decodeQrImage
};
