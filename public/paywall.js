/**
 * Client Logic for Hosted Dynamic Paywall Screen
 * Fully dynamic order creation, instant cache-free verification & re-checking
 */

document.addEventListener('DOMContentLoaded', () => {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const isTestRoute = window.location.pathname.startsWith('/test') || new URLSearchParams(window.location.search).get('test') === '1';
  let orderId = pathParts[pathParts.length - 1];

  let orderData = null;
  let isVerified = false;
  let timerSeconds = 300;
  let pollTimer = null;
  let countdownTimer = null;
  let redirectTimer = null;

  // DOM Elements
  const paywallCard = document.getElementById('paywallCard');
  const successCard = document.getElementById('successCard');
  const merchantNameDisplay = document.getElementById('merchantNameDisplay');
  const merchantLogo = document.getElementById('merchantLogo');
  const orderRefDisplay = document.getElementById('orderRefDisplay');
  const amountDisplay = document.getElementById('amountDisplay');
  const purposeDisplay = document.getElementById('purposeDisplay');
  const dynamicQrImg = document.getElementById('dynamicQrImg');
  const upiIdDisplay = document.getElementById('upiIdDisplay');
  const copyUpiBtn = document.getElementById('copyUpiBtn');
  const paywallTimer = document.getElementById('paywallTimer');
  const radarTitle = document.getElementById('radarTitle');
  const utrToggle = document.getElementById('utrToggle');
  const utrDrawer = document.getElementById('utrDrawer');
  const manualUtrInput = document.getElementById('manualUtrInput');
  const submitUtrBtn = document.getElementById('submitUtrBtn');
  const toastBox = document.getElementById('toastBox');

  // Dynamic & Re-check Buttons
  const btnNewDynamicOrder = document.getElementById('btnNewDynamicOrder');
  const btnRecheckStatus = document.getElementById('btnRecheckStatus');
  const btnPayAgain = document.getElementById('btnPayAgain');

  // Success Elements
  const successAmtDisplay = document.getElementById('successAmtDisplay');
  const receiptOrderId = document.getElementById('receiptOrderId');
  const receiptPayer = document.getElementById('receiptPayer');
  const receiptPayee = document.getElementById('receiptPayee');
  const receiptUtr = document.getElementById('receiptUtr');
  const receiptTxnId = document.getElementById('receiptTxnId');
  const receiptTime = document.getElementById('receiptTime');
  const printReceiptBtn = document.getElementById('printReceiptBtn');
  const returnMerchantBtn = document.getElementById('returnMerchantBtn');

  init();

  async function init() {
    // If order ID is 'new', empty, 'pay', or 'test', automatically create a dynamic checkout!
    if (!orderId || orderId === 'pay' || orderId === 'new' || orderId === 'test') {
      const urlParams = new URLSearchParams(window.location.search);
      const defaultAmt = isTestRoute ? 1.00 : 199.00;
      const reqAmount = parseFloat(urlParams.get('amount')) || defaultAmt;
      const customerName = isTestRoute ? 'Test User' : 'Gateway Source Customer';
      const note = isTestRoute ? 'Payment Gateway Test ₹1.00' : 'Complete Gateway Source Code';
      await createNewDynamicOrder(reqAmount, customerName, note, isTestRoute);
      return;
    }

    try {
      // Strict Cache-Busting fetch
      const res = await fetch(`/api/v1/checkout/${orderId}?_t=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      const data = await res.json();
      if (!data.success || !data.order) {
        showToast('Order not found. Generating new dynamic order...');
        const defaultAmt = isTestRoute ? 1.00 : 199.00;
        const note = isTestRoute ? 'Payment Gateway Test ₹1.00' : 'Complete Gateway Source Code';
        setTimeout(() => createNewDynamicOrder(defaultAmt, 'Customer', note, isTestRoute), 1200);
        return;
      }

      orderData = data;
      renderOrder();

      if (data.order.status === 'PAID') {
        triggerSuccess(data.order.paymentDetails || {}, data.order);
        return;
      }

      startTimers();
      setupSSE();
      startPolling();
    } catch (e) {
      showToast('Could not load checkout order');
    }

    setupEvents();
  }

  async function createNewDynamicOrder(amount = 199.00, customerName = 'Gateway Source Customer', note = 'Complete Gateway Source Code', isTest = false) {
    showToast(`Generating dynamic ₹${amount.toFixed(2)} checkout...`);
    try {
      const res = await fetch(`/api/v1/checkout/create?_t=${Date.now()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify({
          amount: amount,
          customerName: customerName,
          note: note
        })
      });
      const data = await res.json();
      if (data.success && data.orderId) {
        window.location.href = isTest ? `/test/${data.orderId}` : `/pay/${data.orderId}`;
        return;
      }
      showToast('Failed to create dynamic order');
    } catch (err) {
      showToast('Error creating order');
    }
  }

  function renderOrder() {
    const o = orderData.order;
    const m = orderData.merchant || {};

    orderRefDisplay.textContent = o.orderId || o.orderCode;
    merchantNameDisplay.textContent = m.businessName || 'SidTech 366';
    merchantLogo.textContent = ((m.businessName || 'Apex')[0] || 'A').toUpperCase();
    amountDisplay.textContent = `₹${parseFloat(o.amount).toFixed(2)}`;

    const isTestOrder = isTestRoute || (o.note && o.note.toLowerCase().includes('test')) || (parseFloat(o.amount) <= 5);
    if (isTestOrder) {
      purposeDisplay.textContent = o.note || 'UPI System Test Payment • ₹1 Auto-Verification';
      const productBadge = document.querySelector('.product-badge span');
      const productTitleText = document.querySelector('.product-title-text');
      if (productBadge) productBadge.textContent = '⚡ TEST PAYMENT (₹1)';
      if (productTitleText) productTitleText.textContent = 'Make a ₹1 payment to test live bank credit auto-verification and success screen';
      const downPaymentSpan = document.querySelector('.down-payment-label span:last-child');
      if (downPaymentSpan) downPaymentSpan.textContent = 'SCAN & PAY EXACT ₹1 • INSTANT AUTO-VERIFICATION';
      if (btnPayAgain) btnPayAgain.textContent = 'Test Again (New ₹1)';
    } else {
      purposeDisplay.textContent = o.note || 'Make a payment and get source code of complete payment gateway';
      if (btnPayAgain) btnPayAgain.textContent = 'Pay Again (New ₹199)';
    }
    
    // Dynamic QR with exact pre-filled amount
    if (o.dynamicQrDataUrl) {
      dynamicQrImg.src = o.dynamicQrDataUrl;
    }
    
    upiIdDisplay.textContent = m.upiId || '';

    // Show PhonePe intent specifically on test route (/test/new or ₹1 test payments)
    const btnPhonePe = document.getElementById('btnPhonePe');
    if (btnPhonePe) {
      btnPhonePe.style.display = isTestOrder ? 'flex' : 'none';
    }

    // 1-Tap Mobile Intent Deep-Links configuration
    if (typeof window.setupUpiIntentLinks === 'function') {
      window.setupUpiIntentLinks(o);
    } else {
      setupUpiDeepLinksFallback(o);
    }
  }

  function setupUpiDeepLinksFallback(order) {
    const rawUri = order.upiUri || order.dynamicUpiUrl || '';
    if (!rawUri) return;
    const upiParams = rawUri.replace(/^upi:\/\/pay\??/, '');
    const isAndroid = /Android/i.test(navigator.userAgent || '');

    const btnPayDirect = document.getElementById('btnPayDirect');
    const btnFamPay = document.getElementById('btnFamPay');
    const btnGPay = document.getElementById('btnGPay');
    const btnPhonePe = document.getElementById('btnPhonePe');
    const btnPaytm = document.getElementById('btnPaytm');
    const btnNavi = document.getElementById('btnNavi');
    const btnSuperMoney = document.getElementById('btnSuperMoney');

    if (btnPayDirect) btnPayDirect.href = rawUri;
    if (btnFamPay) btnFamPay.href = rawUri;
    if (btnGPay) btnGPay.href = `tez://upi/pay?${upiParams}`;

    if (btnPhonePe) {
      const vpaMatch = rawUri.match(/pa=([^&]+)/);
      const nameMatch = rawUri.match(/pn=([^&]+)/);
      const amtMatch = rawUri.match(/am=([^&]+)/);
      const noteMatch = rawUri.match(/tn=([^&]+)/);

      const cleanVpa = vpaMatch ? vpaMatch[1] : '';
      const cleanName = nameMatch ? nameMatch[1] : 'SidTech%20366';
      const cleanAmt = amtMatch ? amtMatch[1] : Number(order.amount || 1.00).toFixed(2);
      const cleanNote = noteMatch ? noteMatch[1] : 'Test%20Payment';

      // Pure direct PhonePe deep link with clean pre-filled parameters (no intent wrapper, no mode/tr)
      const phonePeDeepLink = `phonepe://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmt}&cu=INR&tn=${cleanNote}`;
      btnPhonePe.href = phonePeDeepLink;
      btnPhonePe.onclick = null;
    }
    if (btnPaytm) {
      btnPaytm.href = isAndroid
        ? `intent://pay?${upiParams}#Intent;scheme=upi;package=net.one97.paytm;end`
        : `paytmmp://pay?${upiParams}`;
    }
    if (btnNavi) {
      btnNavi.href = isAndroid
        ? `intent://pay?${upiParams}#Intent;scheme=com.naviapp;end`
        : rawUri;
    }
    if (btnSuperMoney) {
      btnSuperMoney.href = isAndroid
        ? `intent://pay?${upiParams}#Intent;scheme=upi;package=money.super.payments;end`
        : rawUri;
    }
  }

  function setupEvents() {
    copyUpiBtn.addEventListener('click', () => {
      const id = upiIdDisplay.textContent;
      navigator.clipboard.writeText(id).then(() => {
        showToast('UPI ID copied to clipboard: ' + id);
      });
    });

    utrToggle.addEventListener('click', () => {
      utrDrawer.classList.toggle('hidden');
    });

    submitUtrBtn.addEventListener('click', async () => {
      const utr = manualUtrInput.value.trim();
      if (!utr) return showToast('Enter 12-digit UTR');

      submitUtrBtn.disabled = true;
      submitUtrBtn.textContent = 'Checking...';

      try {
        const res = await fetch(`/api/v1/checkout/verify-utr?_t=${Date.now()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ orderId, utr })
        });
        const data = await res.json();
        if (data.verified && data.order) {
          triggerSuccess(data.order.paymentDetails || {}, data.order);
        } else {
          showToast(data.message || 'UTR not verified yet.');
        }
      } catch (e) {
        showToast('Error checking UTR.');
      } finally {
        submitUtrBtn.disabled = false;
        submitUtrBtn.textContent = 'Verify UTR';
      }
    });

    if (btnNewDynamicOrder) {
      btnNewDynamicOrder.addEventListener('click', () => {
        if (isTestRoute) {
          createNewDynamicOrder(1.00, 'Test User', 'Payment Gateway Test ₹1.00', true);
        } else {
          createNewDynamicOrder(199.00, 'Gateway Source Customer', 'Complete Gateway Source Code', false);
        }
      });
    }

    if (btnRecheckStatus) {
      btnRecheckStatus.addEventListener('click', () => checkStatusNow(true));
    }

    if (btnPayAgain) {
      btnPayAgain.addEventListener('click', () => {
        if (isTestRoute) {
          createNewDynamicOrder(1.00, 'Test User', 'Payment Gateway Test ₹1.00', true);
        } else {
          createNewDynamicOrder(199.00, 'Gateway Source Customer', 'Complete Gateway Source Code', false);
        }
      });
    }

    printReceiptBtn.addEventListener('click', () => window.print());
    returnMerchantBtn.addEventListener('click', () => {
      window.location.href = `/api/v1/checkout/delivery/${orderId}`;
    });
  }

  function setupSSE() {
    try {
      const evtSource = new EventSource(`/api/v1/checkout/events/${orderId}`);
      evtSource.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'PAYMENT_SUCCESS') {
            triggerSuccess(payload.payment, payload.order);
            evtSource.close();
          }
        } catch (err) {}
      };
    } catch (e) {}
  }

  function startPolling() {
    let count = 0;
    // Ultra-fast responsive polling (750ms)
    pollTimer = setInterval(async () => {
      if (isVerified) return clearInterval(pollTimer);
      count++;
      radarTitle.textContent = `Auto-verifying payment${'.'.repeat((count % 3) + 1)}`;
      await checkStatusNow(false);
    }, 750);

    // Instant check the microsecond user switches back from PhonePe/GPay/Paytm app
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !isVerified) {
        checkStatusNow(false);
      }
    });

    window.addEventListener('focus', () => {
      if (!isVerified) {
        checkStatusNow(false);
      }
    });
  }

  async function checkStatusNow(isManual = false) {
    try {
      if (isManual) showToast('Checking payment status in real-time...');
      const res = await fetch(`/api/v1/checkout/status/${orderId}?_t=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      const data = await res.json();
      if (data.verified && data.order) {
        if (data.merchant && (!orderData || !orderData.merchant)) {
          if (!orderData) orderData = {};
          orderData.merchant = data.merchant;
        }
        triggerSuccess(data.order.paymentDetails || {}, data.order);
        if (isManual) showToast('✓ Payment verified successfully!');
      } else if (isManual) {
        showToast('Payment not yet verified. Awaiting bank alert...');
      }
    } catch (e) {
      if (isManual) showToast('Could not reach verification server.');
    }
  }

  function startTimers() {
    countdownTimer = setInterval(() => {
      if (isVerified) return clearInterval(countdownTimer);
      timerSeconds--;
      if (timerSeconds <= 0) {
        clearInterval(countdownTimer);
        timerSeconds = 300;
      }
      const mins = Math.floor(timerSeconds / 60);
      const secs = timerSeconds % 60;
      paywallTimer.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
  }

  function triggerSuccess(payment, order) {
    isVerified = true;

    clearInterval(pollTimer);
    clearInterval(countdownTimer);

    playSuccessChime();
    fireConfetti();

    const amt = parseFloat(order.amount || 1).toFixed(2);
    successAmtDisplay.textContent = `₹${amt}`;
    receiptOrderId.textContent = order.orderId;
    receiptPayer.textContent = (payment && payment.senderName) || (order && order.customerName) || 'UPI Customer';
    receiptPayee.textContent = (orderData && orderData.merchant && orderData.merchant.businessName) || 'SidTech 366';
    receiptUtr.textContent = (payment && payment.utr) || (order.paymentDetails && order.paymentDetails.utr) || 'Confirmed';
    receiptTxnId.textContent = (payment && payment.txnId) || (order.paymentDetails && order.paymentDetails.txnId) || `TXN-${(payment && payment.utr) || Date.now()}`;
    
    const validDate = (payment && payment.date) || (order && order.verifiedAt) || Date.now();
    receiptTime.textContent = new Date(validDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    paywallCard.classList.add('hidden');
    successCard.classList.remove('hidden');
    document.title = `✓ Paid ₹${amt} - Confirmed • SidPay`;

    const isTestOrder = isTestRoute || (order.note && order.note.toLowerCase().includes('test')) || (parseFloat(order.amount) <= 5);
    if (isTestOrder) {
      const deliveryBadge = document.querySelector('.delivery-badge');
      const deliveryTitle = document.querySelector('.delivery-title');
      const deliveryDesc = document.querySelector('.delivery-desc');
      const verifiedPill = document.querySelector('.pill-verified');
      if (verifiedPill) verifiedPill.textContent = '₹1 Test Payment Verified & Confirmed';
      if (deliveryBadge) deliveryBadge.textContent = 'LIVE SYSTEM TEST PASSED • GATEWAY ACTIVE';
      if (deliveryTitle) deliveryTitle.textContent = '✅ ₹1 Payment Successfully Verified!';
      if (deliveryDesc) deliveryDesc.textContent = 'Bank credit alert was received and matched in real-time! Gateway is fully operational.';
    }

    // Secure Server-Side Delivery & Auto-Redirect (Only accessible after verified payment)
    const deliveryEndpoint = `/api/v1/checkout/delivery/${order.orderId}`;
    const downloadEndpoint = `/api/v1/checkout/delivery/${order.orderId}?download=1`;

    const btnDownloadDrive = document.getElementById('btnDownloadDrive');
    if (btnDownloadDrive) {
      btnDownloadDrive.href = deliveryEndpoint;
      btnDownloadDrive.addEventListener('click', () => {
        triggerDeliveryDownload(downloadEndpoint);
      });
    }

    let countdown = 3;
    const countdownEl = document.getElementById('redirectCountdown');
    if (redirectTimer) clearInterval(redirectTimer);
    redirectTimer = setInterval(() => {
      countdown--;
      if (countdownEl) {
        countdownEl.textContent = `${countdown}s`;
      }
      if (countdown <= 0) {
        clearInterval(redirectTimer);
        // Direct download attempt on phone/browser via verified backend endpoint
        triggerDeliveryDownload(downloadEndpoint);
        // Direct redirect via verified backend endpoint
        window.location.href = deliveryEndpoint;
      }
    }, 1000);
  }

  function triggerDeliveryDownload(url) {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    } catch (e) {}
  }

  function playSuccessChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      [1318.5, 1661.2, 1975.5].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.001, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.25, now + idx * 0.08 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.8);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.85);
      });
    } catch (e) {}
  }

  function fireConfetti() {
    if (typeof confetti === 'function') {
      confetti({ particleCount: 90, spread: 70, origin: { y: 0.6 } });
    }
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
});
