/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Guest checkout — OTP → address → Razorpay. Prepaid only.
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   POST /api/checkout/quote     items + pincode → subtotal, shipping, total
 *   POST /api/checkout/order     [guest token] create order + Razorpay order
 *   POST /api/checkout/verify    [guest token] confirm payment signature
 *   POST /api/webhooks/razorpay  server-side truth, independent of the browser
 *   GET  /api/orders/:number     receipt lookup (needs the matching phone)
 *
 * THE RULE THAT MATTERS: the browser never sets a price. Every total is
 * recomputed here from the database. The cart is a list of ids and quantities
 * and nothing more — anything else it claims is ignored.
 */
const mongoose = require('mongoose');
const axios = require('axios');

const Product = require('../models/Product');
const Order = require('../models/Order');
const Setting = require('../models/Setting');
const GuestCheckoutSession = require('../models/GuestCheckoutSession');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/response');
const logger = require('../utils/logger');
const { sellingPrice } = require('../utils/pricing');
const razorpay = require('../services/razorpay.service');
const shiprocket = require('../services/shiprocket.service');
const whatsapp = require('../services/whatsapp.service');

function normalisePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  let ten = digits;
  if (digits.length > 10) {
    if (digits.length === 12 && digits.startsWith('91')) {
      ten = digits.slice(2);
    } else if (digits.length === 11 && digits.startsWith('0')) {
      ten = digits.slice(1);
    } else {
      ten = digits.slice(-10);
    }
  }
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

const PLACEHOLDER_PINCODES = new Set(['YOUR_REAL_PINCODE', '000000', '123456']);

function validStorePincode() {
  const pin = String(process.env.STORE_PINCODE || '').trim();
  return /^\d{6}$/.test(pin) && !PLACEHOLDER_PINCODES.has(pin);
}

function expectedAmountPaisa(order) {
  return order.payment?.amountPaisa || Math.round(Number(order.total) * 100);
}

async function decrementStockForOrder(order) {
  for (const item of order.items) {
    const product = await Product.findById(item.product).select('type allowBackorder stock title').lean();
    if (!product) continue;

    if (product.type === 'ebook') {
      await Product.updateOne({ _id: item.product }, { $inc: { soldCount: item.quantity } });
      continue;
    }

    const currentStock = Number(product.stock ?? 10);
    const newStock = Math.max(3, currentStock - item.quantity);
    await Product.updateOne(
      { _id: item.product },
      { stock: newStock, $inc: { soldCount: item.quantity } }
    );
  }
}

/* ─────────────────────────── pricing core ─────────────────────────── */

/**
 * Resolve a client cart into priced lines, straight from the database.
 * @returns {{lines:Array, subtotal:number, weight:number, problems:Array}}
 */
async function priceCart(rawItems = []) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw ApiError.badRequest('Your cart is empty');
  if (rawItems.length > 50) throw ApiError.badRequest('Too many items in one order');

  const keys = rawItems.map((i) => String(i.productId || i.id || i.slug || i.sku || '')).filter(Boolean);
  if (!keys.length) throw ApiError.badRequest('Cart items are missing product identifiers');

  const ids = keys.filter((k) => mongoose.isValidObjectId(k));
  const docs = await Product.find({
    $or: [{ _id: { $in: ids } }, { slug: { $in: keys } }, { sku: { $in: keys } }],
    isActive: true,
    isHidden: false,
  }).select('_id title slug sku images price salePrice discountPercent stock allowBackorder type weight').lean();

  const byKey = new Map();
  docs.forEach((p) => {
    byKey.set(String(p._id), p);
    if (p.slug) byKey.set(p.slug, p);
    if (p.sku) byKey.set(p.sku, p);
  });

  const lines = [];
  const problems = [];
  let subtotal = 0;
  let weight = 0;

  for (const raw of rawItems) {
    const key = String(raw.productId || raw.id || raw.slug || raw.sku || '');
    const p = byKey.get(key);
    if (!p) { problems.push(`An item is no longer available`); continue; }

    const qty = Math.max(1, Math.min(Number(raw.quantity) || 1, 99));
    const digital = p.type === 'ebook';
    if (!digital && !p.allowBackorder && (p.stock ?? 0) < qty) {
      problems.push(`"${p.title.slice(0, 40)}" — only ${p.stock ?? 0} left`);
      continue;
    }

    const unit = sellingPrice(p);
    const lineTotal = unit * qty;
    subtotal += lineTotal;
    weight += (p.weight || 0.4) * (digital ? 0 : qty);

    lines.push({
      product: p._id,
      title: p.title,
      slug: p.slug,
      sku: p.sku,
      image: p.images?.[0]?.thumbUrl || p.images?.[0]?.url || '',
      price: unit,
      mrp: Number(p.price) || unit,
      quantity: qty,
      lineTotal,
    });
  }

  if (!lines.length) {
    throw ApiError.badRequest(problems[0] || 'None of the items in your cart could be found');
  }
  return { lines, subtotal, weight: Math.max(weight, 0.1), problems };
}

