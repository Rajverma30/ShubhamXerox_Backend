/**
 * ────────────────────────────────────────────────────────────────────────────
 *  The cart API GoKwik Checkout calls on us
 * ────────────────────────────────────────────────────────────────────────────
 *
 * GoKwik's checkout popup does not take prices from the browser. Once the
 * storefront opens it with a `merchantCheckoutId` (our CheckoutSession key),
 * GoKwik's servers call the endpoints below to read the cart, apply coupons,
 * record the address and finally place the order.
 *
 * The contract — paths, field names, status codes, even the error codes — is
 * the one implemented by GoKwik's open-source WooCommerce plugin
 * (kwikcheckout-woo v1.1.6, includes/api/class-gokwik-cart.php):
 *
 *   POST {prefix}/cart                          read the cart
 *   GET  {prefix}/cart/get-coupons              coupons to offer
 *   POST {prefix}/cart/apply-coupon
 *   POST {prefix}/cart/remove-coupon
 *   POST {prefix}/cart/set-address
 *   POST {prefix}/cart/set-shipping-method
 *   POST {prefix}/cart/remove-out-of-stock-items
 *   POST {prefix}/cart/place-order              → { id: <our order number> }
 *   POST {prefix}/cart/check-order-exists
 *   POST {prefix}/cart/update-order-status
 *   POST {prefix}/cart/get-wallet-balance       (no wallet here: always 0)
 *   POST {prefix}/cart/deduct-wallet-balance    (no wallet here: refused)
 *   POST {prefix}/cart/process-refund           refund webhook, no app headers
 *   POST {prefix}/cart/health-check             no app headers
 *
 * Errors are answered the way WordPress answers them — { code, message,
 * data: { status } } — because that is what the caller parses.
 */
const crypto = require('crypto');

const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const store = require('../services/gokwik/store');
const gokwik = require('../services/gokwik/api');
const {
  PLUGIN_VERSION, buildCart, evaluateCoupon, numericId, absoluteUrl, isDigital, salableQty,
  cleanPhone, toOrderAddress, fullName, fromWooStatus, rupees,
} = require('../services/gokwik/cart');

/* ───────────────────────────── helpers ───────────────────────────── */

/** WordPress reads a param from the JSON body, a form body or the query. */
const param = (req, name) => (req.body && req.body[name] !== undefined ? req.body[name] : req.query?.[name]);

const wpError = (res, status, code, message) =>
  res.status(status).json({ code, message, data: { status } });

const truthy = (v) => v === true || v === 1 || ['true', '1', 'yes'].includes(String(v).toLowerCase());

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArray = (v) => (Array.isArray(v) ? v : []);

/** Find the session or answer the error GoKwik expects. Returns null if answered. */
async function loadSession(req, res) {
  const key = param(req, 'session_key');
  if (!key) { wpError(res, 400, 'gc_missing_session_key', 'Session key is missing.'); return null; }
  const session = await store.getSession(key);
  if (!session) { wpError(res, 404, 'gc_cart_not_found', 'Cart not found.'); return null; }
  return session;
}

/**
 * Price the session's cart from the database. A coupon that has stopped being
 * valid (expired, cart fell under its minimum) is dropped from the session, as
 * the plugin does, so the customer is never charged against a stale discount.
 */
async function computeCart(session) {
  const ids = (session.items || []).map((i) => i.product);
  const [docs, coupons, settings] = await Promise.all([
    store.findProductsByIds(ids),
    store.findCoupons(session.coupons || []),
    store.getSettings(),
  ]);

  const who = { phone: cleanPhone(session.customer?.phone), email: session.customerEmail || session.customer?.email || '' };
  const customerUses = {};
  for (const c of coupons) {
    if (c.perCustomerLimit) customerUses[c.code] = await store.countCouponUses(c.code, who);
  }

  const products = new Map(docs.map((p) => [String(p._id), p]));
  const cart = buildCart({ session, products, coupons, settings, customerUses });

  if (cart.rejectedCoupons.length) {
    session.coupons = cart.appliedCoupons;
    await store.saveSession(session);
  }
  return { cart, settings, coupons };
}

/* ───────────────────────────── read ───────────────────────────── */

exports.getCart = asyncHandler(async (req, res) => {
  const session = await loadSession(req, res);
  if (!session) return undefined;
  const { cart } = await computeCart(session);
  if (!cart.lines.length) return wpError(res, 400, 'gc_cart_has_no_items', 'Cart is empty.');
  return res.status(200).json(cart.response);
});

