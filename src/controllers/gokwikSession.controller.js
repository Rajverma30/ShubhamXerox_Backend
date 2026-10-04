/**
 * Storefront opens a GoKwik checkout session.
 *
 * POST /api/checkout/session
 *   body: { items: [{ productId|id|slug|sku, quantity }] }
 *   → { sessionKey, mid, environment, scriptUrl }
 *
 * Prices never leave this server through the browser. The returned sessionKey
 * becomes merchantCheckoutId for gokwikSdk.initCheckout; GoKwik's servers then
 * call /wp-json/gokwik/v1/cart/… with App ID + App Secret.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/response');
const gokwik = require('../services/gokwik/api');
const store = require('../services/gokwik/store');
const Setting = require('../models/Setting');

exports.createSession = asyncHandler(async (req, res) => {
  const settings = await Setting.getSingleton();
  if (settings?.checkout?.mode !== 'gokwik') {
    throw ApiError.badRequest('GoKwik checkout is not the active checkout provider.');
  }
  if (!gokwik.enabled()) {
    throw ApiError.badRequest(
      'Online checkout is not set up yet. Ask the store to configure GoKwik credentials on the server.',
    );
  }

  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rawItems.length) throw ApiError.badRequest('Cart is empty.');

  const keys = [];
  const qtyByKey = new Map();
  for (const row of rawItems) {
    const key = String(row.productId || row.id || row._id || row.slug || row.sku || '').trim();
    if (!key) continue;
    const qty = Math.max(1, Math.min(Number(row.quantity) || 1, 99));
    keys.push(key);
    qtyByKey.set(key, (qtyByKey.get(key) || 0) + qty);
  }
  if (!keys.length) throw ApiError.badRequest('Cart is empty.');

  const products = await store.findProductsByKeys([...new Set(keys)]);
  if (!products.length) throw ApiError.badRequest('None of the items in your cart are available.');

  const byId = new Map(products.map((p) => [String(p._id), p]));
  const bySlug = new Map(products.map((p) => [String(p.slug), p]));
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [String(p.sku), p]));

  const items = [];
  for (const [key, qty] of qtyByKey) {
    const product = byId.get(key) || bySlug.get(key) || bySku.get(key);
    if (!product) continue;
    items.push({ product: product._id, quantity: Math.min(qty, 99) });
  }
  if (!items.length) throw ApiError.badRequest('None of the items in your cart are available.');

  const session = await store.createSession({ items, coupons: [] });
  const cfg = gokwik.config();

  return ok(res, {
    sessionKey: session.key,
    mid: cfg.mid,
    environment: cfg.environment,
    scriptUrl: cfg.scriptUrl,
  });
});