/**
 * Delivery charge for a pincode, from Shiprocket's live courier rates.
 *
 * Falls back to the flat rate in Settings when Shiprocket is unreachable or
 * has no credentials. A checkout must never die because a rate lookup timed
 * out — the customer would simply leave.
 */
async function shippingFor({ pincode, weight, declaredValue }) {
  const settings = await Setting.getSingleton();
  const flat = Number(settings.shippingFlat) || 0;
  const freeAbove = Number(settings.freeShippingAbove) || 0;

  if (freeAbove && declaredValue >= freeAbove) {
    return { charge: 0, courier: null, etd: '3–5 days', serviceable: true, reason: 'free-above-threshold' };
  }

  if (!shiprocket.credentialsPresent() || !validStorePincode()) {
    return { charge: flat, courier: null, etd: '3–5 days', serviceable: true, reason: 'flat-fallback' };
  }

  try {
    const data = await shiprocket.checkServiceability({
      deliveryPincode: pincode,
      weight,
      cod: 0,                       // prepaid only
      declaredValue,
    });

    return {
      charge: Math.ceil(data.cheapest?.rate ?? flat),
      courier: data.cheapest?.name || 'Express Shipping',
      etd: data.etd || '3–5 days',
      serviceable: true,
      reason: 'shiprocket',
    };
  } catch (err) {
    logger.warn(`Serviceability lookup failed for ${pincode}, using flat rate: ${err.message}`);
    return { charge: flat, courier: null, etd: '3–5 days', serviceable: true, reason: 'flat-fallback' };
  }
}

/* ─────────────────────────────── quote ─────────────────────────────── */

/** POST /api/checkout/quote  { items, pincode } */
exports.quote = asyncHandler(async (req, res) => {
  const { lines, subtotal, weight, problems } = await priceCart(req.body.items);

  const pincode = String(req.body.pincode || '').trim();
  let shipping = { charge: 0, courier: null, etd: '3–5 days', serviceable: true, reason: 'no-pincode' };
  if (/^\d{6}$/.test(pincode)) {
    shipping = await shippingFor({ pincode, weight, declaredValue: subtotal });
  }

  return ok(res, {
    items: lines,
    subtotal,
    shippingCharge: shipping.charge,
    total: subtotal + shipping.charge,
    shipping,
    problems,
  });
});

/* ──────────────────────────── create order ──────────────────────────── */

/**
 * POST /api/checkout/order   (guest token required)
 * body: { items, customer:{name,email}, address:{...} }
 * → { orderNumber, razorpayOrderId, amount, keyId }
 */
exports.createOrder = asyncHandler(async (req, res) => {
  const phone = req.guestPhone;                       // set by guestAuth middleware
  const { lines, subtotal, weight, problems } = await priceCart(req.body.items);

  if (problems.length) {
    throw ApiError.badRequest(problems[0] || 'Some items in your cart are unavailable');
  }

  const a = req.body.address || {};
  const pincode = String(a.pincode || '').trim();
  if (!/^\d{6}$/.test(pincode)) throw ApiError.badRequest('Enter a valid 6-digit PIN code');
  if (!a.address || !a.city || !a.state) throw ApiError.badRequest('Please complete the delivery address');

  const name = String(req.body.customer?.name || '').trim();
  if (name.length < 2) throw ApiError.badRequest('Please enter your name');

  const shipping = await shippingFor({ pincode, weight, declaredValue: subtotal });

  const total = subtotal + shipping.charge;

  const order = new Order({
    customer: { name, phone, email: String(req.body.customer?.email || '').trim() },
    shippingAddress: {
      address: a.address,
      address2: a.address2 || '',
      landmark: a.landmark || '',
      city: a.city,
      district: a.district || '',
      state: a.state,
      pincode,
      country: 'India',
    },
    items: lines,
    subtotal,
    shippingCharge: shipping.charge,
    total,
    status: 'awaiting-payment',
  });

  // Save first: an order that exists without a payment is recoverable, a
  // payment that exists without an order is a support ticket.
  await order.save();

  const rzp = await razorpay.createOrder(total, order.orderNumber, {
    orderNumber: order.orderNumber,
    phone,
  });

  order.payment.razorpayOrderId = rzp.id;
  order.payment.amountPaisa = rzp.amount;
  await order.save();

  if (req.guestJti) {
    const session = await GuestCheckoutSession.findOne({ jti: req.guestJti, phone });
    if (!session || session.expiresAt < new Date()) {
      throw ApiError.unauthorized('Your checkout session expired. Please verify your number again.');
    }
    session.consumedAt = session.consumedAt || new Date();
    session.orderNumber = order.orderNumber;
    await session.save();
  }

  logger.info(`Order ${order.orderNumber} created — ₹${total} (${lines.length} lines) → ${rzp.id}`);

  // Send WhatsApp awaiting-payment notification after 20 seconds delay ONLY if order is still unpaid
  setTimeout(async () => {
    try {
      const latestOrder = await Order.findById(order._id);
      if (!latestOrder) return;

      // If customer completed payment within 20 seconds, skip sending pending notification
      if (latestOrder.payment?.status === 'paid') {
        logger.info(`Skipping WA awaiting-payment for ${latestOrder.orderNumber}: Order is already PAID`);
        return;
      }

      const waRes = await whatsapp.sendPaymentPendingWhatsApp(latestOrder);
      await Order.updateOne(
        { _id: latestOrder._id },
        {
          $set: {
            'whatsappNotifications.awaitingPaymentSent': waRes?.sent ?? false,
            'whatsappNotifications.awaitingPaymentSentAt': new Date(),
            ...(waRes?.error ? { 'whatsappNotifications.lastError': waRes.error } : {}),
          },
        }
      );
    } catch (e) {
      logger.warn(`Failed sending delayed WA payment pending for ${order.orderNumber}: ${e.message}`);
    }
  }, 20000);

  return created(res, {
    orderNumber: order.orderNumber,
    razorpayOrderId: rzp.id,
    amount: rzp.amount,             // paise, for the Razorpay widget
    currency: 'INR',
    keyId: razorpay.publicKey(),    // publishable id, safe in the browser
    subtotal,
    shippingCharge: shipping.charge,
    total,
    customer: { name, phone, email: order.customer.email },
  });
});