exports.getCoupons = asyncHandler(async (req, res) => {
  const key = param(req, 'session_key');
  let cart = null;
  if (key) {
    const session = await store.getSession(key);
    if (!session) return wpError(res, 404, 'gc_cart_not_found', 'Cart not found.');
    ({ cart } = await computeCart(session));
  }

  const coupons = [];
  for (const c of await store.listSiteCoupons()) {
    const row = {
      code: String(c.code).toLowerCase(),
      amount: Number(c.value) || 0,
      discount_type: c.type === 'percent' ? 'percent' : 'fixed_cart',
      description: c.description || '',
    };
    if (cart) {
      // With a cart in hand, only offer coupons that would actually apply.
      const verdict = evaluateCoupon(c, cart.lines);
      if (!verdict.ok) continue;
      row.amount = Number(verdict.discount).toFixed(2);
      row.discount_value = Number(c.value) || 0;
    }
    coupons.push(row);
  }
  return res.status(200).json({ coupons });
});

/* ───────────────────────────── coupons ───────────────────────────── */

exports.applyCoupon = asyncHandler(async (req, res) => {
  const code = String(param(req, 'coupon') || '').trim().toUpperCase();
  if (!code) return wpError(res, 400, 'gc_cart_coupon_is_required', 'Coupon code is required.');
  const session = await loadSession(req, res);
  if (!session) return undefined;

  const [coupon] = await store.findCoupons([code]);
  // The plugin answers these with HTTP 200 and an error body; GoKwik shows
  // the message to the customer rather than treating it as an outage.
  if (!coupon) return wpError(res, 200, 'gc_cart_coupon_does_not_exist', 'Coupon does not exist.');

  const before = await computeCart(session);
  const uses = coupon.perCustomerLimit
    ? await store.countCouponUses(code, { phone: cleanPhone(session.customer?.phone), email: session.customerEmail })
    : 0;
  const verdict = evaluateCoupon(coupon, before.cart.lines, { customerUses: uses });
  if (!verdict.ok) {
    const usage = /already used|fully redeemed/i.test(verdict.reason);
    return wpError(res, 200, usage ? 'gc_cart_coupon_invalid_usage' : 'gc_cart_coupon_invalid', verdict.reason || 'Coupon is not valid.');
  }

  session.coupons = [code]; // one coupon per order; a new one replaces the old
  await store.saveSession(session);

  const { cart } = await computeCart(session);
  return res.status(200).json({ message: 'Coupon was successfully added to cart.', cart: cart.response });
});

exports.removeCoupon = asyncHandler(async (req, res) => {
  const code = String(param(req, 'coupon') || '').trim().toUpperCase();
  if (!code) return wpError(res, 400, 'gc_cart_coupon_is_required', 'Coupon is required.');
  const session = await loadSession(req, res);
  if (!session) return undefined;

  session.coupons = (session.coupons || []).filter((c) => String(c).toUpperCase() !== code);
  await store.saveSession(session);

  const { cart } = await computeCart(session);
  return res.status(200).json({ message: 'Coupon was successfully removed from cart.', cart: cart.response });
});

/* ─────────────────────── address & delivery ─────────────────────── */

const ADDRESS_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country'];

exports.setAddress = asyncHandler(async (req, res) => {
  const session = await loadSession(req, res);
  if (!session) return undefined;

  let changed = false;
  const customer = { ...(session.customer || {}) };
  for (const field of ADDRESS_FIELDS) {
    const value = param(req, field);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      customer[field] = String(value).trim().slice(0, 200);
      changed = true;
    }
  }
  const email = param(req, 'customerEmail');
  if (email) { session.customerEmail = String(email).trim().slice(0, 200); changed = true; }

  if (changed) {
    session.customer = customer;
    await store.saveSession(session);
  }

  const { cart } = await computeCart(session);
  return res.status(200).json({
    message: changed ? 'Address successfully updated.' : 'No changes requested.',
    cart: cart.response,
  });
});

exports.setShippingMethod = asyncHandler(async (req, res) => {
  const session = await loadSession(req, res);
  if (!session) return undefined;

  const methods = param(req, 'shipping_methods');
  const list = (Array.isArray(methods) ? methods : [methods]).filter(Boolean).map((m) => String(m).slice(0, 60));
  if (!list.length) return res.status(200).json({ message: 'No changes requested.' });

  // There is one delivery option per cart, decided by buildCart(); the choice
  // is recorded but cannot change the charge.
  session.shippingMethods = list;
  await store.saveSession(session);

  const { cart } = await computeCart(session);
  return res.status(200).json({ message: 'Shipping method successfully updated.', cart: cart.response });
});

