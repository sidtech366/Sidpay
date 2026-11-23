/**
 * Parser for payment notification emails (FamApp, FamPay, UPI apps, and Indian Banks)
 */

function cleanAmount(raw) {
  if (typeof raw === 'number') return raw;
  if (!raw) return 0;
  const cleaned = raw.toString().replace(/,/g, '').trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}


/**
 * SECURITY: Only trust bank alert emails that
 *  1) come from an address/domain listed in ALLOWED_SENDERS (comma separated,
 *     e.g. "alerts@hdfcbank.net,sbi.co.in"), and
 *  2) passed Gmail's own DMARC/DKIM check (topmost Authentication-Results
 *     header added by mx.google.com).
 * Without this, anyone could email your Gmail "You received Rs 500.01" and
 * get an order marked PAID.
 */
let warnedNoAllowlist = false;
function getAllowedSenders() {
  return (process.env.ALLOWED_SENDERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isTrustedSender(parsed) {
  const allowed = getAllowedSenders();
  if (allowed.length === 0) {
    if (!warnedNoAllowlist) {
      console.warn('[SidPay Security] ALLOWED_SENDERS is not set in .env - ignoring ALL payment emails. Add your bank alert email/domain.');
      warnedNoAllowlist = true;
    }
    return false;
  }

  const fromAddr = (parsed && parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address || '').toLowerCase();
  if (!fromAddr.includes('@')) return false;
  const fromDomain = fromAddr.split('@')[1];

  const listed = allowed.some(a => a.includes('@')
    ? a === fromAddr
    : (fromDomain === a || fromDomain.endsWith('.' + a)));
  if (!listed) return false;

  // Topmost Authentication-Results header is the one Gmail itself added.
  const lines = (parsed.headerLines || []).filter(h => h.key === 'authentication-results');
  if (lines.length === 0) return false;
  const auth = lines[0].line.toLowerCase();
  if (!auth.includes('mx.google.com')) return false;

  const dmarcOk = /dmarc=pass/.test(auth) && auth.includes('header.from=' + fromDomain);
  const dkimMatch = auth.match(/dkim=pass[^;]*header\.(?:i=@?|d=)([a-z0-9.\-]+)/);
  const dkimOk = !!dkimMatch && (fromDomain === dkimMatch[1] || fromDomain.endsWith('.' + dkimMatch[1]));
  return dmarcOk || dkimOk;
}

function parsePaymentEmail(subject, text, html, date, uid) {
  const combined = `${subject || ''}\n${text || ''}\n${html ? html.replace(/<[^>]+>/g, ' ') : ''}`;

  // Check if subject or text indicates received payment / credit
  const receivedKeywords = /(received|credited|deposit|transferred to you|payment of|credit alert)/i;
  if (!receivedKeywords.test(combined)) {
    return null;
  }

  // Reject debit alerts (e.g., "debited", "paid to", "sent to")
  const debitKeywords = /(debited from|you paid|you sent money|spent on|debited by)/i;
  // If debited is mentioned and "received" is NOT the primary action
  if (debitKeywords.test(combined) && !/(successfully received|received ₹|received rs|credited)/i.test(combined)) {
    return null;
  }

  const result = {
    uid: uid || null,
    amount: null,
    senderName: null,
    utr: null,
    txnId: null,
    date: date ? new Date(date) : new Date(),
    rawSubject: subject || '',
    snippet: (text || '').substring(0, 200).replace(/\s+/g, ' ').trim(),
    source: 'Email Notification'
  };

  // 1. Extract Amount
  // Matches: ₹5.0, ₹500, Rs. 100, Rs 50, INR 250, received ₹5.0, etc.
  const amountPatterns = [
    /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /received\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /credited\s*(?:with|by)?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /amount\s*(?:of)?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i
  ];

  for (const pat of amountPatterns) {
    const match = combined.match(pat);
    if (match && match[1]) {
      const parsedAmt = cleanAmount(match[1]);
      if (parsedAmt > 0) {
        result.amount = parsedAmt;
        break;
      }
    }
  }

  // 2. Extract Sender / Payer Name
  // Matches: "from MONU KUMAR at", "from [Name] on", "by [Name]"
  const senderPatterns = [
    /from\s+([A-Za-z0-9\s\.\-_]+?)\s+(?:at|on|with|using|towards|via)/i,
    /from\s+([A-Za-z0-9\s]{3,35})(?:\.|\n|\r)/i,
    /by\s+([A-Za-z0-9\s]{3,35})\s+via/i
  ];

  for (const pat of senderPatterns) {
    const match = combined.match(pat);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Avoid false matches like "your bank" or "FamApp"
      if (!/account|bank|famapp|fampay|upi|balance/i.test(candidate)) {
        result.senderName = candidate;
        break;
      }
    }
  }

  // 3. Extract UTR / Reference ID (Must be alphanumeric with at least some digits, 6-22 chars)
  const utrPatterns = [
    /UTR[:\s#]+([0-9a-zA-Z]{6,22})/i,
    /(?:UPI\s*Ref|RRN|Ref(?:erence)?\s*(?:no|id)?)[:\s#]+([0-9a-zA-Z]{6,22})/i,
    /\b(\d{12})\b/ // Standard 12-digit UPI UTR
  ];

  for (const pat of utrPatterns) {
    const match = combined.match(pat);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Avoid matching words like "number", "id", "reference"
      if (!/^(number|reference|payment|status|details)$/i.test(candidate) && /\d/.test(candidate)) {
        result.utr = candidate;
        break;
      }
    }
  }

  // 4. Extract FamApp / Bank Transaction ID
  // transaction id FMPIB6860597531 or Txn ID: ...
  const txnPatterns = [
    /transaction\s*id\s*[:\s#]*([0-9a-zA-Z]{6,30})/i,
    /txn\s*id\s*[:\s#]*([0-9a-zA-Z]{6,30})/i,
    /trans\s*id\s*[:\s#]*([0-9a-zA-Z]{6,30})/i
  ];

  for (const pat of txnPatterns) {
    const match = combined.match(pat);
    if (match && match[1]) {
      result.txnId = match[1].trim();
      break;
    }
  }

  // Fallback defaults if not found
  if (!result.senderName) result.senderName = 'UPI Customer';
  if (!result.txnId && result.utr) result.txnId = `TXN-${result.utr}`;
  if (!result.utr && result.txnId) result.utr = result.txnId;

  return result.amount ? result : null;
}

module.exports = {
  parsePaymentEmail,
  isTrustedSender,
  cleanAmount
};