/* ───────────────────────── confirm payment ───────────────────────── */

/** Mark paid + decrement stock, exactly once. Shared by verify and webhook. */
async function markPaid(orderRef, { paymentId, signature, method, amountPaisa, raw }) {
  const orderId = orderRef._id || orderRef;
  const existing = await Order.findById(orderId);
  if (!existing) throw ApiError.notFound('Order not found');
  if (existing.payment.status === 'paid') return existing;

  const expected = expectedAmountPaisa(existing);
  if (amountPaisa != null && Number(amountPaisa) !== expected) {
    logger.warn(`Payment amount mismatch on ${existing.orderNumber}: got ${amountPaisa}, expected ${expected}`);
    throw ApiError.badRequest('Payment amount does not match the order total');
  }

  const paidAt = new Date();
  const paymentUpdate = {
    'payment.razorpayPaymentId': paymentId,
    'payment.status': 'paid',
    'payment.paidAt': paidAt,
    status: 'confirmed',
  };
  if (signature) paymentUpdate['payment.razorpaySignature'] = signature;
  if (method) paymentUpdate['payment.method'] = method;
  if (amountPaisa != null) paymentUpdate['payment.amountPaisa'] = Number(amountPaisa);
  if (raw) paymentUpdate.raw = raw;

  const transitioned = await Order.findOneAndUpdate(
    { _id: existing._id, 'payment.status': { $ne: 'paid' } },
    { $set: paymentUpdate },
    { new: true },
  );
  if (!transitioned) return Order.findById(existing._id);

  const stockLock = await Order.findOneAndUpdate(
    { _id: transitioned._id, stockAdjusted: { $ne: true } },
    { $set: { stockAdjusted: true } },
    { new: true },
  );
  if (stockLock) await decrementStockForOrder(stockLock);

  logger.info(`Order ${transitioned.orderNumber} PAID ₹${transitioned.total} via ${method || 'razorpay'}`);

  // Send WhatsApp order confirmation greeting
  whatsapp.sendOrderConfirmationWhatsApp(transitioned).then((waRes) => {
    Order.updateOne(
      { _id: transitioned._id },
      {
        $set: {
          'whatsappNotifications.orderConfirmedSent': waRes?.sent ?? false,
          'whatsappNotifications.orderConfirmedSentAt': new Date(),
          ...(waRes?.error ? { 'whatsappNotifications.lastError': waRes.error } : {}),
        },
      }
    ).catch((e) => logger.warn(`Failed updating WA confirmation status on ${transitioned.orderNumber}: ${e.message}`));
  }).catch((e) => logger.warn(`Failed sending WA order confirmation greeting for ${transitioned.orderNumber}: ${e.message}`));

  // Auto-push to Shiprocket — PAID orders only.
  try {
    const Setting = require('../models/Setting');
    const settings = await Setting.getSingleton();
    const isPaid = transitioned.payment?.status === 'paid';
    if (settings?.shiprocketAutoPush && isPaid && !transitioned.shiprocket?.orderId) {
      const shiprocket = require('../services/shiprocket.service');
      const srRes = await shiprocket.createAdhocOrder(transitioned);
      if (!srRes.order_id || !srRes.shipment_id) {
        throw new Error('Shiprocket returned no order/shipment id');
      }
      transitioned.shiprocket = {
        orderId: String(srRes.order_id),
        shipmentId: String(srRes.shipment_id),
        awb: String(srRes.awb_code || ''),
        status: srRes.status || 'CREATED',
        channelOrderId: srRes.channelOrderId || '',
        pushedAt: new Date(),
        error: null,
      };
      if (!transitioned.tracking) transitioned.tracking = {};
      if (srRes.awb_code) {
        transitioned.tracking.awb = srRes.awb_code;
        transitioned.tracking.courier = srRes.courier_name || 'Shiprocket';
      }
      await transitioned.save();
      logger.info(`Auto-pushed paid order ${transitioned.orderNumber} to Shiprocket (SR #${srRes.order_id}).`);
    } else if (settings?.shiprocketAutoPush && !isPaid) {
      logger.info(`Skipping Shiprocket auto-push for ${transitioned.orderNumber}: payment not paid`);
    }
  } catch (srErr) {
    logger.warn(`Failed auto-pushing order ${transitioned.orderNumber} to Shiprocket: ${srErr.message}`);
    try {
      transitioned.shiprocket = transitioned.shiprocket || {};
      transitioned.shiprocket.error = String(srErr.message || 'auto-push failed').slice(0, 500);
      await transitioned.save();
    } catch (_) { /* ignore */ }
  }

  return transitioned;
}