exports.removeOutOfStockItems = asyncHandler(async (req, res) => {
  const session = await loadSession(req, res);
  if (!session) return undefined;

  const docs = await store.findProductsByIds(session.items.map((i) => i.product));
  const byId = new Map(docs.map((p) => [String(p._id), p]));

  let changed = false;
  const kept = [];
  for (const item of session.items) {
    const p = byId.get(String(item.product));
    const available = p && p.isActive !== false && p.isHidden !== true ? salableQty(p) : 0;
    if (available <= 0) { changed = true; continue; }
    if (item.quantity > available) { changed = true; kept.push({ product: item.product, quantity: available }); continue; }
    kept.push({ product: item.product, quantity: item.quantity });
  }
  if (changed) {
    session.items = kept;
    await store.saveSession(session);
  }

  const { cart } = await computeCart(session);
  if (!cart.lines.length) return wpError(res, 400, 'gc_cart_has_no_items', 'Cart is empty.');
  return res.status(200).json({
    status: 'success',
    message: changed ? 'Out-of-stock items have been removed from the cart' : 'No out-of-stock items found in the cart',
    cart: cart.response,
  });
});

/* ───────────────────────────── wallet ───────────────────────────── */

exports.getWalletBalance = asyncHandler(async (_req, res) =>
  res.status(200).json({ customer_id: 0, wallet_balance: '0.00' }));

exports.deductWalletBalance = asyncHandler(async (_req, res) =>
  wpError(res, 400, 'gc_wallet_plugin_inactive', 'Wallet is not available on this store.'));

/* ─────────────────────────── place order ─────────────────────────── */

