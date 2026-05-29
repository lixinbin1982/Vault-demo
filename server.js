/**
 * VaultApp — PayPal Vault-Only Demo Server
 * ─────────────────────────────────────────────────────────────────────────────
 * ALL three scenarios (Subscription / Top-Up / Lifetime) use the same pattern:
 *
 *   1. Create Order   POST /v2/checkout/orders
 *                        payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS
 *   2. Capture        POST /v2/checkout/orders/{id}/capture
 *                        → response contains vault.id (permanent token)
 *   3. Store token    your DB: userId → vaultId
 *
 * Recurring subscription charges are executed by the backend using the saved
 * vault token — no user present, no PayPal Subscriptions API used.
 *
 * Card vaulting uses the separate Setup Token flow:
 *   POST /v3/vault/setup-tokens  →  user enters card  →  POST /v3/vault/payment-tokens
 *   → charge via payment_source.card.vault_id
 *
 * Sandbox base: https://api-m.sandbox.paypal.com
 */

require('dotenv').config({ path: require('path').resolve(__dirname, 'config.env') });
const express = require('express');
const fetch   = require('node-fetch');
const { v4: uuid } = require('uuid');

// ── Fallback sandbox credentials (demo only) ─────────────────────────────────
if (!process.env.PAYPAL_CLIENT_ID)
  process.env.PAYPAL_CLIENT_ID = 'AYTDZp4ybe95PktB8VgNAhY4NNXBi_5AJ6vmI7N4jImUiMq0bMH76Wd8Ij3vQnYSnYvD2-bI06BCOQE3';
if (!process.env.PAYPAL_CLIENT_SECRET)
  process.env.PAYPAL_CLIENT_SECRET = 'EA6a7MXqtmPhy-PSS9rY-PNUgnMuX6aWJUuS3DZG_FghiZQ-8dS-B2Wz6nmxo53ZvUF9ZcaKx5tp9N46';

const app        = express();
const BASE       = 'https://api-m.sandbox.paypal.com';
const PORT       = process.env.PORT || 3000;
const CUSTOMER_ID = process.env.DEMO_CUSTOMER_ID || 'DEMO-CUSTOMER-001';

app.use(express.json());
app.use(express.static('public'));

// ─── In-memory vault token store ─────────────────────────────────────────────
// Keyed by customerId → array of token records
const vaultStore = {};

function saveToken(customerId, record) {
  if (!vaultStore[customerId]) vaultStore[customerId] = [];
  // Avoid duplicates
  if (!vaultStore[customerId].find(t => t.id === record.id)) {
    vaultStore[customerId].push(record);
  }
}
function listTokens(customerId) {
  return vaultStore[customerId] || [];
}
function deleteToken(customerId, tokenId) {
  if (vaultStore[customerId]) {
    vaultStore[customerId] = vaultStore[customerId].filter(t => t.id !== tokenId);
  }
}

