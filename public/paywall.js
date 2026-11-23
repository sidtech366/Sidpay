/**
 * Client Logic for Hosted Dynamic Paywall Screen
 * Fully dynamic order creation, instant cache-free verification & re-checking
 */

document.addEventListener('DOMContentLoaded', () => {
  const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const isTestRoute = window.location.pathname.startsWith('/test') || new URLSearchParams(window.location.search).get('test') === '1';
  let orderId = pathParts[pathParts.length - 1];

  let orderData = null;
  let isVerified = false;
  let timerSeconds = 300;
  let pollTimer = null;
  let countdownTimer = null;
  let redirectTimer = null;
  let orderCreatedAt = Date.now();
  const PAYMENT_WINDOW_MS = 20 * 60 * 1000; // server matches payments within 20 minutes

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
    if (!orderId || ['pay', 'new', 'test', 'checkout'].includes(orderId)) {
      showInvalid();
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
        showInvalid();
        return;
      }

      orderData = data;
      renderOrder();
      applyClaimState(data.order);

      if (data.order.status === 'PAID') {
        triggerSuccess(data.order.paymentDetails || {}, data.order);
        return;
      }

      startTimers();
      setupSSE();
      startPolling();
    } catch (e) {
      showInvalid('Could not load this payment', 'Check your internet connection and open the link again.');
    }

    setupEvents();
  }

  // Customer asked for manual checking: show review / rejected state
  function applyClaimState(order) {
    const claim = order && order.claim;
    if (!claim || order.status === 'PAID') return false;
    const statusEl = document.querySelector('.status');
    const desc = document.getElementById('radarDesc');
    statusEl.classList.remove('expired', 'review', 'rejected');
    if (claim.status === 'PENDING_REVIEW') {
      statusEl.classList.add('review');
      radarTitle.textContent = 'Payment sent for checking';
      desc.textContent = `SidTech 366 is checking UPI Ref No ${claim.utr} in the bank account. You can close this page and open the same link later to see the result.`;
      paywallTimer.textContent = '';
      return true;
    }
    if (claim.status === 'REJECTED') {
      statusEl.classList.add('rejected');
      radarTitle.textContent = 'We could not confirm this payment';
      desc.textContent = `${claim.note || 'Payment not found in our bank account'}. Check the UPI Ref No and send it again, or call 70694 92135.`;
      paywallTimer.textContent = '';
      return true;
    }
    return false;
  }

  function showInvalid(title, text) {
    paywallCard.classList.add('hidden');
    const card = document.getElementById('invalidCard');
    if (title) document.getElementById('invalidTitle').textContent = title;
    if (text) document.getElementById('invalidText').textContent = text;
    card.classList.remove('hidden');
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
    merchantLogo.textContent = ((m.businessName || 'SidTech')[0] || 'S').toUpperCase();
    amountDisplay.textContent = inr(o.amount);

    purposeDisplay.textContent = o.note || 'Payment';
    const exactNote = document.getElementById('exactAmountNote');
    if (exactNote) {
      exactNote.textContent = `Pay exactly ${inr(o.amount)}, including paise, so your payment is confirmed automatically.`;
    }
    document.title = `Pay ${inr(o.amount)} to ${m.businessName || 'SidTech 366'}`;
    orderCreatedAt = new Date(o.createdAt || Date.now()).getTime();

    // Dynamic QR with exact pre-filled amount
    if (o.dynamicQrDataUrl) {
      dynamicQrImg.src = o.dynamicQrDataUrl;
    }
    
    upiIdDisplay.textContent = m.upiId || '';

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
    const saveQrBtn = document.getElementById('saveQrBtn');
    if (saveQrBtn) {
      saveQrBtn.addEventListener('click', async () => {
        const src = dynamicQrImg.src;
        const name = `SidTech366-${(orderData && orderData.order && orderData.order.orderId) || 'payment'}.png`;
        try {
          const blob = await (await fetch(src)).blob();
          const file = new File([blob], name, { type: blob.type || 'image/png' });
          // Phones that support sharing files can save straight to Photos
          if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad/i.test(navigator.userAgent)) {
            await navigator.share({ files: [file], title: 'Payment QR' });
            return;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          showToast('QR saved. Now open your UPI app, tap Scan and pick it from the gallery.');
        } catch (e) {
          showToast('Could not save. Long-press the QR image and choose "Download image".');
        }
      });
    }

    copyUpiBtn.addEventListener('click', () => {
      const id = upiIdDisplay.textContent;
      navigator.clipboard.writeText(id).then(() => {
        showToast('UPI ID copied');
      });
    });


    submitUtrBtn.addEventListener('click', async () => {
      const utr = manualUtrInput.value.trim();
      if (!utr) return showToast('Enter the 12-digit UPI Ref No');

      submitUtrBtn.disabled = true;
      submitUtrBtn.textContent = 'Checking…';

      try {
        const res = await fetch(`/api/v1/checkout/verify-utr?_t=${Date.now()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ orderId, utr, payerName: (document.getElementById('payerNameInput') || {}).value || '' })
        });
        const data = await res.json();
        if (data.verified && data.order) {
          triggerSuccess(data.order.paymentDetails || {}, data.order);
        } else if (data.underReview && data.order) {
          applyClaimState(data.order);
          const details = document.querySelector('details.utr');
          if (details) details.open = false;
          showToast('Request sent for checking');
        } else {
          showToast(data.message || data.error || 'Could not check this UPI Ref No.');
        }
      } catch (e) {
        showToast('Could not check right now. Try again in a moment.');
      } finally {
        submitUtrBtn.disabled = false;
        submitUtrBtn.textContent = 'Check payment';
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
      if (document.referrer && !document.referrer.includes(window.location.host)) {
        window.location.href = document.referrer;
      } else {
        window.close();
        setTimeout(() => { window.location.href = 'https://sidtech366.vercel.app'; }, 300);
      }
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
      if (isManual) showToast('Checking payment status…');
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
        if (isManual) showToast('Payment confirmed');
      } else {
        if (data.order) applyClaimState(data.order);
        if (isManual) showToast('Not confirmed yet. Bank confirmation can take a minute.');
      }
    } catch (e) {
      if (isManual) showToast('Could not reach the server. Check your internet.');
    }
  }

  function startTimers() {
    const tick = () => {
      if (isVerified) return clearInterval(countdownTimer);
      if (document.querySelector('.status').matches('.review, .rejected')) return;
      const left = Math.max(0, Math.floor((orderCreatedAt + PAYMENT_WINDOW_MS - Date.now()) / 1000));
      const mins = Math.floor(left / 60);
      const secs = left % 60;
      paywallTimer.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      if (left <= 0) {
        clearInterval(countdownTimer);
        const statusEl = document.querySelector('.status');
        if (statusEl) statusEl.classList.add('expired');
        radarTitle.textContent = 'This payment link has expired';
        const desc = document.getElementById('radarDesc');
        if (desc) desc.textContent = 'Do not pay now. If you already paid, enter the UPI Ref No below.';
      }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function triggerSuccess(payment, order) {
    isVerified = true;

    clearInterval(pollTimer);
    clearInterval(countdownTimer);

    playSuccessChime();

    const amt = parseFloat(order.amount || 1).toFixed(2);
    successAmtDisplay.textContent = inr(amt);
    receiptOrderId.textContent = order.orderId;
    receiptPayer.textContent = (payment && payment.senderName) || (order && order.customerName) || 'UPI Customer';
    receiptPayee.textContent = (orderData && orderData.merchant && orderData.merchant.businessName) || 'SidTech 366';
    receiptUtr.textContent = (payment && payment.utr) || (order.paymentDetails && order.paymentDetails.utr) || 'Confirmed';
    receiptTxnId.textContent = (payment && payment.txnId) || (order.paymentDetails && order.paymentDetails.txnId) || `TXN-${(payment && payment.utr) || Date.now()}`;
    
    const validDate = (payment && payment.date) || (order && order.verifiedAt) || Date.now();
    receiptTime.textContent = new Date(validDate).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    paywallCard.classList.add('hidden');
    successCard.classList.remove('hidden');
    document.title = `Paid ${inr(amt)} to ${receiptPayee.textContent}`;

    successCard.classList.add('show');
    const purposeEl = document.getElementById('receiptPurpose');
    if (purposeEl) purposeEl.textContent = order.note || '';
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