exports.placeOrder = asyncHandler(async (req, res) => {
  const session = await loadSession(req, res);
  if (!session) return undefined;

  /* GoKwik retries place-order when our answer is slow. The same session must
     always resolve to the same order — never a second one. */
  if (session.order) {
    const existing = await store.findOrderById(session.order);
    if (existing) return res.status(200).json({ id: existing.orderNumber });
  }

  const method = String(param(req, 'payment_method') || '').toLowerCase();
  if (!['gokwik_prepaid', 'wallet', 'cod'].includes(method)) {
    return wpError(res, 400, 'gc_cart_invalid_payment_method', 'Payment method is invalid.');
  }
  const isCod = method === 'cod';

  const { cart, settings } = await computeCart(session);
  if (!cart.lines.length) return wpError(res, 400, 'gc_cart_has_no_items', 'Cart is empty.');

  if (isCod && settings.codEnabled === false) {
    return wpError(res, 400, 'gc_cart_invalid_payment_method', 'Cash on delivery is not available.');
  }
  const short = cart.lines.find((l) => !l.inStock);
  if (short) {
    return wpError(res, 400, 'gc_cart_place_order_error', `"${short.product.title.slice(0, 60)}" is out of stock.`);
  }

  /* fees GoKwik adds on top of the cart: COD handling, prepaid discount … */
  const fees = asArray(param(req, 'fee_lines'))
    .map((f) => ({ name: String(f?.name || '').slice(0, 80), total: rupees(f?.total) }))
    .filter((f) => f.name && f.total !== 0);
  const feeTotal = fees.reduce((s, f) => s + f.total, 0);
  const total = rupees(cart.total + feeTotal);

  /* The amount GoKwik charged must be the amount we computed. If it is not,
     a price or coupon changed mid-checkout and the order must not be written. */
  const orderTotal = Number(param(req, 'order_total')) || 0;
  if (orderTotal !== 0 && Math.abs(total - orderTotal) > 0.01) {
    logger.warn(`GoKwik place-order total mismatch on session ${session.key.slice(0, 8)}…: ours ${total}, theirs ${orderTotal}`);
    return wpError(res, 400, 'gc_cart_total_mismatch', 'Cart total does not match the order total.');
  }

  const billing = asObject(param(req, 'billing'));
  const shipping = asObject(param(req, 'shipping'));
  const shippingAddress = toOrderAddress(shipping) || toOrderAddress(billing);
  const billingAddress = toOrderAddress(billing) || shippingAddress;
  const allDigital = cart.lines.every((l) => isDigital(l.product));
  if (!shippingAddress && !allDigital) {
    return wpError(res, 400, 'gc_cart_place_order_error', 'A complete delivery address with a 6-digit PIN code is required.');
  }

  const meta = {};
  for (const m of asArray(param(req, 'meta_data'))) {
    if (m && m.key) meta[String(m.key).replace(/[.$]/g, '_').slice(0, 80)] = m.value;
  }
  const gokwikOrderId = meta.gokwik_order_id ? String(meta.gokwik_order_id) : '';

  if (gokwikOrderId) {
    const dup = await store.findOrderByGokwikId(gokwikOrderId);
    if (dup) return res.status(200).json({ id: dup.orderNumber });
  }

  const paid = !isCod && truthy(param(req, 'set_paid'));
  const wooStatus = String(param(req, 'status') || '').toLowerCase();
  const transactionId = String(param(req, 'transaction_id') || '').slice(0, 120);
  const status = isCod || paid || wooStatus === 'processing' ? 'confirmed' : 'pending';

  const codCharges = rupees(fees.filter((f) => f.total > 0 && /cod|cash/i.test(f.name)).reduce((s, f) => s + f.total, 0));
  const prepaidDiscount = rupees(Math.abs(fees.filter((f) => f.total < 0).reduce((s, f) => s + f.total, 0)));

  const doc = {
    sessionKey: session.key,
    customer: {
      name: fullName(shipping) || fullName(billing),
      phone: cleanPhone(billing.phone || shipping.phone || session.customer?.phone),
      email: String(billing.email || session.customerEmail || '').slice(0, 200),
    },
    shippingAddress,
    billingAddress,
    items: cart.lines.map((l) => ({
      product: l.product._id,
      variantId: numericId(l.product._id),
      title: l.product.title,
      slug: l.product.slug,
      sku: l.product.sku,
      image: absoluteUrl(l.product.images?.[0]?.thumbUrl || l.product.images?.[0]?.url || ''),
      price: l.unit,
      mrp: l.mrp,
      quantity: l.quantity,
      lineTotal: l.lineSubtotal,
    })),
    subtotal: cart.subtotal,
    shippingCharge: cart.shipping,
    codCharges,
    discount: rupees(cart.discount + prepaidDiscount),
    couponDiscount: cart.discount,
    prepaidDiscount,
    couponCode: cart.appliedCoupons[0] || '',
    couponCodes: cart.appliedCoupons,
    fees,
    total,
    payment: {
      provider: 'gokwik',
      ...(gokwikOrderId ? { orderId: gokwikOrderId, platformOrderId: gokwikOrderId } : {}),
      type: isCod ? 'CASH_ON_DELIVERY' : 'PREPAID',
      method: method === 'wallet' ? 'wallet' : String(meta.payment_mode || meta.payment_method || ''),
      status: paid ? 'paid' : 'pending',
      checkoutStatus: wooStatus,
      transactionId,
      ...(paid ? { paidAt: new Date() } : {}),
    },
    status,
    source: String(meta._wc_order_attribution_utm_source || meta.utm_source || ''),
    raw: {
      meta,
      customer_ip: param(req, 'customer_ip') || '',
      customer_user_agent: String(param(req, 'customer_user_agent') || '').slice(0, 300),
      shipping_method: cart.shippingMethod?.method_id || '',
    },
  };

  let order;
  try {
    order = await store.createOrder(doc);
  } catch (err) {
    // Two place-order calls racing each other: the unique index on
    // payment.orderId lets exactly one through. Answer the loser with the
    // winner's order rather than an error.
    if (err && err.code === 11000) {
      const winner = (gokwikOrderId && await store.findOrderByGokwikId(gokwikOrderId)) || await store.findOrderBySession(session.key);
      if (winner) return res.status(200).json({ id: winner.orderNumber });
    }
    logger.error(`GoKwik place-order failed on session ${session.key.slice(0, 8)}…: ${err.message}`);
    return wpError(res, 400, 'gc_cart_place_order_error', 'Unable to create order.');
  }

  session.order = order._id;
  session.orderNumber = order.orderNumber;
  session.paymentMethod = method;
  await store.saveSession(session);

  if (order.status === 'confirmed') await confirmSideEffects(order);

  logger.info(`GoKwik order ${order.orderNumber} placed (${order.payment.type}, ${order.payment.status}, ₹${order.total})`);
  return res.status(200).json({ id: order.orderNumber });
});

