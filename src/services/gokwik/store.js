/**
 * Every database call the GoKwik integration makes, in one place.
 *
 * The controllers never touch a model directly. That keeps them readable, and
 * it means the test suite can swap this one module for an in-memory fake and
 * drive the real controllers end to end without a MongoDB.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');

const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Coupon = require('../../models/Coupon');
const Setting = require('../../models/Setting');
const CheckoutSession = require('../../models/CheckoutSession');

const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000; // an open cart lives three days

const PRODUCT_FIELDS = '_id title slug sku type price salePrice discountPercent stock allowBackorder images category isActive isHidden';

/* ── sessions ── */

const newKey = () => crypto.randomBytes(20).toString('hex');

exports.createSession = (data) =>
  CheckoutSession.create({ key: newKey(), expiresAt: new Date(Date.now() + SESSION_TTL_MS), ...data });

/** Only keys we minted: 40 hex chars. Anything else never reaches the DB. */
exports.getSession = (key) =>
  (/^[a-f0-9]{40}$/.test(String(key || '')) ? CheckoutSession.findOne({ key: String(key) }) : null);

exports.saveSession = (session) => {
  session.markModified?.('customer');
  return session.save();
};

/* ── catalogue ── */

/** Resolve whatever the browser sent (ids, slugs or SKUs) to live products. */
exports.findProductsByKeys = async (keys) => {
  const ids = keys.filter((k) => mongoose.isValidObjectId(k));
  return Product.find({
    $or: [{ _id: { $in: ids } }, { slug: { $in: keys } }, { sku: { $in: keys } }],
    isActive: true,
    isHidden: false,
  }).select(PRODUCT_FIELDS).lean();
};

exports.findProductsByIds = (ids) =>
  Product.find({ _id: { $in: ids } }).select(PRODUCT_FIELDS).lean();

exports.getSettings = () => Setting.getSingleton();

/* ── coupons ── */

exports.findCoupons = (codes) =>
  (codes.length ? Coupon.find({ code: { $in: codes.map((c) => String(c).toUpperCase()) } }).lean() : []);

exports.listSiteCoupons = () => {
  const now = new Date();
  return Coupon.find({
    isActive: true,
    showOnSite: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] },
    ],
  }).sort({ value: -1 }).lean();
};

/** How many confirmed orders this phone/email has already used `code` on. */
exports.countCouponUses = (code, { phone, email }) => {
  const who = [];
  if (phone) who.push({ 'customer.phone': phone });
  if (email) who.push({ 'customer.email': email });
  if (!who.length) return 0;
  return Order.countDocuments({
    couponCode: String(code).toUpperCase(),
    status: { $nin: ['failed', 'cancelled'] },
    $or: who,
  });
};

exports.incrementCouponUse = (code, by = 1) =>
  Coupon.updateOne({ code: String(code).toUpperCase() }, { $inc: { usedCount: by } });

/* ── orders ── */

exports.createOrder = (doc) => Order.create(doc);
exports.saveOrder = (order) => order.save();
exports.findOrderById = (id) => (mongoose.isValidObjectId(id) ? Order.findById(id) : null);
exports.findOrderByNumber = (orderNumber) => Order.findOne({ orderNumber: String(orderNumber) });
exports.findOrderByGokwikId = (id) => Order.findOne({ 'payment.orderId': String(id) });
exports.findOrderBySession = (key) => Order.findOne({ sessionKey: String(key) }).sort({ createdAt: -1 });

/**
 * Move stock by `sign` × quantity for every line. sign = -1 when an order is
 * confirmed, +1 when a confirmed order is cancelled or fully refunded.
 */
exports.adjustStock = (items, sign) =>
  Promise.all(
    items
      .filter((l) => l.product)
      .map((l) => Product.updateOne(
        { _id: l.product },
        { $inc: { stock: sign * l.quantity, soldCount: -sign * l.quantity } },
      )),
  );
