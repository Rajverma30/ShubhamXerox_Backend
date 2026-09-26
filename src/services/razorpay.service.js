/**
 * Razorpay — orders and signature verification.
 *
 * Implemented with axios + Basic auth rather than the `razorpay` npm package,
 * deliberately: it avoids adding a dependency (and an npm install) to a server
 * that is already running, and the only cryptography involved is an HMAC that
 * Node does natively.
 *
 * Money is handled in PAISE everywhere in this file. Razorpay's API is integer
 * paise; mixing rupees and paise is the classic way to charge someone 100x, so
 * the conversion happens in exactly one place — `toPaise()`.
 */
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

const KEY_ID = () => process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = () => process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = () => process.env.RAZORPAY_WEBHOOK_SECRET || '';

const isConfigured = () => Boolean(KEY_ID() && KEY_SECRET());

/**
 * Rupees → integer paise.
 *
 * The nudge is not decoration. In binary floating point
 * `1.005 * 100 === 100.49999999999999`, so a plain Math.round() gives 100
 * paise and the customer is charged a paisa less than the invoice says.
 * Adding a value far smaller than half a paisa corrects the representation
 * error without ever changing a genuine .xx4 → .xx5 boundary.
 *
 * Totals are whole rupees today, so this is defensive — but a pricing change
 * upstream should not be able to introduce a silent under-charge.
 */
const toPaise = (rupees) => {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100 + (n >= 0 ? 1e-6 : -1e-6));
};

function authHeader() {
  return `Basic ${Buffer.from(`${KEY_ID()}:${KEY_SECRET()}`).toString('base64')}`;
}

/**
 * Create a Razorpay order.
 * @param {number} amountRupees
 * @param {string} receipt      our order number, for reconciliation
 * @param {Object} notes        surfaced in the Razorpay dashboard
 */
async function createOrder(amountRupees, receipt, notes = {}) {
  if (!isConfigured()) {
    throw ApiError.internal('Payments are not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }

  const amount = toPaise(amountRupees);
  if (!Number.isInteger(amount) || amount < 100) {
    throw ApiError.badRequest('Order total is too small to process.');
  }

  try {
    const { data } = await axios.post(
      'https://api.razorpay.com/v1/orders',
      {
        amount,
        currency: 'INR',
        receipt: String(receipt).slice(0, 40),
        // We only ever want fully-paid orders; no partial payments.
        payment_capture: 1,
        notes,
      },
      { headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }, timeout: 20000 },
    );
    return data; // { id: 'order_xxx', amount, currency, ... }
  } catch (err) {
    const detail = err.response?.data?.error?.description || err.message;
    logger.error(`Razorpay createOrder failed: ${detail}`);
    if (err.response?.status === 401) {
      throw ApiError.internal('Razorpay rejected our API keys. Check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.');
    }
    throw ApiError.internal('Could not start the payment. Please try again.');
  }
}

/**
 * Verify the signature the browser hands back after checkout.
 *
 * signature = HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)
 *
 * This is what stops a customer calling our "payment done" endpoint by hand.
 * Without it, anyone could POST a fake payment id and receive free books.
 */
function verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;

  const expected = crypto
    .createHmac('sha256', KEY_SECRET())
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verify a webhook. Signed over the RAW body, so the exact bytes matter —
 * `req.rawBody` is captured for this in app.js.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET() || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET()).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Read a payment back from Razorpay — the authoritative amount and status. */
async function fetchPayment(paymentId) {
  const { data } = await axios.get(`https://api.razorpay.com/v1/payments/${paymentId}`, {
    headers: { Authorization: authHeader() },
    timeout: 20000,
  });
  return data;
}

module.exports = {
  isConfigured,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchPayment,
  toPaise,
  publicKey: KEY_ID,
};