/** Stock and coupon counters move once, the first time an order is confirmed. */
async function confirmSideEffects(order) {
  if (order.stockAdjusted) return;
  try {
    await store.adjustStock(order.items, -1);
    if (order.couponCode) await store.incrementCouponUse(order.couponCode, 1);
    order.stockAdjusted = true;
    await store.saveOrder(order);
  } catch (err) {
    logger.error(`Stock adjustment failed for ${order.orderNumber}: ${err.message}`);
  }

  // Preserve existing WhatsApp automation for confirmed GoKwik orders.
  try {
    const whatsapp = require('../services/whatsapp.service');
    const Order = require('../models/Order');
    whatsapp.sendOrderConfirmationWhatsApp(order).then((waRes) => {
      Order.updateOne(
        { _id: order._id },
        {
          $set: {
            'whatsappNotifications.orderConfirmedSent': waRes?.sent ?? false,
            'whatsappNotifications.orderConfirmedSentAt': new Date(),
            ...(waRes?.error ? { 'whatsappNotifications.lastError': waRes.error } : {}),
          },
        },
      ).catch((e) => logger.warn(`Failed updating WA confirmation status on ${order.orderNumber}: ${e.message}`));
    }).catch((e) => logger.warn(`Failed sending WA order confirmation for ${order.orderNumber}: ${e.message}`));
  } catch (err) {
    logger.warn(`WhatsApp hook unavailable for ${order.orderNumber}: ${err.message}`);
  }
}
exports.confirmSideEffects = confirmSideEffects;

/** Put stock back when a confirmed order is cancelled or fully refunded. */
async function releaseStock(order) {
  if (!order.stockAdjusted) return;
  try {
    await store.adjustStock(order.items, +1);
    if (order.couponCode) await store.incrementCouponUse(order.couponCode, -1);
    order.stockAdjusted = false;
    await store.saveOrder(order);
  } catch (err) {
    logger.error(`Restock failed for ${order.orderNumber}: ${err.message}`);
  }
}
exports.releaseStock = releaseStock;

/* ─────────────────────── after the order exists ─────────────────────── */

exports.checkOrderExists = asyncHandler(async (req, res) => {
  const key = String(param(req, 'session_key') || '');
  const email = String(param(req, 'customer_email') || '');
  if (!key || !email) return wpError(res, 400, 'gc_missing_required_parameters', 'Missing required parameters.');

  const order = await store.findOrderBySession(key);
  const recent = order && Date.now() - new Date(order.createdAt).getTime() < 60 * 60 * 1000;
  if (order && recent && order.status === 'confirmed' && order.payment?.type === 'PREPAID') {
    return res.status(200).json({ message: 'Order exists.', order_id: order.orderNumber });
  }
  return res.status(404).json({ message: 'No order found.' });
});

exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const ref = String(param(req, 'merchant_order_id') || '');
  const wooStatus = String(param(req, 'order_status') || '').toLowerCase();
  if (!ref || !wooStatus) return wpError(res, 400, 'gc_missing_required_parameters', 'Missing required parameters.');

  const order = await store.findOrderByNumber(ref);
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if (order.payment?.provider !== 'gokwik') {
    return wpError(res, 400, 'gc_invalid_order', 'The order is not a GoKwik order.');
  }

  const next = fromWooStatus(wooStatus);
  if (!next) return wpError(res, 400, 'gc_invalid_order_status', 'Invalid order status provided.');

  const old = order.status;
  // Never walk a shipped parcel back to "confirmed" on a late update.
  const advanced = ['packed', 'shipped', 'delivered'].includes(old) && ['pending', 'confirmed'].includes(next);
  if (!advanced && old !== next) {
    order.status = next;
    if (wooStatus.replace(/^wc-/, '') === 'refunded') order.payment.status = 'refunded';
    if (next === 'failed' && order.payment.status === 'pending') order.payment.status = 'failed';
    await store.saveOrder(order);
    if (next === 'confirmed') await confirmSideEffects(order);
    if (['cancelled', 'failed'].includes(next)) await releaseStock(order);
    logger.info(`GoKwik moved ${order.orderNumber}: ${old} → ${next}`);
  }

  return res.status(200).json({
    message: 'Order status updated successfully.',
    order_id: order.orderNumber,
    old_status: old,
    new_status: order.status,
  });
});

