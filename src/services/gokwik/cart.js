/**
 * ────────────────────────────────────────────────────────────────────────────
 *  GoKwik cart maths — pure functions, no database
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Everything GoKwik shows the customer (lines, coupon, delivery, total) is
 * computed here from documents the caller has already loaded. Keeping this
 * free of I/O is what lets `npm test` exercise the whole pricing path without
 * a MongoDB.
 *
 * The response shape follows GoKwik's own open-source WooCommerce plugin
 * (github.com/GoKwik/kwikcheckout-woo, includes/api/class-gokwik-cart.php),
 * which is the only public description of what GoKwik Checkout expects a
 * merchant's cart API to return.
 */
const { sellingPrice } = require('../../utils/pricing');

/** The plugin version whose contract this mirrors; GoKwik logs it. */
const PLUGIN_VERSION = '1.1.6';

const rupees = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Mongo ObjectIds are 24 hex characters; WooCommerce product ids are integers,
 * and that is what GoKwik's systems store. The last 12 hex digits fit safely
 * in a JS number (< 2^48) and are unique in practice for one catalogue.
 */
function numericId(objectId) {
  return parseInt(String(objectId).slice(-12), 16);
}

function absoluteUrl(u) {
  const url = String(u || '');
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(process.env.BACKEND_URL || '').replace(/\/$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

const isDigital = (p) => p.type === 'ebook';

/** Units we can actually sell right now. Infinity for ebooks / backorder. */
function salableQty(p) {
  if (isDigital(p) || p.allowBackorder) return Infinity;
  return Math.max(0, Number(p.stock) || 0);
}

/* ───────────────────────────── coupons ───────────────────────────── */

/**
 * Can this coupon be used on this cart? Mirrors Coupon.isUsable() but works on
 * lean documents, and adds the restrictions isUsable() does not look at.
 *
 * @returns {{ok:true, discount:number, freeShipping:boolean} | {ok:false, reason:string}}
 */
function evaluateCoupon(coupon, lines, { now = Date.now(), customerUses = 0 } = {}) {
  if (!coupon) return { ok: false, reason: 'Coupon does not exist.' };
  if (!coupon.isActive) return { ok: false, reason: 'This coupon is not active' };

  const starts = coupon.startsAt ? new Date(coupon.startsAt).getTime() : null;
  const expires = coupon.expiresAt ? new Date(coupon.expiresAt).getTime() : null;
  if (starts && now < starts) return { ok: false, reason: 'This coupon is not live yet' };
  if (expires && now > expires) return { ok: false, reason: 'This coupon has expired' };

  if (coupon.usageLimit !== null && coupon.usageLimit !== undefined && (coupon.usedCount || 0) >= coupon.usageLimit) {
    return { ok: false, reason: 'This coupon has been fully redeemed' };
  }
  if (coupon.perCustomerLimit && customerUses >= coupon.perCustomerLimit) {
    return { ok: false, reason: 'You have already used this coupon' };
  }

  const subtotal = lines.reduce((s, l) => s + l.lineSubtotal, 0);
  if (subtotal < (coupon.minOrderValue || 0)) {
    return { ok: false, reason: `Add ₹${Math.ceil(coupon.minOrderValue - subtotal)} more to use this coupon` };
  }

  // Restricted coupons only discount the lines they name.
  const cats = (coupon.categories || []).map(String);
  const prods = (coupon.products || []).map(String);
  const restricted = cats.length > 0 || prods.length > 0;
  const eligible = restricted
    ? lines.filter((l) => prods.includes(String(l.product._id)) || cats.includes(String(l.product.category)))
    : lines;
  const eligibleSubtotal = eligible.reduce((s, l) => s + l.lineSubtotal, 0);
  if (restricted && eligibleSubtotal <= 0) {
    return { ok: false, reason: 'This coupon does not apply to the items in your cart' };
  }

  if (coupon.type === 'free-shipping') return { ok: true, discount: 0, freeShipping: true };

  let discount = coupon.type === 'percent'
    ? (eligibleSubtotal * (Number(coupon.value) || 0)) / 100
    : Number(coupon.value) || 0;
  if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  // Whole rupees, like every other price in this store, and never more than
  // the lines being discounted.
  discount = Math.min(Math.round(discount), eligibleSubtotal);

  return { ok: true, discount, freeShipping: false };
}

/* ───────────────────────────── the cart ───────────────────────────── */

/**
 * @param {Object}  args
 * @param {Object}  args.session   CheckoutSession (plain or document)
 * @param {Map}     args.products  String(productId) → lean Product
 * @param {Array}   args.coupons   lean Coupon docs for session.coupons
 * @param {Object}  args.settings  Setting singleton (shippingFlat, freeShippingAbove …)
 * @param {Object} [args.customerUses] { CODE: timesThisCustomerUsedIt }
 * @param {number} [args.now]
 */
function buildCart({ session, products, coupons = [], settings = {}, customerUses = {}, now = Date.now() }) {
  const problems = [];
  const lines = [];

  for (const item of session.items || []) {
    const product = products.get(String(item.product));
    if (!product || product.isActive === false || product.isHidden === true) {
      problems.push('An item in your cart is no longer available');
      continue;
    }
    const unit = sellingPrice(product);
    const quantity = Math.max(1, Math.min(Number(item.quantity) || 1, 99));
    lines.push({
      product,
      quantity,
      unit,
      mrp: Number(product.price) || unit,
      lineSubtotal: unit * quantity,
      inStock: salableQty(product) >= quantity,
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.lineSubtotal, 0);

  /* coupon — one at a time */
  const applied = [];
  const rejected = [];
  let discount = 0;
  let freeShippingCoupon = false;

  for (const code of session.coupons || []) {
    const coupon = coupons.find((c) => String(c.code).toUpperCase() === String(code).toUpperCase());
    const verdict = evaluateCoupon(coupon, lines, { now, customerUses: customerUses[String(code).toUpperCase()] || 0 });
    if (!verdict.ok) { rejected.push({ code, reason: verdict.reason }); continue; }
    if (applied.length) { rejected.push({ code, reason: 'Only one coupon can be used per order' }); continue; }
    applied.push(String(coupon.code).toUpperCase());
    discount = verdict.discount;
    freeShippingCoupon = verdict.freeShipping;
  }

  /* delivery */
  const allDigital = lines.length > 0 && lines.every((l) => isDigital(l.product));
  const flat = Math.max(0, Number(settings.shippingFlat) || 0);
  const freeAbove = Number(settings.freeShippingAbove) || 0;
  const afterDiscount = Math.max(0, subtotal - discount);

  let method;
  if (allDigital) {
    method = { method_id: 'digital_delivery:1', rate_id: 'digital_delivery', method_name: 'Instant download', charge: 0 };
  } else if (freeShippingCoupon || flat === 0 || (freeAbove > 0 && afterDiscount >= freeAbove)) {
    method = { method_id: 'free_shipping:1', rate_id: 'free_shipping', method_name: 'Free delivery', charge: 0 };
  } else {
    method = { method_id: 'flat_rate:1', rate_id: 'flat_rate', method_name: 'Standard delivery', charge: flat };
  }
  const shippingMethods = lines.length
    ? [{ ...method, instance_id: 1, tax_cost: 0, taxes: {} }]
    : [];
  const shipping = lines.length ? method.charge : 0;

  const total = rupees(afterDiscount + shipping);

  /* customer — GoKwik needs a destination before it has asked for one */
  const customer = {
    first_name: '', last_name: '', phone: '', email: '',
    address_1: '', address_2: '', city: '',
    ...(session.customer || {}),
  };
  if (!customer.country) customer.country = 'IN';
  if (!customer.state) customer.state = process.env.STORE_STATE_CODE || 'OD';
  if (!customer.postcode) customer.postcode = process.env.STORE_PINCODE || '751001';

  const response = {
    user_id: 0,
    customer_email: session.customerEmail || customer.email || null,
    customer,
    items: lines.map((l) => {
      const id = numericId(l.product._id);
      const qty = salableQty(l.product);
      return {
        key: String(l.product._id),
        product_id: id,
        variation_id: 0,
        quantity: l.quantity,
        line_subtotal: l.lineSubtotal,
        line_subtotal_tax: 0,
        line_total: l.lineSubtotal,
        line_tax: 0,
        product_data: {
          id,
          name: l.product.title,
          slug: l.product.slug,
          sku: l.product.sku || '',
          price: String(l.unit),
          regular_price: String(l.mrp),
          sale_price: l.unit < l.mrp ? String(l.unit) : '',
          salable_qty: Number.isFinite(qty) ? qty : 9999,
          stock_status: qty > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
          images: (l.product.images || []).slice(0, 4).map((img, i) => ({
            id: id + i,
            src: absoluteUrl(img.cardUrl || img.url || img.thumbUrl),
            name: l.product.title,
            alt: img.alt || l.product.title,
          })),
        },
        currency: '₹',
      };
    }),
    coupon_applied: applied.map((c) => c.toLowerCase()),
    chosen_shipping_method: shippingMethods.map((m) => m.method_id),
    chosen_payment_method: session.paymentMethod || '',
    shipping_methods: shippingMethods,
    totals: {
      subtotal: rupees(subtotal),
      subtotal_tax: 0,
      shipping_total: rupees(shipping),
      shipping_tax: 0,
      shipping_taxes: [],
      discount_total: rupees(discount),
      discount_tax: 0,
      cart_contents_total: rupees(afterDiscount),
      cart_contents_tax: 0,
      cart_contents_taxes: [],
      fee_total: 0,
      fee_tax: 0,
      fee_taxes: [],
      total,
      total_tax: 0,
    },
    plugin_version: PLUGIN_VERSION,
  };

  return {
    response,
    lines,
    subtotal: rupees(subtotal),
    discount: rupees(discount),
    shipping: rupees(shipping),
    total,
    appliedCoupons: applied,
    rejectedCoupons: rejected,
    shippingMethod: shippingMethods[0] || null,
    problems,
  };
}

/* ─────────────────────── address / status helpers ─────────────────────── */

/** WooCommerce state codes → names, for the handful of places we show them. */
const STATE_NAMES = {
  AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CH: 'Chandigarh', CT: 'Chhattisgarh', CG: 'Chhattisgarh', DN: 'Dadra and Nagar Haveli and Daman and Diu', DD: 'Daman and Diu',
  DL: 'Delhi', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu and Kashmir',
  JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh',
  MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha',
  PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TS: 'Telangana', TG: 'Telangana',
  TR: 'Tripura', UK: 'Uttarakhand', UT: 'Uttarakhand', UP: 'Uttar Pradesh', WB: 'West Bengal',
};

const stateName = (s) => {
  const v = String(s || '').trim();
  return v.length === 2 ? (STATE_NAMES[v.toUpperCase()] || v.toUpperCase()) : v;
};

/** "+91 98765-43210" → "9876543210" */
const cleanPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** GoKwik/Woo address object → our addressSchema. Undefined when unusable. */
function toOrderAddress(a = {}) {
  const pincode = String(a.postcode || a.pincode || '').replace(/\D/g, '').slice(0, 6);
  const address = String(a.address_1 || a.address || '').trim();
  const city = String(a.city || '').trim();
  const state = stateName(a.state);
  if (!address || !city || !state || pincode.length !== 6) return undefined;
  return {
    address,
    address2: String(a.address_2 || '').trim(),
    landmark: String(a.landmark || '').trim(),
    city,
    district: city,
    state,
    pincode,
    country: !a.country || String(a.country).toUpperCase() === 'IN' ? 'India' : String(a.country),
  };
}

const fullName = (a = {}) => [a.first_name, a.last_name].filter(Boolean).join(' ').trim();

/** Our order.status → the four labels GoKwik's v3/orders/update accepts. */
function gokwikStatusLabel(status) {
  return {
    pending: 'Pending',
    confirmed: 'Confirmed', packed: 'Confirmed', shipped: 'Confirmed', delivered: 'Confirmed',
    cancelled: 'Cancelled',
    failed: 'Failed',
  }[status] || null;
}

/** WooCommerce status GoKwik sends us → our order.status. */
function fromWooStatus(status) {
  return {
    pending: 'pending', 'on-hold': 'pending',
    processing: 'confirmed', completed: 'delivered',
    cancelled: 'cancelled', refunded: 'cancelled', failed: 'failed',
  }[String(status || '').toLowerCase().replace(/^wc-/, '')] || null;
}

module.exports = {
  PLUGIN_VERSION,
  numericId,
  absoluteUrl,
  isDigital,
  salableQty,
  evaluateCoupon,
  buildCart,
  stateName,
  cleanPhone,
  toOrderAddress,
  fullName,
  gokwikStatusLabel,
  fromWooStatus,
  rupees,
};
