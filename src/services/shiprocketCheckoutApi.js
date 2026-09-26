/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Shiprocket Checkout — OUTBOUND client (we call them)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Direction note. There are two halves to this integration and they point
 * opposite ways:
 *
 *   shiprocketCheckout.controller.js  Shiprocket → us   (catalogue sync)
 *   THIS FILE                         us → Shiprocket   (checkout token)
 *
 * Every request is signed:
 *
 *   X-Api-Key:          <api key>
 *   X-Api-HMAC-SHA256:  base64( HMAC-SHA256( secret, exact request body ) )
 *
 * The HMAC is computed over the EXACT bytes sent. Serialise once, sign that
 * string, send that string — re-stringifying the object separately will
 * reorder keys and the signature will not match.
 *
 * Because the secret is required, the token MUST be minted server-side. It can
 * never move to the storefront, which is why POST /api/checkout/token exists.
 */
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

const BASE = () =>
  (process.env.SHIPROCKET_CHECKOUT_API_BASE || 'https://checkout-api.shiprocket.com').replace(/\/$/, '');

const KEY = () => process.env.SHIPROCKET_CHECKOUT_API_KEY || '';
const SECRET = () =>
  process.env.SHIPROCKET_CHECKOUT_API_SECRET || process.env.SHIPROCKET_CHECKOUT_SECRET || '';

/**
 * The integration guide is inconsistent: its prose says
 * `X-Api-Key: Bearer <key>` while every working curl example sends the bare
 * key. Bare is the default because the examples are what Shiprocket tested.
 * Flip with SHIPROCKET_CHECKOUT_BEARER=true if they 401.
 */
const apiKeyHeader = () =>
  (String(process.env.SHIPROCKET_CHECKOUT_BEARER).toLowerCase() === 'true' ? `Bearer ${KEY()}` : KEY());

/** base64 HMAC-SHA256 of the raw body string. */
function sign(bodyString) {
  return crypto.createHmac('sha256', SECRET()).update(bodyString, 'utf8').digest('base64');
}

function assertConfigured() {
  if (!KEY() || !SECRET()) {
    throw ApiError.internal(
      'Shiprocket Checkout is not configured — set SHIPROCKET_CHECKOUT_API_KEY and ' +
      'SHIPROCKET_CHECKOUT_API_SECRET in .env, then restart.',
    );
  }
}

/** POST with signing. Returns response data. */
async function post(path, payload) {
  assertConfigured();

  // Serialise ONCE. This exact string is both signed and sent.
  const body = JSON.stringify(payload);

  try {
    const { data } = await axios.post(`${BASE()}${path}`, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKeyHeader(),
        'X-Api-HMAC-SHA256': sign(body),
      },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    logger.error(
      `Shiprocket Checkout ${path} failed${status ? ` (${status})` : ''}: ` +
      (typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail || err.message).slice(0, 300)),
    );

    if (status === 401 || status === 403) {
      throw ApiError.internal(
        'Shiprocket rejected our credentials. Check SHIPROCKET_CHECKOUT_API_KEY / _SECRET, ' +
        'and try SHIPROCKET_CHECKOUT_BEARER=true if the key needs a "Bearer " prefix.',
      );
    }
    throw ApiError.internal('Could not reach Shiprocket Checkout. Please try again.');
  }
}

/**
 * Mint a checkout token for a cart.
 *
 * @param {Array}  items        [{ variant_id, quantity }] — variant_id must be
 *                              the id we published in the catalogue feed, or
 *                              Shiprocket cannot match the line.
 * @param {string} redirectUrl  where the customer lands after payment
 * @returns {Promise<string>}   the token for HeadlessCheckout.addToCart()
 */
async function createCheckoutToken(items, redirectUrl) {
  const data = await post('/api/v1/access-token/checkout', {
    cart_data: { items },
    redirect_url: redirectUrl,
    timestamp: new Date().toISOString(),
  });

  // Shiprocket wraps it as { result: { token } }; accept the obvious variants
  // so a small response-shape change doesn't take checkout down.
  const token = data?.result?.token || data?.data?.token || data?.token;
  if (!token) {
    logger.error(`Shiprocket returned no token. Response: ${JSON.stringify(data).slice(0, 400)}`);
    throw ApiError.internal('Shiprocket did not return a checkout token.');
  }
  return token;
}

/** Fetch an order after checkout — used to verify a webhook we just received. */
async function fetchOrder(orderId) {
  const base = process.env.SHIPROCKET_CHECKOUT_ORDER_API_BASE || BASE();
  const body = JSON.stringify({ order_id: orderId, timestamp: new Date().toISOString() });

  const { data } = await axios.post(`${base}/api/v1/custom-platform-order/details`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKeyHeader(),
      'X-Api-HMAC-SHA256': sign(body),
    },
    timeout: 20000,
  });
  return data;
}

module.exports = { createCheckoutToken, fetchOrder, sign, assertConfigured };
