/**
 * SidPay - Bank SMS parser (Bank of Baroda, Jio Payments Bank, others)
 *
 * Credit SMS are forwarded from the merchant's Android phone by an
 * SMS-forwarder app to POST /api/v1/sms-webhook.
 *
 * Only real UPI credits are accepted. Debit SMS ("Rs.500.00 Dr. from A/C ...
 * and Cr. to xyz@oksbi") and reversal/refund credits are ignored.
 */

// Default trusted DLT sender headers (prefix like "JK-"/"JX-" and suffix
// like "-S"/"-T" are stripped before comparing). Add more with SMS_ALLOWED_SENDERS.
const DEFAULT_SENDERS = ['BOBSMS', 'BOBTXN', 'BOBUPI'];

function getAllowedSmsSenders() {
  const extra = (process.env.SMS_ALLOWED_SENDERS || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  return extra.length ? extra : DEFAULT_SENDERS;
}

/** "JK-BOBSMS-S" -> "BOBSMS", "VM-JIOPBS" -> "JIOPBS" */
function normalizeSender(sender) {
  let s = String(sender || '').trim().toUpperCase();
  s = s.replace(/^[A-Z]{2}-/, '');        // operator/circle prefix
  s = s.replace(/-[SPTG]$/, '');          // DLT category suffix
  return s;
}

function isTrustedSmsSender(sender) {
  const norm = normalizeSender(sender);
  if (!norm) return false;
  // Plain phone numbers are never trusted: real bank SMS come from headers.
  if (/^\+?\d+$/.test(norm)) return false;
  return getAllowedSmsSenders().includes(norm);
}

function cleanAmount(raw) {
  const val = parseFloat(String(raw || '').replace(/,/g, ''));
  return isNaN(val) ? 0 : val;
}

function parseBankSms(sender, body, receivedAt) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // Must be a credit to OUR account
  const isCredit = /\bcredited\b/i.test(text) || /\bCr\.?\s+(?:to|in)\s+(?:your\s+)?a\/?c/i.test(text);
  if (!isCredit) return null;

  // Debits ("Dr. from A/C ... Cr. to vpa"), reversals and refunds are not customer payments
  if (/\bDr\.?\s+from\b/i.test(text) || /\bdebited\b/i.test(text)) return null;
  if (/revers|refund|chargeback|returned/i.test(text)) return null;

  // Optional: only accept SMS that mention our account's last digits
  const last4 = (process.env.SMS_ACCOUNT_LAST4 || '').trim();
  if (last4 && !text.includes(last4)) return null;

  // Amount: first "INR 500.00" / "Rs.500.00" / "₹500"
  const amtMatch = text.match(/(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amtMatch ? cleanAmount(amtMatch[1]) : 0;
  if (!(amount > 0)) return null;

  // UTR / UPI Ref No (12 digits)
  const utrMatch =
    text.match(/(?:UPI\s*Ref(?:erence)?(?:\s*No\.?)?|Ref(?:\s*No\.?)?|RRN|UTR)\s*[:.#-]?\s*(\d{12})/i) ||
    text.match(/\b(\d{12})\b/);
  const utr = utrMatch ? utrMatch[1] : null;
  if (!utr) return null; // without a reference we cannot de-duplicate safely

  // Payer VPA / name if present ("by abc@ybl", "from abc@ybl")
  const fromMatch = text.match(/(?:by|from)\s+(?:VPA\s+)?([a-z0-9.\-_]+@[a-z]+)/i);

  let date = new Date();
  if (receivedAt) {
    const n = Number(receivedAt);
    const d = isNaN(n) ? new Date(receivedAt) : new Date(n);
    if (!isNaN(d.getTime())) date = d;
  }

  return {
    uid: `SMS_${utr}`,
    amount,
    senderName: fromMatch ? fromMatch[1] : 'UPI Customer',
    utr,
    txnId: `TXN-${utr}`,
    date,
    rawSubject: `SMS from ${normalizeSender(sender)}`,
    snippet: text.substring(0, 200),
    source: 'Bank SMS'
  };
}

module.exports = {
  parseBankSms,
  isTrustedSmsSender,
  normalizeSender
};
