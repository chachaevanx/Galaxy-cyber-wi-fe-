const express = require("express");

const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = "https://chachaevanx.github.io";
const MPESA_BASE = "https://sandbox.safaricom.co.ke";

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Cloudflare D1 REST API connection
async function db(sql, params = []) {
  const account = process.env.CF_ACCOUNT_ID;
  const database = process.env.CF_D1_DATABASE_ID;
  const token = process.env.CF_API_TOKEN;

  if (!account || !database || !token) {
    throw new Error("Cloudflare D1 environment settings are missing.");
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${account}` +
    `/d1/database/${database}/query`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sql, params })
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error("Database request failed.");
  }

  return data.result?.[0] || {};
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");

  if (phone.startsWith("0")) phone = "254" + phone.slice(1);
  if (phone.startsWith("7") || phone.startsWith("1")) {
    phone = "254" + phone;
  }

  return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

function getTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");

  return d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
}

function adminAuth(req, res, next) {
  const supplied = (req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "");

  if (!process.env.ADMIN_TOKEN ||
      supplied !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  next();
}

async function mpesaToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret || !process.env.MPESA_PASSKEY) {
    throw new Error("M-Pesa credentials are missing.");
  }

  const credentials = Buffer.from(`${key}:${secret}`).toString("base64");

  const response = await fetch(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}` }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Could not authenticate with Daraja.");
  }

  return data.access_token;
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await db("SELECT 1 AS ok");
    res.json({
      success: true,
      service: "Galex Cyber WiFi API",
      database: "connected",
      mpesa: "Sandbox"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Active WiFi packages
app.get("/api/packages", async (req, res) => {
  try {
    const result = await db(
      `SELECT id, name, duration_minutes,
       single_price, two_device_price
       FROM packages WHERE active = 1
       ORDER BY duration_minutes ASC`
    );

    const packages = (result.results || []).map(p => ({
      id: p.id,
      name: p.name,
      durationMinutes: p.duration_minutes,
      oneDevice: p.single_price,
      twoDevices: p.two_device_price
    }));

    res.json({ success: true, packages });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Request M-Pesa STK Push
app.post("/api/payments/stkpush", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const packageId = Number(req.body.packageId);
    const devices = Number(req.body.deviceLimit || 1);

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid Safaricom phone number."
      });
    }

    if (![1, 2].includes(devices)) {
      return res.status(400).json({
        success: false,
        error: "Select one or two devices."
      });
    }

    const found = await db(
      `SELECT id, name, duration_minutes,
       single_price, two_device_price
       FROM packages WHERE id = ? AND active = 1`,
      [packageId]
    );

    const pkg = found.results?.[0];

    if (!pkg) {
      return res.status(404).json({
        success: false,
        error: "Package not found."
      });
    }

    const amount = Number(
      devices === 1 ? pkg.single_price : pkg.two_device_price
    );

    const shortcode = process.env.MPESA_SHORTCODE || "174379";
    const transactionType =
      process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline";

    const time = getTimestamp();
    const password = Buffer.from(
      shortcode + process.env.MPESA_PASSKEY + time
    ).toString("base64");

    const baseUrl = process.env.PUBLIC_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL;

    if (!baseUrl) {
      throw new Error("PUBLIC_BASE_URL is not configured.");
    }

    const callbackUrl = baseUrl.replace(/\/$/, "") +
      "/api/mpesa/callback";

    // Create pending payment record first
    await db(
      `INSERT INTO payments
       (phone, amount, package_id, device_limit, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [phone, amount, pkg.id, devices]
    );

    const accessToken = await mpesaToken();

    const response = await fetch(
      `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: time,
          TransactionType: transactionType,
          Amount: amount,
          PartyA: phone,
          PartyB: shortcode,
          PhoneNumber: phone,
          CallBackURL: callbackUrl,
          AccountReference: "GALEXWIFI",
          TransactionDesc: `Galex ${pkg.name} WiFi`
        })
      }
    );

    const result = await response.json();

    if (!response.ok || result.ResponseCode !== "0") {
      return res.status(502).json({
        success: false,
        error: result.errorMessage ||
          result.ResponseDescription ||
          "Safaricom rejected the STK request."
      });
    }

    await db(
      `UPDATE payments SET checkout_request_id = ?
       WHERE phone = ? AND package_id = ?
       AND status = 'pending'
       AND checkout_request_id IS NULL`,
      [result.CheckoutRequestID, phone, pkg.id]
    );

    res.json({
      success: true,
      message: result.CustomerMessage ||
        "Check your phone for the M-Pesa prompt.",
      checkoutRequestId: result.CheckoutRequestID,
      amount,
      phone
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Safaricom payment callback
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback?.CheckoutRequestID) {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const checkoutId = callback.CheckoutRequestID;

    const found = await db(
      `SELECT p.id, p.phone, p.device_limit,
       p.status, pk.duration_minutes
       FROM payments p
       JOIN packages pk ON pk.id = p.package_id
       WHERE p.checkout_request_id = ?`,
      [checkoutId]
    );

    const payment = found.results?.[0];

    if (!payment || payment.status !== "pending") {
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    if (Number(callback.ResultCode) === 0) {
      const items = callback.CallbackMetadata?.Item || [];

      const receipt = items.find(
        item => item.Name === "MpesaReceiptNumber"
      )?.Value || null;

      const start = new Date();
      const expiry = new Date(
        start.getTime() + Number(payment.duration_minutes) * 60000
      );

      await db(
        `UPDATE payments SET status = 'success',
         mpesa_receipt = ? WHERE id = ?`,
        [receipt, payment.id]
      );

      // Pending until MikroTik provisioning is connected
      await db(
        `INSERT INTO subscriptions
         (payment_id, phone, device_limit, starts_at,
          expires_at, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [
          payment.id,
          payment.phone,
          payment.device_limit,
          start.toISOString(),
          expiry.toISOString()
        ]
      );

    } else {
      await db(
        "UPDATE payments SET status = 'failed' WHERE id = ?",
        [payment.id]
      );
    }

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (error) {
    console.error("M-Pesa callback error:", error.message);
    res.json({ ResultCode: 0, ResultDesc: "Received" });
  }
});

// Check payment status
app.get("/api/payment-status/:checkoutId", async (req, res) => {
  try {
    const result = await db(
      `SELECT id, phone, amount, device_limit,
       status, mpesa_receipt
       FROM payments WHERE checkout_request_id = ?`,
      [req.params.checkoutId]
    );

    const payment = result.results?.[0];

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment not found."
      });
    }

    res.json({ success: true, payment });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin summary
app.get("/api/admin/summary", adminAuth, async (req, res) => {
  try {
    const payments = await db(
      `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       COALESCE(SUM(CASE WHEN status = 'success'
       THEN amount ELSE 0 END), 0) AS revenue
       FROM payments`
    );

    const subscriptions = await db(
      `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'active'
       AND expires_at > datetime('now') THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM subscriptions`
    );

    res.json({
      success: true,
      payments: payments.results?.[0],
      subscriptions: subscriptions.results?.[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin subscriptions
app.get("/api/admin/subscriptions", adminAuth, async (req, res) => {
  try {
    const result = await db(
      `SELECT s.id, s.payment_id, s.phone,
       s.hotspot_username, s.hotspot_password,
       s.device_limit, s.starts_at, s.expires_at,
       s.status, p.amount, p.mpesa_receipt
       FROM subscriptions s
       LEFT JOIN payments p ON p.id = s.payment_id
       ORDER BY s.id DESC LIMIT 200`
    );

    res.json({
      success: true,
      subscriptions: result.results || []
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Galex Cyber WiFi API listening on ${PORT}`);
});
        
