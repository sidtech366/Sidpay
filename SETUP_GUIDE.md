# 📘 SidPay • Complete Setup & Deployment Guide

> **0% Transaction Fee Automated UPI Payment Gateway with Instant Bank Alert Auto-Verification, Micro-Paise Anti-Collision Allocation, and 1-Tap Mobile Intent Deep-Links.**

---

## 📑 Table of Contents

1. [System Overview & Architecture](#1-system-overview--architecture)
2. [Prerequisites Checklist](#2-prerequisites-checklist)
3. [Step 1: Local Installation & Environment Setup](#3-step-1-local-installation--environment-setup)
4. [Step 2: Configuring Gmail IMAP & App Password](#4-step-2-configuring-gmail-imap--app-password)
5. [Step 3: Setting Up MongoDB Atlas Database](#5-step-3-setting-up-mongodb-atlas-database)
6. [Step 4: Running Locally & Testing](#6-step-4-running-locally--testing)
7. [Step 5: Deploying Backend to Appwrite Cloud](#7-step-5-deploying-backend-to-appwrite-cloud)
8. [Step 6: Deploying Paywall Frontend to Vercel](#8-step-6-deploying-paywall-frontend-to-vercel)
9. [Step 7: Production Daemon with PM2 or Docker](#9-step-7-production-daemon-with-pm2-or-docker)
10. [Architecture Details: Intent Schemes & Concurrency](#10-architecture-details-intent-schemes--concurrency)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)

---

## 1. System Overview & Architecture

SidPay allows developers, business owners, and creators to accept direct peer-to-peer (P2P) and merchant UPI payments with zero payment gateway fees. All payments go straight into your own UPI account.

### Verification Flow

```
[Customer opens Checkout]
       │
       ▼
[Dynamic QR & 1-Tap Intent Generated with Micro-Paise Offset (e.g. ₹1.02)]
       │
       ▼
[Customer pays via PhonePe / GPay / Paytm / Navi / FamPay]
       │
       ▼
[Bank sends Transaction Alert Email to your Gmail inbox]
       │
       ▼
[SidPay IMAP Daemon catches TCP socket alert in <100ms]
       │
       ▼
[Regex extracts exact Amount, UTR, and TxnId -> Marks Order 'PAID']
       │
       ▼
[Checkout Paywall auto-detects status -> Displays Green Success Receipt 🎉]
```

---

## 2. Prerequisites Checklist

Ensure you have the following before starting:

- [x] **Node.js**: v18.0.0 or higher installed (`node -v`)
- [x] **NPM**: v9.0.0 or higher (`npm -v`)
- [x] **Gmail Account**: With **2-Step Verification** turned on (for generating an App Password).
- [x] **MongoDB Atlas Account**: Free Tier (M0) or a local MongoDB database instance.
- [x] **UPI Handle**: Your personal or business UPI ID (e.g., `yourname@fam`, `yourname@okhdfcbank`, `yournumber@paytm`).

---

## 3. Step 1: Local Installation & Environment Setup

1. **Extract or Open the Project Folder**:
   ```bash
   cd payment-gateway
   ```

2. **Install Root Dependencies**:
   ```bash
   npm install
   ```

3. **Install Appwrite Cloud Function Dependencies**:
   ```bash
   cd functions/payment-gateway
   npm install
   cd ../..
   ```

4. **Create your `.env` file**:
   Copy `.env.example` to `.env`:
   ```bash
   # Windows PowerShell:
   Copy-Item .env.example .env

   # Linux / macOS:
   cp .env.example .env
   ```

---

## 4. Step 2: Configuring Gmail IMAP & App Password

To enable SidPay's daemon to detect bank credit alerts in real time:

1. Log into your Google Account at [myaccount.google.com](https://myaccount.google.com/).
2. Navigate to **Security** and confirm that **2-Step Verification** is **ON**.
3. Go directly to **App Passwords**: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
4. Enter an App Name (e.g., `SidPay Daemon`) and click **Create**.
5. Copy the generated **16-character password** (format: `xxxx xxxx xxxx xxxx`).
6. Enable IMAP in Gmail Settings:
   - Go to [mail.google.com](https://mail.google.com) > Click the **Gear icon** (Settings) > **See all settings**.
   - Open the **Forwarding and POP/IMAP** tab.
   - Select **Enable IMAP** and click **Save Changes**.

Add these credentials to your `.env` file:
```env
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASS=your16charpassword
```

---

## 5. Step 3: Setting Up MongoDB Atlas Database

1. Sign up or log into [MongoDB Atlas](https://www.mongodb.com/atlas).
2. Create a free shared cluster (M0 sandbox).
3. Under **Database Access**, create a user (e.g., `sidpay_user`) with read and write permissions.
4. Under **Network Access**, add IP `0.0.0.0/0` (Allow access from anywhere) so cloud functions and your local daemon can connect.
5. Click **Connect** > **Drivers** (Node.js) and copy the connection string.
6. Replace `<password>` with your database user password and specify `/sidpay` as the database name.

Add it to your `.env` file:
```env
MONGODB_URI=mongodb+srv://sidpay_user:your_password@cluster0.xxxxx.mongodb.net/sidpay?retryWrites=true&w=majority
```

---

## 6. Step 4: Running Locally & Testing

### Complete `.env` Reference

Your `.env` file should look like this:
```env
PORT=3000

# Merchant Display Information
PAYEE_NAME=SidTech 366
BUSINESS_NAME=SidTech 366
UPI_ID=yourname@upi

# Gmail IMAP Auto-Verification
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASS=your-16-char-app-pass

# Database
MONGODB_URI=mongodb+srv://sidpay_user:your_password@cluster0.xxxxx.mongodb.net/sidpay?retryWrites=true&w=majority

# Appwrite Cloud (Optional - only required if syncing to Appwrite)
APPWRITE_ENDPOINT=https://sgp.cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your_project_id
APPWRITE_API_KEY=your_api_key
```

### Start the Server

```bash
npm start
# or in development with auto-reload:
npm run dev
```

You should see:
```text
====================================================
🚀 SidPay Platform running at: http://localhost:3000
💼 Active Merchant: SidTech 366
📧 Monitoring Email: your-email@gmail.com
====================================================
```

### Accessing the Interfaces

- **Merchant Dashboard**: Open [http://localhost:3000](http://localhost:3000)
- **New Dynamic Checkout**: Open [http://localhost:3000/pay/new](http://localhost:3000/pay/new)

### Simulating a Payment

You can test instant auto-verification without transferring real money using the simulation endpoint:

```bash
curl -X POST http://localhost:3000/api/v1/simulate-payment \
  -H "Content-Type: application/json" \
  -d '{"amount": 1.00, "payerName": "Test Customer", "utr": "123456789012"}'
```
The active paywall window will immediately update to green and display the success receipt.

---

## 7. Step 5: Deploying Backend to Appwrite Cloud

If you want a serverless cloud API for creating checkout orders:

1. Install Appwrite CLI or run via npx:
   ```bash
   npx appwrite login
   ```
2. Verify `appwrite.json` has your Project ID:
   ```json
   {
     "projectId": "YOUR_APPWRITE_PROJECT_ID",
     "projectName": "SidPay Gateway",
     "functions": [ ... ]
   }
   ```
3. Deploy the function to Appwrite Cloud:
   ```bash
   npx -p appwrite-cli appwrite push functions --all --force
   ```
4. In your [Appwrite Cloud Console](https://cloud.appwrite.io):
   - Go to **Functions** > **payment-gateway** > **Settings** > **Variables**.
   - Add the environment variable:
     - `MONGODB_URI`: your full MongoDB connection string.

---

## 8. Step 6: Deploying Paywall Frontend to Vercel

The `public/` directory contains the complete standalone static frontend:

1. Install Vercel CLI or deploy via npx:
   ```bash
   npx vercel login
   ```
2. Deploy the `public` directory to production:
   ```bash
   npx -y vercel deploy public --prod
   ```
3. Update `public/vercel.json` if using a custom backend domain:
   ```json
   {
     "cleanUrls": true,
     "rewrites": [
       { "source": "/pay/:path*", "destination": "/paywall" },
       { "source": "/checkout/:path*", "destination": "/paywall" },
       { "source": "/api/:match*", "destination": "https://YOUR_BACKEND_OR_APPWRITE_URL/api/:match*" }
     ]
   }
   ```

---

## 9. Step 7: Production Daemon with PM2 or Docker

Because bank alert emails arrive asynchronously, the IMAP socket daemon (`server.js`) needs to remain continuously active.

### Option A: Using PM2 (Recommended for VPS / Cloud Server)

1. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```
2. Start SidPay:
   ```bash
   pm2 start server.js --name sidpay
   ```
3. Enable auto-restart on system reboot:
   ```bash
   pm2 startup
   pm2 save
   ```
4. View real-time logs:
   ```bash
   pm2 logs sidpay
   ```

### Option B: Using Docker

Create a `Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```
Build and run:
```bash
docker build -t sidpay .
docker run -d --restart always --name sidpay-gateway -p 3000:3000 --env-file .env sidpay
```

---

## 10. Architecture Details: Intent Schemes & Concurrency

### 1. Strict NPCI UPI Intent URI Rule
Implemented in `src/utils/qr.util.js`:
```javascript
upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&tr=${txnRef}&tn=${cleanNote}&cu=INR&mode=00
```
- **Crucial Rule on `pa`**: The `@` symbol in `pa` **MUST NOT** be percent-encoded (`%40`). Major UPI apps (GPay, PhonePe, Paytm) reject `%40` as an invalid handle.
- **`mode=00`**: Mandatory parameter required by strict bank clients like Paytm to prevent rejection.

### 2. Targeted Mobile Deep-Links
Implemented in `public/js/checkout.js`:
- **Universal UPI Selector / FamPay**: `upi://pay?...`
- **Google Pay**: `tez://upi/pay?...` (Uses registered Tez scheme)
- **PhonePe**: `phonepe://pay?...`
- **Paytm**: `intent://pay?...#Intent;scheme=upi;package=net.one97.paytm;end` (Android package targeting, fallback to `paytmmp://` on iOS)
- **Navi**: `intent://pay?...#Intent;scheme=com.naviapp;end`
- **super.money**: `intent://pay?...#Intent;scheme=upi;package=money.super.payments;end`

### 3. Anti-Collision Micro-Paise Offsets
When 2 or more customers pay concurrently, the engine queries active pending orders in the last 15 minutes and offsets the amount by ₹0.01:
- User A: ₹1.00
- User B: ₹1.01
- User C: ₹1.02
When the bank email arrives stating `"₹1.01 received"`, SidPay verifies **only** User B's order. User A and User C remain safely isolated.

---

## 11. Troubleshooting & FAQ

| Problem | Cause | Solution |
| :--- | :--- | :--- |
| **`[IMAP] Authentication failed`** | Incorrect Gmail credentials or 2FA issue | Ensure 2-Step Verification is ON and you are using a 16-character **Google App Password**, not your normal Gmail password. |
| **`Invalid scheme: expected mongodb://`** | Missing or malformed `MONGODB_URI` | Confirm `MONGODB_URI` in `.env` or Appwrite console starts with `mongodb+srv://` and contains no unescaped special characters in the password. |
| **PhonePe shows "Payment not allowed"** | Percent-encoded `@` (`%40`) or missing mode | SidPay explicitly leaves `@` unencoded and adds `mode=00`. Verify you are running the latest `src/utils/qr.util.js`. |
| **Payments not auto-verifying** | Bank alert email not delivered to Gmail | Verify that your bank/UPI app sends transaction alerts to your configured `GMAIL_USER`. Check Spam folder. |
| **Paywall shows static ₹1.00 instead of dynamic order** | Missing order ID in URL | Open `/pay/new` or pass a valid order code `/pay/:orderId` to generate a dynamic anti-collision order. |

---

<div align="center">
  <b>SidPay • Built for Fast, Zero-Fee Indian UPI Payments</b><br>
  Open Source under the MIT License.
</div>