/**
 * POST {prefix}/cart/process-refund — GoKwik's refund webhook.
 *
 * It arrives without the app headers, so it is checked three ways instead:
 * the merchant id must be ours, the order must exist and be a GoKwik prepaid
 * order with the same transaction id, and the hmac must verify.
 *
 * GoKwik's Payment Webhooks (V3) document gives the refund hash as
 *   sha512("{merchantReferenceId}|{paymentId}|{amount}")
 * without saying whether the app secret keys it, so both the keyed and the
 * plain form are accepted. Set GOKWIK_REFUND_HMAC=off only if GoKwik confirms
 * a different formula and genuine refunds are being rejected.
 */
exports.processRefund = asyncHandler(async (req, res) => {
  const body = asObject(req.body);
  const data = asObject(body.data);
  const pick = (k) => (body[k] !== undefined ? body[k] : data[k]);

  const amount = Number(pick('amount'));
  const merchantId = String(pick('merchantId') || '');
  const event = String(pick('event') || '');
  const refundId = String(pick('refundId') || '');
  const reference = String(pick('merchantReferenceId') || '');
  const paymentId = String(pick('transactionPaymentId') || pick('paymentId') || '');
  const hmac = String(pick('hmac') || '');

  if (!amount || !merchantId) return wpError(res, 400, 'gc_missing_required_parameters', 'Required parameters are missing.');
  if (merchantId !== gokwik.config().mid) return wpError(res, 404, 'gc_merchant_id_not_found', 'Merchant ID not found.');
  if (!/^[a-f0-9]{128}$/i.test(hmac)) return wpError(res, 400, 'gc_invalid_hmac', 'Invalid hmac.');

  if (String(process.env.GOKWIK_REFUND_HMAC || 'on').toLowerCase() !== 'off') {
    const secret = gokwik.config().appSecret;
    const amounts = [...new Set([String(pick('amount')), String(amount), amount.toFixed(2)])];
    const matches = amounts.some((a) => {
      const text = `${reference}|${paymentId}|${a}`;
      const plain = crypto.createHash('sha512').update(text).digest('hex');
      const keyed = crypto.createHmac('sha512', secret).update(text).digest('hex');
      return [plain, keyed].some((h) => h.toLowerCase() === hmac.toLowerCase());
    });
    if (!matches) {
      logger.warn(`GoKwik refund webhook for ${reference}: hmac did not verify — ignored`);
      return wpError(res, 400, 'gc_invalid_hmac', 'Invalid hmac.');
    }
  }

  const order = await store.findOrderByGokwikId(reference);
  if (!order) return wpError(res, 404, 'gc_order_not_found', 'Order not found.');
  if (order.payment?.type !== 'PREPAID') {
    return wpError(res, 400, 'gc_invalid_payment_method', 'Refunds are only for GoKwik prepaid orders.');
  }
  if (order.payment.transactionId && paymentId && order.payment.transactionId !== paymentId) {
    return wpError(res, 400, 'gc_invalid_transaction', 'Invalid Transaction.');
  }

  const refunds = order.refunds || [];
  const seen = refunds.find((r) => r.refundId === refundId);
  if (seen && (seen.event === 'refund.successful' || event !== 'refund.successful')) {
    return res.status(200).json({ message: 'Refund processed in WooCommerce.' }); // duplicate delivery
  }

  const done = refunds.filter((r) => r.event === 'refund.successful').reduce((s, r) => s + r.amount, 0);
  if (amount + done > order.total + 0.01) {
    return wpError(res, 400, 'gc_refund_exceeds_total', 'Refund amount exceeds order total.');
  }

  if (seen) { seen.event = event; seen.at = new Date(); } else refunds.push({ refundId, amount, event, at: new Date() });
  order.refunds = refunds;
  order.markModified?.('refunds');

  const full = event === 'refund.successful' && Math.abs(order.total - (done + amount)) < 0.01;
  if (full) {
    order.payment.status = 'refunded';
    if (!['shipped', 'delivered'].includes(order.status)) order.status = 'cancelled';
  }
  await store.saveOrder(order);
  if (full && order.status === 'cancelled') await releaseStock(order);

  logger.info(`GoKwik refund ${refundId} (${event}) ₹${amount} on ${order.orderNumber}${full ? ' — fully refunded' : ''}`);
  // The wording is the plugin's; GoKwik may match on it.
  return res.status(200).json({ message: 'Refund processed in WooCommerce.' });
});

exports.healthCheck = asyncHandler(async (_req, res) =>
  res.status(200).json({
    status: 'success',
    message: 'API is operational.',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    platform: 'subham-xerox-node',
    plugin_version: PLUGIN_VERSION,
    node_version: process.version,
  }));

exports.computeCart = computeCart;