/**
 * POST /api/checkout/verify   (guest token required)
 * body: { orderNumber, razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
exports.verifyPayment = asyncHandler(async (req, res) => {
  const { orderNumber, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const order = await Order.findOne({ orderNumber });
  if (!order) throw ApiError.notFound('Order not found');

  const guestPhoneNorm = String(req.guestPhone || '').replace(/\D/g, '').slice(-10);
  const orderPhoneNorm = String(order.customer?.phone || '').replace(/\D/g, '').slice(-10);
  if (guestPhoneNorm && orderPhoneNorm && guestPhoneNorm !== orderPhoneNorm) {
    throw ApiError.unauthorized('Order does not match your verified session');
  }

  if (order.payment.razorpayOrderId && order.payment.razorpayOrderId !== razorpay_order_id) {
    throw ApiError.badRequest('Payment does not match this order');
  }

  const valid = razorpay.verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
  if (!valid) {
    logger.warn(`Bad Razorpay signature on ${orderNumber} — refusing to confirm`);
    order.payment.status = 'failed';
    await order.save();
    throw ApiError.badRequest('We could not verify this payment. If money was deducted it will be refunded automatically.');
  }

  const updated = await markPaid(order, {
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
    amountPaisa: order.payment.amountPaisa,
    raw: { source: 'browser-verify', body: req.body },
  });

  return ok(res, {
    orderNumber: updated.orderNumber,
    status: updated.status,
    total: updated.total,
    paid: true,
  });
});

/**
 * POST /api/webhooks/razorpay
 *
 * The browser can close mid-redirect, so this is the reliable path. Razorpay
 * signs the raw body; anything unsigned is ignored outright.
 */
exports.razorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);

  if (!razorpay.verifyWebhookSignature(raw, signature)) {
    logger.warn(`Razorpay webhook with bad/missing signature from ${req.ip}`);
    return res.status(400).json({ ok: false });
  }

  const event = String(req.body?.event || '');
  const paymentEntity = req.body?.payload?.payment?.entity;
  const orderEntity = req.body?.payload?.order?.entity;

  try {
    if (['payment.captured', 'order.paid', 'payment.authorized'].includes(event)) {
      const razorpayOrderId = paymentEntity?.order_id || orderEntity?.id;
      const paymentId = paymentEntity?.id || orderEntity?.id;
      const amountPaisa = paymentEntity?.amount || orderEntity?.amount_paid || orderEntity?.amount;

      if (razorpayOrderId) {
        const order = await Order.findOne({ 'payment.razorpayOrderId': razorpayOrderId });
        if (order) {
          await markPaid(order, {
            paymentId: paymentId || razorpayOrderId,
            method: paymentEntity?.method || 'online',
            amountPaisa,
            raw: { source: 'webhook', event, body: req.body },
          });
        } else {
          logger.warn(`Razorpay webhook for unknown order ${razorpayOrderId}`);
        }
      }
    } else if (event === 'payment.failed') {
      const razorpayOrderId = paymentEntity?.order_id || orderEntity?.id;
      if (razorpayOrderId) {
        await Order.updateOne(
          { 'payment.razorpayOrderId': razorpayOrderId, 'payment.status': { $ne: 'paid' } },
          { 'payment.status': 'failed' },
        );
      }
    }
  } catch (err) {
    logger.error(`Razorpay webhook handling failed: ${err.message}`);
  }

  // Always 200 once the signature is good, or Razorpay retries forever.
  return res.json({ ok: true });
});

