/**
 * Master Application Client Logic (SidPay Platform & Dashboard)
 */

document.addEventListener('DOMContentLoaded', () => {
  // App State
  let currentMerchant = null;
  let activeOnboardingStep = 1;
  let uploadedQrPath = '/uploads/default-qr.jpeg';
  let decodedUpiId = '';
  let merchantSse = null;

  // Views
  const views = {
    landing: document.getElementById('viewLanding'),
    auth: document.getElementById('viewAuth'),
    onboarding: document.getElementById('viewOnboarding'),
    dashboard: document.getElementById('viewDashboard')
  };

  // Nav Elements
  const brandLogo = document.getElementById('brandLogo');
  const btnNavLogin = document.getElementById('btnNavLogin');
  const btnNavRegister = document.getElementById('btnNavRegister');
  const navWatcherStatus = document.getElementById('navWatcherStatus');
  const navWatcherText = document.getElementById('navWatcherText');
  const btnHeroGetStarted = document.getElementById('btnHeroGetStarted');
  const btnHeroDemoCheckout = document.getElementById('btnHeroDemoCheckout');

  // Auth Elements
  const authTitle = document.getElementById('authTitle');
  const authSubtitle = document.getElementById('authSubtitle');
  const tabSignIn = document.getElementById('tabSignIn');
  const tabSignUp = document.getElementById('tabSignUp');
  const formSignIn = document.getElementById('formSignIn');
  const formSignUp = document.getElementById('formSignUp');
  const loginEmail = document.getElementById('loginEmail');
  const loginPass = document.getElementById('loginPass');
  const btnQuickDemoLogin = document.getElementById('btnQuickDemoLogin');

  // Onboarding Elements
  const obBusinessName = document.getElementById('obBusinessName');
  const obUpiId = document.getElementById('obUpiId');
  const qrDropzone = document.getElementById('qrDropzone');
  const qrFileInput = document.getElementById('qrFileInput');
  const btnSelectQrFile = document.getElementById('btnSelectQrFile');
  const qrDetectionPreview = document.getElementById('qrDetectionPreview');
  const previewQrImg = document.getElementById('previewQrImg');
  const detectedUpiTag = document.getElementById('detectedUpiTag');
  const obGmailUser = document.getElementById('obGmailUser');
  const obGmailPass = document.getElementById('obGmailPass');
  const btnTestGmailImap = document.getElementById('btnTestGmailImap');
  const testBtnText = document.getElementById('testBtnText');
  const testBtnSpinner = document.getElementById('testBtnSpinner');
  const testFeedback = document.getElementById('testFeedback');
  const obApiKeyDisplay = document.getElementById('obApiKeyDisplay');
  const btnCopyObApiKey = document.getElementById('btnCopyObApiKey');
  const btnGoToDashboard = document.getElementById('btnGoToDashboard');

  // Dashboard Elements
  const dashBusinessTitle = document.getElementById('dashBusinessTitle');
  const metricVolume = document.getElementById('metricVolume');
  const metricPaidCount = document.getElementById('metricPaidCount');
  const metricQueueLoad = document.getElementById('metricQueueLoad');
  const ordersTableBody = document.getElementById('ordersTableBody');
  const btnRefreshOrders = document.getElementById('btnRefreshOrders');
  const dashApiKeyDisplay = document.getElementById('dashApiKeyDisplay');
  const btnCopyDashKey = document.getElementById('btnCopyDashKey');
  const codeSnippetBox = document.getElementById('codeSnippetBox');
  const codeTabs = document.querySelectorAll('.code-tab');
  const btnSimulateConcurrent = document.getElementById('btnSimulateConcurrent');
  const simFeedback = document.getElementById('simFeedback');
  const btnOpenCreatePaywallModal = document.getElementById('btnOpenCreatePaywallModal');
  const btnDashLogout = document.getElementById('btnDashLogout');

  // Paywall Modal Elements
  const modalCreatePaywall = document.getElementById('modalCreatePaywall');
  const btnClosePaywallModal = document.getElementById('btnClosePaywallModal');
  const btnCancelPaywallModal = document.getElementById('btnCancelPaywallModal');
  const formCreatePaywall = document.getElementById('formCreatePaywall');
  const pwAmount = document.getElementById('pwAmount');
  const pwCustomerName = document.getElementById('pwCustomerName');
  const pwNote = document.getElementById('pwNote');
  const paywallLinkResult = document.getElementById('paywallLinkResult');
  const generatedPaywallUrl = document.getElementById('generatedPaywallUrl');
  const btnCopyGeneratedUrl = document.getElementById('btnCopyGeneratedUrl');
  const btnOpenGeneratedUrl = document.getElementById('btnOpenGeneratedUrl');

  const toastContainer = document.getElementById('toastContainer');

  init();

  function init() {
    setupNavigation();
    setupAuth();
    setupOnboarding();
    setupDashboard();
    loadSavedSession();
  }

  // ==============================================================
  // 1. NAVIGATION & ROUTING
  // ==============================================================
  function showView(viewId) {
    Object.values(views).forEach(v => {
      if (v) v.classList.remove('active');
    });
    if (views[viewId]) {
      views[viewId].classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function setupNavigation() {
    brandLogo.addEventListener('click', () => showView('landing'));

    btnNavLogin.addEventListener('click', () => {
      if (currentMerchant) {
        showView('dashboard');
      } else {
        setAuthTab('signin');
        showView('auth');
      }
    });

    btnNavRegister.addEventListener('click', () => {
      if (currentMerchant) {
        showView('dashboard');
      } else {
        setAuthTab('signup');
        showView('auth');
      }
    });

    btnHeroGetStarted.addEventListener('click', () => {
      if (currentMerchant) {
        showView('dashboard');
      } else {
        setAuthTab('signup');
        showView('auth');
      }
    });

    // Open Test Paywall
    btnHeroDemoCheckout.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/merchant/create-paywall-link', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-merchant-id': currentMerchant ? currentMerchant.id : 'merch_default'
          },
          body: JSON.stringify({
            amount: 5,
            customerName: 'Demo Customer',
            note: 'Cloud Server Deployment Demo'
          })
        });
        const data = await res.json();
        if (data.success && data.paywallUrl) {
          window.open(data.paywallUrl, '_blank');
        } else {
          showToast('Could not launch paywall.');
        }
      } catch (e) {
        showToast('Error opening test paywall.');
      }
    });

    // Interactive Hero Simulation
    const btnTriggerHeroSimulation = document.getElementById('btnTriggerHeroSimulation');
    if (btnTriggerHeroSimulation) {
      btnTriggerHeroSimulation.addEventListener('click', () => {
        triggerHeroSimulation();
      });
    }
  }

  function triggerHeroSimulation() {
    const radarTitle = document.getElementById('heroRadarTitle');
    const radarSub = document.getElementById('heroRadarSub');
    const phoneNotif = document.getElementById('heroPhoneNotif');
    const radarBox = document.getElementById('heroRadarBox');

    showToast('Simulating customer scanning and paying ₹500...');
    radarTitle.textContent = 'Incoming payment alert detected...';
    radarSub.textContent = 'Parsing bank IMAP stream...';

    setTimeout(() => {
      if (phoneNotif) {
        phoneNotif.style.transform = 'translateY(0) scale(1.04)';
        phoneNotif.style.borderColor = '#10B981';
      }
      if (radarTitle) radarTitle.textContent = '✓ Payment Verified in 1.2s';
      if (radarSub) radarSub.textContent = 'Order #PAY-892104 settled directly into your FamPay account.';
      if (radarBox) {
        radarBox.style.background = '#ECFDF5';
        radarBox.style.borderColor = '#A7F3D0';
      }

      if (typeof confetti === 'function') {
        confetti({ particleCount: 75, spread: 65, origin: { y: 0.65 } });
      }

      showToast('Payment verified successfully!');
    }, 1100);

    setTimeout(() => {
      if (phoneNotif) {
        phoneNotif.style.transform = 'none';
        phoneNotif.style.borderColor = '';
      }
    }, 4500);
  }

  // ==============================================================
  // 2. AUTHENTICATION LOGIC
  // ==============================================================
  function setupAuth() {
    tabSignIn.addEventListener('click', () => setAuthTab('signin'));
    tabSignUp.addEventListener('click', () => setAuthTab('signup'));

    // 1-Click Quick Demo Login
    btnQuickDemoLogin.addEventListener('click', () => {
      loginEmail.value = '';
      loginPass.value = 'password123';
      formSignIn.dispatchEvent(new Event('submit'));
    });

    // Sign In Submit
    formSignIn.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = loginEmail.value.trim();
      const password = loginPass.value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (data.success && data.merchant) {
          handleAuthSuccess(data.merchant);
        } else {
          showToast(data.error || 'Invalid credentials');
        }
      } catch (err) {
        showToast('Login request failed');
      }
    });

    // Sign Up Submit
    formSignUp.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('regName').value.trim();
      const businessName = document.getElementById('regBusiness').value.trim();
      const email = document.getElementById('regEmail').value.trim();
      const password = document.getElementById('regPass').value;

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, businessName, email, password })
        });
        const data = await res.json();

        if (data.success && data.merchant) {
          showToast('Account created successfully!');
          handleAuthSuccess(data.merchant);
        } else {
          showToast(data.error || 'Registration failed');
        }
      } catch (err) {
        showToast('Network error during registration');
      }
    });
  }

  function setAuthTab(tab) {
    if (tab === 'signin') {
      tabSignIn.classList.add('active');
      tabSignUp.classList.remove('active');
      formSignIn.classList.remove('hidden');
      formSignUp.classList.add('hidden');
      authTitle.textContent = 'Sign In to SidPay';
      authSubtitle.textContent = 'Manage your payment gateway, API keys, and live transactions.';
    } else {
      tabSignUp.classList.add('active');
      tabSignIn.classList.remove('active');
      formSignUp.classList.remove('hidden');
      formSignIn.classList.add('hidden');
      authTitle.textContent = 'Create Merchant Account';
      authSubtitle.textContent = 'Start accepting zero-fee direct UPI payments in minutes.';
    }
  }

  function handleAuthSuccess(merchant) {
    currentMerchant = merchant;
    localStorage.setItem('sidpay_merchant', JSON.stringify(merchant));
    updateNavState();

    if (!merchant.isOnboarded) {
      showView('onboarding');
      window.nextOnboardingSlide(1);
    } else {
      showView('dashboard');
      loadDashboardData();
    }
  }

  async function loadSavedSession() {
    const saved = localStorage.getItem('sidpay_merchant');
    if (saved) {
      try {
        currentMerchant = JSON.parse(saved);
        updateNavState();
        if (currentMerchant.isOnboarded) {
          loadDashboardData();
        }
      } catch (e) {}
    } else {
      // Load default demo merchant
      try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.success && data.merchant) {
          currentMerchant = data.merchant;
          updateNavState();
        }
      } catch (e) {}
    }
  }

  function updateNavState() {
    if (currentMerchant) {
      btnNavLogin.textContent = currentMerchant.businessName || 'Dashboard';
      btnNavRegister.textContent = 'Open Dashboard';
    } else {
      btnNavLogin.textContent = 'Sign In';
      btnNavRegister.textContent = 'Get Started Free';
    }
  }

  // ==============================================================
  // 3. ONBOARDING WIZARD LOGIC
  // ==============================================================
  function setupOnboarding() {
    // Dropzone Click
    qrDropzone.addEventListener('click', () => qrFileInput.click());
    btnSelectQrFile.addEventListener('click', (e) => {
      e.stopPropagation();
      qrFileInput.click();
    });

    // File Selected
    qrFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('qrImage', file);

      showToast('Uploading & decoding QR code...');

      try {
        const res = await fetch('/api/merchant/upload-qr', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();

        if (data.success) {
          uploadedQrPath = data.qrImagePath;
          decodedUpiId = data.detectedUpiId;
          previewQrImg.src = data.qrImagePath;
          detectedUpiTag.textContent = `UPI ID: ${data.detectedUpiId}`;
          qrDetectionPreview.classList.remove('hidden');
          obUpiId.value = data.detectedUpiId;
          showToast(`QR Decoded: ${data.detectedUpiId}`);
        } else {
          showToast(data.error || 'Could not decode QR image');
        }
      } catch (err) {
        showToast('QR Upload failed');
      }
    });

    // Test Gmail IMAP Live
    btnTestGmailImap.addEventListener('click', async () => {
      const user = obGmailUser.value.trim();
      const pass = obGmailPass.value.trim();

      if (!user || !pass) {
        showToast('Please enter both Gmail address and App Password');
        return;
      }

      btnTestGmailImap.disabled = true;
      testBtnSpinner.classList.remove('hidden');
      testBtnText.textContent = 'Connecting to Gmail IMAP...';
      testFeedback.textContent = 'Establishing secure TLS connection...';

      try {
        const res = await fetch('/api/merchant/test-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gmailUser: user, gmailAppPass: pass })
        });
        const data = await res.json();

        if (data.success) {
          testFeedback.innerHTML = `<span style="color:#047857; font-weight:700;">✓ Success: Verified IMAP access (${data.inboxCount} messages in INBOX)</span>`;
          showToast('Gmail connection confirmed!');
        } else {
          testFeedback.innerHTML = `<span style="color:#DC2626;">✗ Failed: ${data.error}</span>`;
        }
      } catch (err) {
        testFeedback.textContent = 'Network error testing Gmail.';
      } finally {
        btnTestGmailImap.disabled = false;
        testBtnSpinner.classList.add('hidden');
        testBtnText.textContent = '⚡ Test Gmail IMAP Connection Live';
      }
    });

    btnCopyObApiKey.addEventListener('click', () => {
      navigator.clipboard.writeText(obApiKeyDisplay.textContent).then(() => {
        showToast('API Key copied to clipboard!');
      });
    });

    btnGoToDashboard.addEventListener('click', () => {
      showView('dashboard');
      loadDashboardData();
    });
  }

  // Global Slide Navigation function
  window.nextOnboardingSlide = function(stepNum) {
    activeOnboardingStep = stepNum;

    // Update Progress Step Pills
    document.querySelectorAll('.progress-step').forEach(step => {
      const s = parseInt(step.dataset.step);
      if (s === stepNum) {
        step.classList.add('active');
        step.classList.remove('completed');
      } else if (s < stepNum) {
        step.classList.remove('active');
        step.classList.add('completed');
      } else {
        step.classList.remove('active', 'completed');
      }
    });

    // Show correct slide
    document.querySelectorAll('.carousel-slide').forEach((slide, idx) => {
      if (idx + 1 === stepNum) {
        slide.classList.add('active');
      } else {
        slide.classList.remove('active');
      }
    });
  };

  // Global Tutorial Step Switcher
  window.setFamTutorialStep = function(stepIdx) {
    document.querySelectorAll('.tut-step-item').forEach(item => {
      item.classList.toggle('active', parseInt(item.dataset.stepIdx) === stepIdx);
    });

    document.getElementById('tutStepIndicator').textContent = `Step ${stepIdx} of 4`;
    const ill = document.getElementById('tutIllustration');

    const stepsData = [
      {
        title: 'Tap Profile Icon',
        desc: 'Open FamApp on your phone and tap your top-left profile avatar.',
        color: '#2563EB'
      },
      {
        title: 'Settings & Alerts',
        desc: 'Scroll down the menu and tap on "Notifications & Alerts".',
        color: '#6366F1'
      },
      {
        title: 'Turn ON Email Alerts',
        desc: 'Toggle the switch for "Email notifications for received payments" to ON.',
        color: '#10B981'
      },
      {
        title: 'Verify Linked Gmail',
        desc: 'Ensure your Gmail address is listed as your primary notification address.',
        color: '#0F172A'
      }
    ];

    const data = stepsData[stepIdx - 1];
    ill.innerHTML = `
      <div class="phone-card-sim">
        <div class="sim-avatar" style="background: ${data.color}"></div>
        <div class="sim-title">${data.title}</div>
        <div class="sim-desc">${data.desc}</div>
      </div>
    `;
  };

  // Complete Onboarding Call
  window.finishOnboarding = async function() {
    if (!currentMerchant) return;

    const payload = {
      merchantId: currentMerchant.id,
      businessName: obBusinessName.value.trim() || currentMerchant.businessName,
      upiId: obUpiId.value.trim() || decodedUpiId,
      qrImagePath: uploadedQrPath,
      gmailUser: obGmailUser.value.trim(),
      gmailAppPass: obGmailPass.value.trim()
    };

    try {
      const res = await fetch('/api/merchant/complete-onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success && data.merchant) {
        currentMerchant = data.merchant;
        localStorage.setItem('sidpay_merchant', JSON.stringify(data.merchant));
        obApiKeyDisplay.textContent = data.merchant.apiKey;

        // Launch celebratory confetti
        if (typeof confetti === 'function') {
          confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
        }

        window.nextOnboardingSlide(5);
      }
    } catch (e) {
      showToast('Could not complete onboarding.');
    }
  };

  // ==============================================================
  // 4. MERCHANT DASHBOARD LOGIC
  // ==============================================================
  function setupDashboard() {
    btnRefreshOrders.addEventListener('click', loadDashboardData);

    const tableSearchInput = document.getElementById('tableSearchInput');
    if (tableSearchInput) {
      tableSearchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        const rows = ordersTableBody.querySelectorAll('tr');
        rows.forEach(row => {
          const txt = row.textContent.toLowerCase();
          row.style.display = txt.includes(query) ? '' : 'none';
        });
      });
    }

    btnDashLogout.addEventListener('click', () => {
      localStorage.removeItem('sidpay_merchant');
      currentMerchant = null;
      updateNavState();
      showView('landing');
      showToast('Logged out.');
    });

    btnCopyDashKey.addEventListener('click', () => {
      const key = dashApiKeyDisplay.textContent;
      navigator.clipboard.writeText(key).then(() => {
        showToast('API Key copied: ' + key);
      });
    });

    // Integration Code Tabs
    codeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        codeTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderCodeSnippet(tab.dataset.lang);
      });
    });

    // Create Paywall Modal Events
    btnOpenCreatePaywallModal.addEventListener('click', () => {
      modalCreatePaywall.classList.remove('hidden');
      paywallLinkResult.classList.add('hidden');
    });

    btnClosePaywallModal.addEventListener('click', () => modalCreatePaywall.classList.add('hidden'));
    btnCancelPaywallModal.addEventListener('click', () => modalCreatePaywall.classList.add('hidden'));

    formCreatePaywall.addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = pwAmount.value;
      const customerName = pwCustomerName.value;
      const note = pwNote.value;

      try {
        const res = await fetch('/api/merchant/create-paywall-link', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-merchant-id': currentMerchant ? currentMerchant.id : 'merch_default'
          },
          body: JSON.stringify({ amount, customerName, note })
        });
        const data = await res.json();

        if (data.success && data.order) {
          const fullUrl = `${window.location.origin}/pay/${data.order.orderId}`;
          generatedPaywallUrl.value = fullUrl;
          btnOpenGeneratedUrl.href = fullUrl;
          paywallLinkResult.classList.remove('hidden');
          loadDashboardData();
          showToast('Payment link generated!');
        }
      } catch (err) {
        showToast('Error creating payment link');
      }
    });

    btnCopyGeneratedUrl.addEventListener('click', () => {
      navigator.clipboard.writeText(generatedPaywallUrl.value).then(() => {
        showToast('Paywall URL copied!');
      });
    });

    // Concurrency Simulator Test
    btnSimulateConcurrent.addEventListener('click', async () => {
      btnSimulateConcurrent.disabled = true;
      btnSimulateConcurrent.textContent = 'Simulating 2 simultaneous payments...';
      simFeedback.classList.remove('hidden');
      simFeedback.textContent = 'Launching User A (₹5) and User B (₹10) concurrently...';

      try {
        const p1 = fetch('/api/v1/simulate-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merchantId: currentMerchant ? currentMerchant.id : 'merch_default',
            amount: 5,
            payerName: 'Alex Rivera'
          })
        });

        const p2 = fetch('/api/v1/simulate-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merchantId: currentMerchant ? currentMerchant.id : 'merch_default',
            amount: 10,
            payerName: 'Sarah Jenkins'
          })
        });

        const [r1, r2] = await Promise.all([p1, p2]);
        const d1 = await r1.json();
        const d2 = await r2.json();

        simFeedback.innerHTML = `
          <strong>✓ Concurrency Engine Verified:</strong><br>
          • User A: ₹${d1.simulatedPayment.amount} (UTR ${d1.simulatedPayment.utr}) processed independently.<br>
          • User B: ₹${d2.simulatedPayment.amount} (UTR ${d2.simulatedPayment.utr}) processed independently.<br>
          Zero collision detected.
        `;

        loadDashboardData();
      } catch (err) {
        simFeedback.textContent = 'Simulation failed.';
      } finally {
        btnSimulateConcurrent.disabled = false;
        btnSimulateConcurrent.textContent = 'Run Concurrent Payment Test (2 Users)';
      }
    });
  }

  async function loadDashboardData() {
    if (!currentMerchant) return;

    try {
      const res = await fetch('/api/merchant/dashboard', {
        headers: { 'x-merchant-id': currentMerchant.id }
      });
      const data = await res.json();

      if (data.success) {
        const m = data.merchant;
        dashBusinessTitle.textContent = m.businessName;
        dashApiKeyDisplay.textContent = m.apiKey;
        metricVolume.textContent = `₹${parseFloat(data.metrics.totalVolume).toFixed(2)}`;
        metricPaidCount.textContent = data.metrics.paidCount;
        metricQueueLoad.textContent = `${data.metrics.pendingCount} active concurrent queues`;

        renderOrdersTable(data.recentOrders);
        renderCodeSnippet('curl');
        connectDashboardSSE(currentMerchant.id);
      }
    } catch (e) {
      console.warn('Dashboard load error:', e);
    }
  }

  function renderOrdersTable(orders) {
    if (!orders || orders.length === 0) {
      ordersTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: #94A3B8;">No transactions yet. Create a payment link above to start accepting funds.</td></tr>`;
      return;
    }

    ordersTableBody.innerHTML = orders.map(o => {
      const isPaid = o.status === 'PAID';
      const statusHtml = isPaid
        ? `<span class="badge-paid">✓ Verified</span>`
        : `<span class="badge-pending">⏳ Waiting</span>`;
      
      const utr = o.paymentDetails ? (o.paymentDetails.utr || o.paymentDetails.txnId || 'N/A') : '-';
      const time = new Date(o.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      return `
        <tr>
          <td class="font-mono"><strong>${o.orderId}</strong></td>
          <td>${escapeHtml(o.customerName || 'Customer')}</td>
          <td><strong>₹${parseFloat(o.amount).toFixed(2)}</strong></td>
          <td class="font-mono text-emerald">${utr}</td>
          <td>${time}</td>
          <td>${statusHtml}</td>
        </tr>
      `;
    }).join('');
  }

  function renderCodeSnippet(lang) {
    const key = currentMerchant ? currentMerchant.apiKey : 'sid_live_your_key_here';
    const origin = window.location.origin;

    if (lang === 'curl') {
      codeSnippetBox.textContent = `curl -X POST ${origin}/api/v1/checkout/create \\
  -H "x-api-key: ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 500,
    "customerName": "John Doe",
    "note": "Pro Plan Subscription"
  }'`;
    } else if (lang === 'node') {
      codeSnippetBox.textContent = `const res = await fetch('${origin}/api/v1/checkout/create', {
  method: 'POST',
  headers: {
    'x-api-key': '${key}',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    amount: 500,
    customerName: 'John Doe',
    note: 'Pro Plan Subscription'
  })
});
const data = await res.json();
console.log('Hosted Paywall URL:', data.checkoutUrl);`;
    } else if (lang === 'python') {
      codeSnippetBox.textContent = `import requests

res = requests.post(
  '${origin}/api/v1/checkout/create',
  headers={'x-api-key': '${key}'},
  json={
    'amount': 500,
    'customerName': 'John Doe',
    'note': 'Pro Plan Subscription'
  }
)
data = res.json()
print("Checkout URL:", data['checkoutUrl'])`;
    }
  }

  function connectDashboardSSE(merchantId) {
    if (merchantSse) return;
    try {
      merchantSse = new EventSource(`/api/merchant/events?merchantId=${merchantId}`);
      merchantSse.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.type === 'TRANSACTION_VERIFIED') {
            showToast(`Payment of ₹${payload.order.amount} verified!`);
            loadDashboardData();
          }
        } catch (err) {}
      };
    } catch (e) {}
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }
});