// ─── Access Token Cache ──────────────────────────────────────────────────────
let _token = null, _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
      ).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Token fetch failed ${r.status}: ${await r.text()}`);
  const d   = await r.json();
  _token    = d.access_token;
  _tokenExp = Date.now() + (d.expires_in - 120) * 1000;
  console.log('🔑 Access token refreshed');
  return _token;
}

// ─── PayPal API Helper ───────────────────────────────────────────────────────
async function pp(method, path, body = null, idempotencyKey = null) {
  const token = await getToken();
  const headers = {
    'Authorization':      `Bearer ${token}`,
    'Content-Type':       'application/json',
    'PayPal-Request-Id':  idempotencyKey || uuid(),
  };
  console.log(`\n→ ${method} ${path}`);
  if (body) console.log('  ', JSON.stringify(body, null, 2).slice(0, 600));

  const r    = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  console.log(`← ${r.status}`, JSON.stringify(data).slice(0, 500));
  return { status: r.status, ok: r.ok, data };
}

// ─── GET /api/debug/token ────────────────────────────────────────────────────
// Returns the raw token response including all granted scopes
app.get('/api/debug/token', async (req, res) => {
  try {
    const r = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const d = await r.json();
    res.json({ scopes: d.scope?.split(' ') || [], expires_in: d.expires_in, token_type: d.token_type });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Credentials guard ───────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    // Allow /api/config and /api/status to pass through even without creds
    if (req.path === '/config' || req.path === '/status') return next();
    return res.status(503).json({
      error:  'Missing credentials',
      detail: 'Copy .env.example → .env and fill in PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET',
    });
  }
  next();
});

// ─── GET /api/config ─────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    clientId:   process.env.PAYPAL_CLIENT_ID || '',
    customerId: CUSTOMER_ID,
    port:       PORT,
    ready:      !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
  });
});

// ─── POST /api/client-token ───────────────────────────────────────────────────
// Required by PayPal JS SDK to associate vault operations with a customer.
app.post('/api/client-token', async (req, res) => {
  try {
    const customerId = req.body.customerId || CUSTOMER_ID;
    const { status, data } = await pp('POST', '/v1/identity/generate-token',
      { customer_id: customerId }
    );
    if (!data.client_token) {
      return res.status(status).json({ error: 'No client_token', detail: data });
    }
    res.json({ clientToken: data.client_token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/order/create ───────────────────────────────────────────────────
// Unified order creation for all three scenarios.
// store_in_vault: ON_SUCCESS  →  vault token only created on successful capture.
//
// type: 'subscription' | 'topup' | 'lifetime'
app.post('/api/order/create', async (req, res) => {
  try {
    const { type, customerId = CUSTOMER_ID } = req.body;

    const cfg = {
      subscription: {
        value: '9.99',
        desc:  'VaultApp Pro — First Month',
        note:  'Recurring billing managed via vault token after first charge',
      },
      topup: {
        value: '19.99',
        desc:  '500 Credits Top-Up',
        note:  'One-time purchase, vault for quick repeat top-ups',
      },
      lifetime: {
        value: '299.00',
        desc:  'VaultApp Lifetime Access',
        note:  'One-time purchase',
      },
    }[type] || { value: '1.00', desc: 'VaultApp Purchase', note: '' };

    const { status, data } = await pp('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id:  `${type.toUpperCase()}-${Date.now()}`,
        description:   cfg.desc,
        custom_id:     customerId,
        soft_descriptor: 'VAULTAPP',
        amount: {
          currency_code: 'AUD',
          value:         cfg.value,
        },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name:          'VaultApp',
            shipping_preference: 'NO_SHIPPING',
            user_action:         'PAY_NOW',
            return_url: `http://localhost:${PORT}/?status=approved`,
            cancel_url: `http://localhost:${PORT}/?status=cancelled`,
          },
          attributes: {
            vault: {
              store_in_vault: 'ON_SUCCESS',   // ← Core of all three flows
              usage_type:     'MERCHANT',
              customer_type:  'CONSUMER',
            },
            customer: { id: customerId },
          },
        },
      },
    });

    res.status(status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/order/capture ──────────────────────────────────────────────────
// Captures an approved order.
// On success, response contains:
//   payment_source.paypal.attributes.vault.id  → permanent PayPal vault token
app.post('/api/order/capture', async (req, res) => {
  try {
    const { orderId } = req.body;
    // Idempotency key = orderId so double-submit is safe
    const customerId = req.body.customerId || CUSTOMER_ID;
    const { status, data } = await pp(
      'POST',
      `/v2/checkout/orders/${orderId}/capture`,
      {},
      `CAPTURE-${orderId}`
    );

    // Auto-save vault token to local store
    if (data?.payment_source?.paypal?.attributes?.vault?.id) {
      const v = data.payment_source.paypal.attributes.vault;
      const src = data.payment_source.paypal;
      saveToken(customerId, {
        id:     v.id,
        status: v.status,
        type:   'paypal',
        payment_source: {
          paypal: {
            email_address: src.email_address || src.account_id || '',
            account_id:    src.account_id || '',
          },
        },
        created: new Date().toISOString(),
      });
    }
    if (data?.payment_source?.card?.attributes?.vault?.id) {
      const v   = data.payment_source.card.attributes.vault;
      const src = data.payment_source.card;
      saveToken(customerId, {
        id:     v.id,
        status: v.status,
        type:   'card',
        payment_source: {
          card: {
            brand:       src.brand || '',
            last_digits: src.last_digits || '',
            expiry:      src.expiry || '',
          },
        },
        created: new Date().toISOString(),
      });
    }

    res.status(status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/vault/setup-token ─────────────────────────────────────────────
// Card vaulting — Step 1.
// Creates a short-lived setup token. The frontend binds PayPal's hosted
// card fields to this token; the user enters their card details securely.
app.post('/api/vault/setup-token', async (req, res) => {
  try {
    const { customerId = CUSTOMER_ID } = req.body;
    const { status, data } = await pp('POST', '/v3/vault/setup-tokens', {
      payment_source: { card: {} },
      customer: { id: customerId },
    });
    res.status(status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/vault/payment-token ───────────────────────────────────────────
// Card vaulting — Step 2.
// Converts a completed setup token into a permanent payment token.
app.post('/api/vault/payment-token', async (req, res) => {
  try {
    const { setupTokenId, customerId = CUSTOMER_ID } = req.body;
    const { status, data } = await pp('POST', '/v3/vault/payment-tokens', {
      payment_source: {
        token: { id: setupTokenId, type: 'SETUP_TOKEN' },
      },
    });
    // Save to local store
    if (data?.id) {
      const src = data.payment_source?.card || {};
      saveToken(customerId, {
        id:   data.id,
        type: 'card',
        payment_source: {
          card: {
            brand:       src.brand || '',
            last_digits: src.last_digits || '',
            expiry:      src.expiry || '',
          },
        },
        created: new Date().toISOString(),
      });
    }
    res.status(status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/vault/tokens ────────────────────────────────────────────────────
// Returns tokens from local in-memory store (no PayPal API call needed)
app.get('/api/vault/tokens', (req, res) => {
  const customerId = req.query.customerId || CUSTOMER_ID;
  res.json({ payment_tokens: listTokens(customerId) });
});

// ─── DELETE /api/vault/tokens/:id ────────────────────────────────────────────
// Removes from local store (PayPal v3 delete skipped — needs vault scope)
app.delete('/api/vault/tokens/:id', (req, res) => {
  const customerId = req.query.customerId || CUSTOMER_ID;
  deleteToken(customerId, req.params.id);
  res.json({ deleted: true, id: req.params.id });
});

// ─── POST /api/vault/charge ───────────────────────────────────────────────────
// Off-session charge via saved PayPal wallet vault token.
// Used for:
//   - Recurring subscription renewals (run by your scheduler, no user present)
//   - Quick repeat top-ups
//   - Any future charge against a saved PayPal account
app.post('/api/vault/charge', async (req, res) => {
  try {
    const {
      vaultId,
      amount      = '9.99',
      description = 'VaultApp Recurring Charge',
    } = req.body;

    // Step 1: Create order referencing vault ID directly — no user approval URL needed
    const orderRes = await pp('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount:      { currency_code: 'AUD', value: amount },
        description,
      }],
      payment_source: {
        paypal: {
          vault_id: vaultId,
          stored_credential: {
            payment_initiator: 'MERCHANT',        // ← merchant-initiated, no user present
            payment_type:      'RECURRING',
            usage:             'SUBSEQUENT',      // ← subsequent charge after initial consent
          },
        },
      },
    });

    if (!orderRes.ok) {
      return res.status(orderRes.status).json({
        step: 'create_order', detail: orderRes.data,
      });
    }

    // When vault_id is in payment_source, PayPal auto-captures on order creation
    // — no separate capture call needed.
    const d = orderRes.data;
    const capture = d.purchase_units?.[0]?.payments?.captures?.[0];
    res.status(orderRes.status).json({
      orderId: d.id,
      status:  capture?.status || d.status,
      amount,
      vaultId,
      capture: d,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/vault/card-charge ─────────────────────────────────────────────
// Off-session charge via saved card vault token.
app.post('/api/vault/card-charge', async (req, res) => {
  try {
    const {
      vaultId,
      amount      = '9.99',
      description = 'VaultApp Card Recurring Charge',
    } = req.body;

    const orderRes = await pp('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount:      { currency_code: 'AUD', value: amount },
        description,
      }],
      payment_source: {
        card: {
          vault_id: vaultId,
          stored_credential: {
            payment_initiator: 'MERCHANT',
            payment_type:      'RECURRING',
            usage:             'SUBSEQUENT',
          },
        },
      },
    });

    if (!orderRes.ok) {
      return res.status(orderRes.status).json({
        step: 'create_order', detail: orderRes.data,
      });
    }

    // Same as PayPal vault — auto-captured on order creation
    const d = orderRes.data;
    const capture = d.purchase_units?.[0]?.payments?.captures?.[0];
    res.status(orderRes.status).json({
      orderId: d.id,
      status:  capture?.status || d.status,
      amount,
      vaultId,
      capture: d,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const creds = process.env.PAYPAL_CLIENT_ID
    ? '✅ Credentials loaded'
    : '⚠️  Missing credentials — copy .env.example → .env';
  console.log(`
╔══════════════════════════════════════════════════╗
║   VaultApp — PayPal Vault-Only Demo              ║
║   http://localhost:${PORT}                           ║
╚══════════════════════════════════════════════════╝
${creds}
Customer: ${CUSTOMER_ID}

All flows use Orders API v2 + Vault (NO Subscriptions API):
  POST /api/client-token                 Generate SDK client token
  POST /api/order/create                 Create order (subscription/topup/lifetime)
  POST /api/order/capture                Capture → returns vault token
  POST /api/vault/setup-token            Card vault step 1
  POST /api/vault/payment-token          Card vault step 2
  GET  /api/vault/tokens                 List saved tokens
  DELETE /api/vault/tokens/:id           Delete token
  POST /api/vault/charge                 Off-session PayPal charge
  POST /api/vault/card-charge            Off-session card charge
`);
});
