/**
 * Calls we make TO GoKwik.
 *
 * Only one is needed for checkout itself: telling GoKwik when an order's
 * status or tracking number changes, so their dashboard and the customer's
 * WhatsApp updates stay in step with ours. The endpoint, headers and payload
 * are the ones GoKwik's WooCommerce plugin uses (gc_notify_order_update).
 *
 *   POST {base}v3/orders/update
 *   gk-app-id / gk-app-secret
 */
const axios = require('axios');
const logger = require('../../utils/logger');
const { gokwikStatusLabel } = require('./cart');

const BASES = {
  production: 'https://gkx.gokwik.co/',
  sandbox: 'https://api-gw-v4.dev.gokwik.io/sandbox/',
};

const SCRIPTS = {
  production: 'https://pdp.gokwik.co/v4/build/gokwik.js',
  sandbox: 'https://sandbox.pdp.gokwik.co/v4/build/gokwik.js',
};

function environment() {
  return String(process.env.GOKWIK_ENV || 'production').toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
}

function config() {
  const env = environment();
  return {
    environment: env,
    mid: String(process.env.GOKWIK_MID || '').trim(),
    appId: String(process.env.GOKWIK_APP_ID || '').trim(),
    appSecret: String(process.env.GOKWIK_APP_SECRET || '').trim(),
    apiBase: `${String(process.env.GOKWIK_API_BASE || BASES[env]).replace(/\/+$/, '')}/`,
    scriptUrl: process.env.GOKWIK_SCRIPT_URL || SCRIPTS[env],
  };
}

/** True when the three values GoKwik issues are all present. */
function configured() {
  const c = config();
  return Boolean(c.mid && c.appId && c.appSecret);
}

function enabled() {
  return String(process.env.GOKWIK_ENABLED ?? 'true').toLowerCase() !== 'false' && configured();
}

async function post(path, body) {
  const c = config();
  const res = await axios.post(`${c.apiBase}${path.replace(/^\/+/, '')}`, body, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json', 'gk-app-id': c.appId, 'gk-app-secret': c.appSecret },
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const msg = res.data?.error?.reference?.message || res.data?.error?.message || res.data?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`GoKwik ${path}: ${msg}`), { status: res.status, body: res.data });
  }
  return res.data;
}

/**
 * Tell GoKwik an order moved. Never throws: a GoKwik outage must not stop an
 * admin from marking a parcel as shipped.
 */
async function notifyOrderUpdate(order) {
  if (!enabled() || order?.payment?.provider !== 'gokwik') return null;

  const payload = { merchant_order_id: String(order.orderNumber) };
  const label = gokwikStatusLabel(order.status);
  if (label) payload.order_status = label;
  if (order.tracking?.courier && order.tracking?.awb) {
    payload.shipping_provider = order.tracking.courier;
    payload.awb_number = order.tracking.awb;
  }
  if (!payload.order_status && !payload.awb_number) return null;

  try {
    const data = await post('v3/orders/update', payload);
    logger.info(`GoKwik told about ${order.orderNumber} → ${payload.order_status || 'tracking only'}`);
    return data;
  } catch (err) {
    logger.warn(`GoKwik order update failed for ${order.orderNumber}: ${err.message}`);
    return null;
  }
}

module.exports = { config, configured, enabled, environment, notifyOrderUpdate, post, BASES, SCRIPTS };