/* ───────────────────────────── receipt ───────────────────────────── */

/**
 * GET /api/orders/:orderNumber?phone=98XXXXXXXX
 * Order numbers are guessable enough that the phone is required as a check.
 */
exports.getOrder = asyncHandler(async (req, res) => {
  const rawPhone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
  let order = await Order.findOne({ orderNumber: req.params.orderNumber }).lean();

  if (!order && String(req.params.orderNumber).startsWith('SXSR-')) {
    const ShiprocketCheckoutSession = require('../models/ShiprocketCheckoutSession');
    const shiprocketCtrl = require('./shiprocketSession.controller');
    const session = await ShiprocketCheckoutSession.findOne({ orderId: req.params.orderNumber });
    if (session) {
      const createdOrder = await shiprocketCtrl.confirmOrderFromSession(session, { source: 'receipt-lookup' });
      if (createdOrder) order = createdOrder.toObject ? createdOrder.toObject() : createdOrder;
    }
  }

  if (!order) throw ApiError.notFound('Order not found');
  const orderPhone = String(order.customer?.phone || '').replace(/\D/g, '').slice(-10);
  if (rawPhone && orderPhone && orderPhone !== rawPhone) throw ApiError.notFound('Order not found');

  // Real-time auto-reconcile with Razorpay if order is still awaiting payment
  if (order.payment?.status !== 'paid' && razorpay.isConfigured()) {
    if (order.payment?.razorpayOrderId) {
      try {
        const auth = 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
        const { data } = await axios.get(`https://api.razorpay.com/v1/orders/${order.payment.razorpayOrderId}/payments`, {
          headers: { Authorization: auth },
          timeout: 4000,
        });
        const captured = (data.items || []).find(p => p.status === 'captured');
        if (captured) {
          const updated = await markPaid(order, {
            paymentId: captured.id,
            method: captured.method || 'online',
            amountPaisa: captured.amount,
            raw: { source: 'get-order-auto-reconcile', payment: captured },
          });
          if (updated) order = updated.toObject ? updated.toObject() : updated;
        }
      } catch (err) {
        // Silently skip if Razorpay API check fails
      }
    } else if (!order.payment?.razorpayOrderId) {
      try {
        const rzp = await razorpay.createOrder(order.total, order.orderNumber, {
          orderNumber: order.orderNumber,
          phone: order.customer?.phone,
        });
        await Order.updateOne(
          { _id: order._id },
          { $set: { 'payment.razorpayOrderId': rzp.id, 'payment.amountPaisa': rzp.amount } }
        );
        order.payment = order.payment || {};
        order.payment.razorpayOrderId = rzp.id;
        order.payment.amountPaisa = rzp.amount;
      } catch (err) {
        logger.warn(`Failed auto-generating Razorpay order ID for ${order.orderNumber}: ${err.message}`);
      }
    }
  }

  const resData = { ...order, keyId: razorpay.publicKey() };
  return ok(res, resData);
});

/**
 * GET /api/orders/lookup/by-phone?phone=98XXXXXXXX
 * Returns all orders matching the phone number, with real-time Razorpay reconciliation.
 */
exports.getOrdersByPhone = asyncHandler(async (req, res) => {
  const queryVal = String(req.query.phone || req.query.q || '').trim();
  if (!queryVal || queryVal.length < 2) {
    throw ApiError.badRequest('Enter a valid mobile number or customer name');
  }

  const phoneDigits = queryVal.replace(/\D/g, '');
  let filter = {};

  if (phoneDigits.length >= 10) {
    const norm = normalisePhone(queryVal) || phoneDigits.slice(-10);
    filter = { 'customer.phone': new RegExp(norm + '$') };
  } else {
    const searchRegex = new RegExp(queryVal, 'i');
    filter = {
      $or: [
        { 'customer.name': searchRegex },
        { 'customer.email': searchRegex },
        { 'shippingAddress.name': searchRegex },
        { orderNumber: searchRegex },
      ],
    };
  }

  const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();

  if (razorpay.isConfigured()) {
    const pendingOrders = orders.filter(o => o.payment?.status !== 'paid' && o.payment?.razorpayOrderId);
    await Promise.all(pendingOrders.map(async (order) => {
      try {
        const auth = 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
        const { data } = await axios.get(`https://api.razorpay.com/v1/orders/${order.payment.razorpayOrderId}/payments`, {
          headers: { Authorization: auth },
          timeout: 4000,
        });
        const captured = (data.items || []).find(p => p.status === 'captured');
        if (captured) {
          const updated = await markPaid(order, {
            paymentId: captured.id,
            method: captured.method || 'online',
            amountPaisa: captured.amount,
            raw: { source: 'by-phone-auto-reconcile', payment: captured },
          });
          if (updated) {
            order.payment = order.payment || {};
            order.payment.status = 'paid';
            order.payment.razorpayPaymentId = captured.id;
            order.payment.method = captured.method || 'online';
            order.status = 'confirmed';
          }
        }
      } catch (err) {
        // Silently skip
      }
    }));
  }

  const itemsWithKey = orders.map(o => ({ ...o, keyId: razorpay.publicKey() }));
  return ok(res, itemsWithKey);
});

