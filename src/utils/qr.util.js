/**
 * UPI Intent URI & QR Code Utility
 * Strict NPCI-compliant URI formatting for universal Indian UPI apps
 */

const QRCode = require('qrcode');

/**
 * Constructs an NPCI-compliant UPI Intent URI
 * 
 * @param {Object} params
 * @param {string} params.upiVpa - Payee UPI ID (e.g. yourname@upi). The '@' symbol MUST remain raw!
 * @param {string} params.merchantName - Payee Business / Merchant Name
 * @param {number|string} params.amount - Transaction Amount
 * @param {string} params.orderCode - Unique Order Identifier (e.g. ORD-XXXXXX or PAY-XXXXXX)
 * @param {string} [params.note] - Optional custom note
 * @returns {string} Standard UPI Intent URI
 */
function buildUpiUri({ upiVpa, merchantName, amount, orderCode, note }) {
  // 1. Payee VPA / UPI ID: Crucial - do NOT percent-encode '@' into '%40'!
  const cleanVpa = (upiVpa || '').trim();

  // 2. Payee Merchant Name: Format and sanitize (& replaced with and, stripped of disallowed chars)
  const sanitizedName = (merchantName || 'SidTech 366')
    .replace(/&/g, 'and')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim();
  const cleanName = encodeURIComponent(sanitizedName);

  // 3. Transaction Amount: Fixed to 2 decimal places
  const cleanAmount = Number(amount || 1.00).toFixed(2);

  // 4. Transaction Reference: Unique order code
  const txnRef = encodeURIComponent(orderCode || `ORD-${Date.now()}`);

  // 5. Transaction Note: Description shown in UPI client
  const rawNote = note || `Pay ${orderCode || 'Order'}`;
  const cleanNote = encodeURIComponent(rawNote.replace(/[^a-zA-Z0-9 \-]/g, '').trim().slice(0, 24));

  // Construct NPCI URI: mode=00 is mandatory for Paytm and strict bank validation
  return `upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&tr=${txnRef}&tn=${cleanNote}&cu=INR&mode=00`;
}

/**
 * Generates both the UPI Intent URI and high-contrast Data URL QR code
 */
async function generateDynamicQrDataUrl(params) {
  const upiUri = buildUpiUri(params);

  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: 'H',
    margin: 2,
    scale: 8,
    color: {
      dark: '#0A0D14',
      light: '#FFFFFF'
    }
  });

  return { upiUri, qrDataUrl };
}

module.exports = {
  buildUpiUri,
  generateDynamicQrDataUrl
};
