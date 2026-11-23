/**
 * Mobile Deep-Link Handling (public/js/checkout.js)
 * 
 * On the checkout screen (/checkout/:orderCode or /pay/:orderCode), strips upi://pay? 
 * and constructs dedicated deep-links for each major UPI app:
 * - Direct / Universal UPI Intent & FamPay
 * - Google Pay (tez:// scheme)
 * - PhonePe (phonepe:// scheme)
 * - Paytm (Android Intent package targeting / iOS paytmmp:// fallback)
 * - Navi (Android Intent scheme targeting com.naviapp)
 * - super.money (Android Intent scheme targeting money.super.payments)
 */

function setupUpiIntentLinks(order) {
  if (!order) return;

  const rawUri = order.upiUri || order.dynamicUpiUrl || '';
  if (!rawUri) return;

  // Strip 'upi://pay?' prefix to extract the raw query parameters
  const upiParams = rawUri.replace(/^upi:\/\/pay\??/, '');
  const isAndroid = /Android/i.test(navigator.userAgent || '');

  // 1. Universal / Direct UPI Intent & FamPay
  const btnPayDirect = document.getElementById('btnPayDirect');
  const btnFamPay = document.getElementById('btnFamPay');
  if (btnPayDirect) {
    btnPayDirect.href = rawUri;
  }
  if (btnFamPay) {
    btnFamPay.href = rawUri;
  }

  // 2. Google Pay: Uses Google Pay's registered Tez scheme
  const btnGPay = document.getElementById('btnGPay');
  if (btnGPay) {
    btnGPay.href = `tez://upi/pay?${upiParams}`;
  }

  // 3. PhonePe: Pure Direct Deep Link (phonepe://) with clean P2P prefilled params (no intent wrapper, no mode/tr)
  const btnPhonePe = document.getElementById('btnPhonePe');
  if (btnPhonePe) {
    const vpaMatch = rawUri.match(/pa=([^&]+)/);
    const nameMatch = rawUri.match(/pn=([^&]+)/);
    const amtMatch = rawUri.match(/am=([^&]+)/);
    const noteMatch = rawUri.match(/tn=([^&]+)/);

    const cleanVpa = vpaMatch ? vpaMatch[1] : '';
    const cleanName = nameMatch ? nameMatch[1] : 'SidTech%20366';
    const cleanAmt = amtMatch ? amtMatch[1] : Number(order.amount || 1.00).toFixed(2);
    const cleanNote = noteMatch ? noteMatch[1] : 'Payment';

    // Direct PhonePe deep link with clean P2P parameters so PhonePe opens directly without rejection
    const phonePeDeepLink = `phonepe://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmt}&cu=INR&tn=${cleanNote}`;
    btnPhonePe.href = phonePeDeepLink;
    btnPhonePe.onclick = null;
  }

  // 4. Paytm: Uses Android Intent URL with explicit package targeting on Android, fallback for iOS
  const btnPaytm = document.getElementById('btnPaytm');
  if (btnPaytm) {
    if (isAndroid) {
      btnPaytm.href = `intent://pay?${upiParams}#Intent;scheme=upi;package=net.one97.paytm;end`;
    } else {
      btnPaytm.href = `paytmmp://pay?${upiParams}`;
    }
  }

  // 5. Navi
  const btnNavi = document.getElementById('btnNavi');
  if (btnNavi) {
    if (isAndroid) {
      btnNavi.href = `intent://pay?${upiParams}#Intent;scheme=com.naviapp;end`;
    } else {
      btnNavi.href = rawUri;
    }
  }

  // 6. super.money
  const btnSuperMoney = document.getElementById('btnSuperMoney');
  if (btnSuperMoney) {
    if (isAndroid) {
      btnSuperMoney.href = `intent://pay?${upiParams}#Intent;scheme=upi;package=money.super.payments;end`;
    } else {
      btnSuperMoney.href = rawUri;
    }
  }
}

if (typeof window !== 'undefined') {
  window.setupUpiIntentLinks = setupUpiIntentLinks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { setupUpiIntentLinks };
}