/* ─────────────────────────── admin (orders) ─────────────────────────── */

exports.adminListOrders = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  if (req.query.source === 'shiprocket') {
    const shiprocketFilter = {};
    if (req.query.q) {
      const searchRegex = new RegExp(String(req.query.q).trim(), 'i');
      shiprocketFilter.$or = [
        { phone: new RegExp(String(req.query.q).replace(/\D/g, ''), 'i') },
        { 'customer.name': searchRegex },
        { 'customer.email': searchRegex },
        { 'shippingAddress.name': searchRegex },
      ];
    }
    const [rawSessions, total] = await Promise.all([
      GuestCheckoutSession.find(shiprocketFilter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      GuestCheckoutSession.countDocuments(shiprocketFilter),
    ]);

    const items = rawSessions.map(s => {
      const isPaid = s.status === 'paid';
      const itemsList = (s.cartSnapshot || []).map(i => ({
        title: i.title || 'Product',
        quantity: i.quantity || 1,
        price: i.price || 0,
        lineTotal: (i.price || 0) * (i.quantity || 1),
      }));
      const subtotal = itemsList.reduce((acc, i) => acc + i.lineTotal, 0);

      return {
        _id: s._id,
        total: s.subtotal,
        payment: {
          provider: 'shiprocket-checkout',
          status: s.status === 'paid' ? 'paid' : s.status === 'failed' ? 'failed' : 'created',
        },
        status: s.status === 'paid' ? 'confirmed' : 'awaiting-payment',
        createdAt: s.createdAt,
        isShiprocketSession: true,
      };
    });

    return ok(res, {
      items, total, page, pages: Math.ceil(total / limit), paidRevenue: 0,
    });
  }

  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.paymentStatus) filter['payment.status'] = req.query.paymentStatus;
  if (req.query.q) {
    const rawQ = String(req.query.q).trim();
    const digits = rawQ.replace(/\D/g, '');
    const searchRegex = new RegExp(rawQ, 'i');

    const orConditions = [
      { orderNumber: searchRegex },
      { 'customer.name': searchRegex },
      { 'customer.email': searchRegex },
      { 'shippingAddress.name': searchRegex },
      { 'shippingAddress.address': searchRegex },
      { 'shippingAddress.city': searchRegex },
      { 'shippingAddress.state': searchRegex },
      { 'shippingAddress.pincode': searchRegex },
    ];

    if (digits.length >= 3) {
      orConditions.push({ 'customer.phone': new RegExp(digits, 'i') });
    }

    filter.$or = orConditions;
  }

  const [items, total, revenue] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
    Order.aggregate([{ $match: { 'payment.status': 'paid' } }, { $group: { _id: null, sum: { $sum: '$total' } } }]),
  ]);

  // Auto-reconcile pending Razorpay orders with Razorpay API
  if (razorpay.isConfigured()) {
    const pendingOrders = items.filter(o => !o.isShiprocketSession && o.payment?.status !== 'paid' && o.payment?.razorpayOrderId);
    await Promise.all(pendingOrders.map(async (order) => {
      try {
        const auth = 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
        const { data } = await axios.get(`https://api.razorpay.com/v1/orders/${order.payment.razorpayOrderId}/payments`, {
          headers: { Authorization: auth },
          timeout: 4000,
        });
        const captured = (data.items || []).find(p => p.status === 'captured');
        if (captured) {
          const updated = await markPaid(order, {
            paymentId: captured.id,
            method: captured.method || 'online',
            amountPaisa: captured.amount,
            raw: { source: 'auto-reconcile', payment: captured },
          });
          if (updated) {
            order.payment = order.payment || {};
            order.payment.status = 'paid';
            order.payment.razorpayPaymentId = captured.id;
            order.payment.method = captured.method || 'online';
            order.status = 'confirmed';
          }
        }
      } catch (err) {
        // Silently skip if Razorpay API fails for a specific order
      }
    }));
  }

  return ok(res, {
    items, total, page, pages: Math.ceil(total / limit),
    paidRevenue: revenue[0]?.sum || 0,
  });
});

