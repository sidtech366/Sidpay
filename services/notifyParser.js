/**
 * SidPay - PhonePe Business notification parser
 *
 * Example notification (title / text):
 *   "Received Rs 1"
 *   "You've received Rs 1 from Vikas Mishra via PhonePe for txn T2611231748352273180695."
 *
 * Forwarded from the merchant's Android phone by MacroDroid
 * (Notification Received trigger -> HTTP Request action) to
 * /api/v1/notify-webhook.
 */

function getAllowedApps() {
  return (process.env.NOTIFY_ALLOWED_APPS || 'PhonePe Business,com.phonepe.app.business')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isTrustedApp(app) {
  const a = String(app || '').trim().toLowerCase();
  if (!a) return false;
  return getAllowedApps().includes(a);
}

// Android notifications often contain invisible characters (zero-width
// spaces, direction marks around names). Remove them before matching.
function cleanText(t) {
  return String(t || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g, '')
    .replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function parsePhonePeNotification(title, text, receivedAt) {
  const combined = cleanText(`${title || ''} ${text || ''}`);
  if (!combined) return null;

  // Only money RECEIVED. Ignore "sent", "paid", refunds, settlements, offers.
  if (!/\breceived\b/i.test(combined)) return null;
  if (/\b(sent|paid to|debited|refund|reversed|settle|cashback|reward)\b/i.test(combined)) return null;

  const m = combined.match(/received\s+(?:Rs\.?|₹|INR)\s*([\d,]+(?:\.\d{1,2})?)\s+from\s+(.+?)\s+(?:via|on|using)\s+PhonePe/i);
  if (!m) return null;

  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (!(amount > 0)) return null;

  // PhonePe transaction id, e.g. T2611231748352273180695
  const txnMatch = combined.match(/\btxn\s*(?:id)?\s*[:#]?\s*([A-Z0-9]{10,40})/i);
  if (!txnMatch) return null; // needed to avoid counting the same payment twice
  const txnId = txnMatch[1].toUpperCase();

  let date = new Date();
  if (receivedAt) {
    const n = Number(receivedAt);
    const d = isNaN(n) ? new Date(receivedAt) : new Date(n < 1e12 ? n * 1000 : n);
    if (!isNaN(d.getTime()) && Math.abs(Date.now() - d.getTime()) < 24 * 3600 * 1000) date = d;
  }

  return {
    uid: `PPB_${txnId}`,
    amount,
    senderName: m[2].trim().slice(0, 60),
    utr: txnId,
    txnId,
    date,
    rawSubject: String(title || '').slice(0, 80),
    snippet: combined.slice(0, 200),
    source: 'PhonePe Business notification'
  };
}

module.exports = { parsePhonePeNotification, isTrustedApp, cleanText };