exports.adminGetOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const isObjectId = mongoose.isValidObjectId(id);

  let doc = null;

  if (isObjectId) {
    doc = await Order.findById(id).populate('items.product', 'title slug images').lean();
  }
  if (!doc) {
    doc = await Order.findOne({ orderNumber: id }).populate('items.product', 'title slug images').lean();
  }

  if (!doc) {
    const ShiprocketCheckoutSession = require('../models/ShiprocketCheckoutSession');
    let session = null;
    if (isObjectId) {
      session = await ShiprocketCheckoutSession.findById(id).lean();
    }
    if (!session) {
      session = await ShiprocketCheckoutSession.findOne({ orderId: id }).lean();
    }

    if (session) {
      const realOrder = await Order.findOne({ orderNumber: session.orderId }).populate('items.product', 'title slug images').lean();
      if (realOrder) {
        doc = realOrder;
      } else {
        const rawCust = session.raw?.customer || session.raw?.shipping_address || session.raw?.customer_details || {};
        doc = {
          _id: session._id,
          orderNumber: session.orderId,
          customer: {
            name: session.customer?.name || rawCust.name || (rawCust.first_name ? `${rawCust.first_name || ''} ${rawCust.last_name || ''}`.trim() : '') || 'Guest (Checkout Initiated)',
            phone: session.customer?.phone || rawCust.phone || rawCust.mobile || 'Via Fastrr',
            email: session.customer?.email || rawCust.email || '',
          },
          shippingAddress: session.shippingAddress?.address ? session.shippingAddress : {
            address: session.raw?.shipping_address?.address1 || session.raw?.shipping_address?.address || 'Checkout Initiated (Address not entered yet)',
            landmark: session.raw?.shipping_address?.address2 || session.raw?.shipping_address?.landmark || '',
            city: session.raw?.shipping_address?.city || '-',
            state: session.raw?.shipping_address?.state || '-',
            pincode: session.raw?.shipping_address?.pincode || session.raw?.shipping_address?.zipcode || '-',
          },
          items: session.items || [],
          subtotal: session.subtotal,
          shippingCharge: 0,
          total: session.subtotal,
          payment: {
            provider: 'shiprocket-checkout',
            status: session.status === 'paid' ? 'paid' : session.status === 'failed' ? 'failed' : 'created',
            method: 'Fastrr / Shiprocket Checkout',
          },
          status: session.status === 'paid' ? 'confirmed' : 'awaiting-payment',
          createdAt: session.createdAt,
          isShiprocketSession: true,
        };
      }
    }
  }

  if (!doc) throw ApiError.notFound('Order not found');
  return ok(res, doc);
});

/** PATCH /api/admin/orders/:id — status and hand-typed tracking. */
exports.adminUpdateOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const isObjectId = mongoose.isValidObjectId(id);

  let doc = isObjectId ? await Order.findById(id) : await Order.findOne({ orderNumber: id });

  if (!doc) {
    const ShiprocketCheckoutSession = require('../models/ShiprocketCheckoutSession');
    const session = isObjectId ? await ShiprocketCheckoutSession.findById(id) : await ShiprocketCheckoutSession.findOne({ orderId: id });
    if (session) {
      throw ApiError.badRequest('Shiprocket checkout attempts are read-only until payment confirmation converts them to orders.');
    }
    throw ApiError.notFound('Order not found');
  }

  const { status, courier, awb, trackingUrl, adminNotes } = req.body;

  if (status) {
    if (!Order.schema.path('status').enumValues.includes(status)) {
      throw ApiError.badRequest(`Unknown status "${status}"`);
    }
    if (status !== 'cancelled' && doc.payment.status !== 'paid') {
      throw ApiError.badRequest('This order has not been paid for yet');
    }
    doc.status = status;
    if (status === 'shipped' && !doc.tracking.shippedAt) doc.tracking.shippedAt = new Date();
    if (status === 'delivered' && !doc.tracking.deliveredAt) doc.tracking.deliveredAt = new Date();
  }

  if (courier !== undefined) doc.tracking.courier = courier;
  if (awb !== undefined) doc.tracking.awb = awb;
  if (trackingUrl !== undefined) doc.tracking.url = trackingUrl;
  if (adminNotes !== undefined) doc.adminNotes = adminNotes;

  await doc.save();
  return ok(res, doc);
});

/** POST /api/admin/orders/:id/sync-payment — fetch status directly from Razorpay. */
exports.adminSyncPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const isObjectId = mongoose.isValidObjectId(id);

  let doc = isObjectId ? await Order.findById(id) : await Order.findOne({ orderNumber: id });
  if (!doc) throw ApiError.notFound('Order not found');

  if (doc.payment?.status === 'paid') {
    return ok(res, { order: doc, message: 'Order is already marked as paid' });
  }

  const razorpayOrderId = doc.payment?.razorpayOrderId;
  if (!razorpayOrderId) {
    throw ApiError.badRequest('No Razorpay order ID associated with this order');
  }

  const auth = 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
  const { data } = await axios.get(`https://api.razorpay.com/v1/orders/${razorpayOrderId}/payments`, {
    headers: { Authorization: auth },
    timeout: 10000,
  });

  const captured = (data.items || []).find(p => p.status === 'captured');
  if (!captured) {
    return ok(res, { order: doc, message: 'No captured payment found in Razorpay for this order' });
  }

  const updated = await markPaid(doc, {
    paymentId: captured.id,
    method: captured.method || 'online',
    amountPaisa: captured.amount,
    raw: { source: 'admin-manual-sync', payment: captured },
  });

  return ok(res, { order: updated, message: 'Payment verified and order updated successfully' });
});

/** POST /api/admin/orders/:id/whatsapp — trigger or resend WhatsApp notification for an order */
exports.adminSendWhatsApp = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const isObjectId = mongoose.isValidObjectId(id);

  const order = isObjectId ? await Order.findById(id) : await Order.findOne({ orderNumber: id });
  if (!order) throw ApiError.notFound('Order not found');

  const type = req.body.type || (order.payment.status === 'paid' ? 'order-confirmation' : 'payment-pending');
  let result;

  if (type === 'order-confirmation') {
    result = await whatsapp.sendOrderConfirmationWhatsApp(order);
    if (!order.whatsappNotifications) order.whatsappNotifications = {};
    order.whatsappNotifications.orderConfirmedSent = result.sent;
    order.whatsappNotifications.orderConfirmedSentAt = new Date();
  } else {
    result = await whatsapp.sendPaymentPendingWhatsApp(order);
    if (!order.whatsappNotifications) order.whatsappNotifications = {};
    order.whatsappNotifications.awaitingPaymentSent = result.sent;
    order.whatsappNotifications.awaitingPaymentSentAt = new Date();
  }

  if (result.error) order.whatsappNotifications.lastError = result.error;
  await order.save();

  return ok(res, {
    message: `WhatsApp message processed`,
    sent: result.sent,
    channel: result.channel,
    waLink: result.waLink,
    text: result.message,
  });
});

/** GET /api/admin/shiprocket/status — diagnose Shipping API login (no secrets). */
exports.adminShiprocketStatus = asyncHandler(async (_req, res) => {
  const shiprocket = require('../services/shiprocket.service');
  const status = await shiprocket.diagnoseConnection();
  return ok(res, status);
});

/** POST /api/admin/orders/:id/push-shiprocket — Push order to Shiprocket for delivery */
exports.adminPushToShiprocket = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const isObjectId = mongoose.isValidObjectId(id);

  const order = isObjectId ? await Order.findById(id) : await Order.findOne({ orderNumber: id });
  if (!order) throw ApiError.notFound('Order not found');

  if (order.payment?.status !== 'paid') {
    throw ApiError.badRequest(
      'Sirf paid orders Shiprocket pe push ho sakte hain. Is order ka payment abhi confirm nahi hua.',
    );
  }

  const shiprocket = require('../services/shiprocket.service');
  try {
    const result = await shiprocket.createAdhocOrder(order);

    if (!result.order_id || !result.shipment_id) {
      throw ApiError.badRequest(
        'Shiprocket push returned no order/shipment id. Not marking as created.',
      );
    }

    order.shiprocket = {
      orderId: String(result.order_id),
      shipmentId: String(result.shipment_id),
      awb: String(result.awb_code || ''),
      status: result.status || 'CREATED',
      channelOrderId: result.channelOrderId || '',
      pushedAt: new Date(),
      error: null,
    };
    if (!order.tracking) order.tracking = {};
    if (result.awb_code) {
      order.tracking.awb = result.awb_code;
      order.tracking.courier = result.courier_name || 'Shiprocket';
    }
    await order.save();

    return ok(res, {
      order,
      result,
      message: `Order pushed to Shiprocket (SR #${result.order_id}, shipment ${result.shipment_id})`,
    });
  } catch (err) {
    const detail =
      err.response?.data?.message ||
      err.response?.data?.error ||
      (err.response?.data && JSON.stringify(err.response.data).slice(0, 300)) ||
      err.message ||
      'Shiprocket push failed';
    order.shiprocket = order.shiprocket || {};
    order.shiprocket.error = String(detail).slice(0, 500);
    await order.save();
    throw err;
  }
});

exports.priceCart = priceCart;

