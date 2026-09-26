/**
 * Shiprocket integration — the single gateway for shipping in this project.
 *
 * Orders are created and managed inside Shiprocket Checkout, so this module
 * only covers what the storefront still needs: token lifecycle, pincode
 * serviceability for the product page's delivery estimate, and tracking
 * look-ups for the Track Order page.
 *
 * The auth token is valid for ~10 days; we cache it in memory and refresh
 * lazily (and once on a 401 retry) so we never hammer the login endpoint.
 */
const axios = require('axios');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const BASE_URL = process.env.SHIPROCKET_BASE_URL || 'https://apiv2.shiprocket.in/v1/external';

let cache = { token: null, expiresAt: 0 };

const http = axios.create({ baseURL: BASE_URL, timeout: 30000 });

/** Strip accidental quotes/whitespace from Railway/dotenv values. */
function cleanEnv(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function getShippingCredentials() {
  return {
    email: cleanEnv(process.env.SHIPROCKET_EMAIL),
    password: cleanEnv(process.env.SHIPROCKET_PASSWORD),
  };
}

function credentialsPresent() {
  const { email, password } = getShippingCredentials();
  return Boolean(email && password);
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email ? `(invalid email len=${email.length})` : '(empty)';
  const [u, d] = email.split('@');
  return `${u.slice(0, 2)}***@${d}`;
}

function accessDeniedHint(message = '') {
  const m = String(message || '');
  if (/access denied|403|401|invalid|credential|unauthorized|forbidden/i.test(m)) {
    return (
      ' Tip: Shiprocket panel login mat use karo. Settings → API → Configure → Create API User ' +
      '(alag email), password email pe aata hai, Orders module ON rakho, phir wahi email/password Railway pe set karo (bina quotes).'
    );
  }
  return '';
}

function shiprocketErrorMessage(err, fallback = 'Shiprocket request failed') {
  const payload = err.response?.data;
  if (!payload) return err.message || fallback;
  if (typeof payload === 'string' && payload.trim()) return payload.slice(0, 300);
  return (
    payload.message ||
    payload.error ||
    (payload.errors && JSON.stringify(payload.errors)) ||
    err.message ||
    fallback
  );
}

/** POST /auth/login → bearer token (cached). */
async function login(force = false) {
  const { email, password } = getShippingCredentials();
  if (!email || !password) {
    throw ApiError.internal(
      'Shiprocket Shipping API is not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD ' +
        '(Shiprocket panel → Settings → API → API User) on the server, then restart. ' +
        'Checkout API keys alone are not enough for Push to Shiprocket.',
    );
  }
  if (!force && cache.token && Date.now() < cache.expiresAt) return cache.token;

  try {
    const { data } = await http.post('/auth/login', { email, password });

    if (!data?.token) throw ApiError.internal('Shiprocket login failed — no token returned.');

    cache = { token: data.token, expiresAt: Date.now() + 9 * 24 * 60 * 60 * 1000 };
    logger.info(`Shiprocket token refreshed for ${maskEmail(email)}`);
    return cache.token;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const status = err.response?.status;
    const message = shiprocketErrorMessage(err, 'Shiprocket login failed');
    logger.error(`Shiprocket login failed for ${maskEmail(email)} (${status || 'no-status'}): ${message}`);
    if (status === 401 || status === 403) {
      throw ApiError.badRequest(
        `Shiprocket login failed (${status}) for ${maskEmail(email)}: ${message}.` +
          accessDeniedHint(message),
      );
    }
    throw ApiError.badGateway(`Shiprocket login failed: ${message}`);
  }
}

/**
 * Safe status for admin diagnostics — never returns the password.
 */
async function diagnoseConnection() {
  const { email, password } = getShippingCredentials();
  const pickup = cleanEnv(process.env.SHIPROCKET_PICKUP_LOCATION) || 'Primary';
  const result = {
    configured: Boolean(email && password),
    emailMasked: maskEmail(email),
    pickupLocationEnv: pickup,
    loginOk: false,
    httpStatus: null,
    message: null,
    pickupNames: [],
    pickupMatch: null,
  };

  if (!result.configured) {
    result.message =
      'SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD missing on server. Checkout keys cannot replace these.';
    return result;
  }

  try {
    const { status, data } = await http.post(
      '/auth/login',
      { email, password },
      { validateStatus: () => true },
    );
    result.httpStatus = status;
    result.message = data?.message || data?.error || (status === 200 ? 'ok' : 'login rejected');
    result.loginOk = Boolean(data?.token);
    if (!data?.token) return result;

    cache = { token: data.token, expiresAt: Date.now() + 9 * 24 * 60 * 60 * 1000 };

    const pickupRes = await http.get('/settings/company/pickup', {
      headers: { Authorization: `Bearer ${data.token}` },
      validateStatus: () => true,
    });
    const locs =
      pickupRes.data?.data?.shipping_address ||
      pickupRes.data?.data ||
      [];
    if (Array.isArray(locs)) {
      result.pickupNames = locs
        .map((l) => l.pickup_location || l.name || '')
        .filter(Boolean);
      result.pickupMatch = result.pickupNames.includes(pickup);
      if (!result.pickupMatch) {
        result.message =
          `Login OK, but pickup "${pickup}" not found. Available: ${result.pickupNames.join(', ') || '(none)'}`;
      } else {
        result.message = 'Login OK and pickup location matched.';
      }
    } else {
      result.message = `Login OK. Pickup list status ${pickupRes.status}: ${pickupRes.data?.message || 'ok'}`;
    }
  } catch (err) {
    result.httpStatus = err.response?.status || null;
    result.message = shiprocketErrorMessage(err);
  }

  return result;
}

/** Authenticated request with one automatic re-login on 401. */
async function request(method, url, { data, params } = {}, retry = true) {
  const token = await login();
  try {
    const res = await http.request({
      method,
      url,
      data,
      params,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 && retry) {
      cache = { token: null, expiresAt: 0 };
      return request(method, url, { data, params }, false);
    }
    const payload = err.response?.data;
    const message = shiprocketErrorMessage(err);
    logger.error(`Shiprocket ${method.toUpperCase()} ${url} -> ${status}: ${message}`);
    if (status === 401 || status === 403) {
      throw ApiError.badRequest(
        `Shiprocket API access denied (${status}): ${message}.` + accessDeniedHint(message),
      );
    }
    throw new ApiError(status && status < 500 ? 400 : 502, `Shiprocket: ${message}`, payload);
  }
}

/* ─────────────────────────── Serviceability ─────────────────────────── */

/**
 * Can we deliver to this pincode, and what will it cost?
 * @returns {{serviceable:boolean, couriers:Array, cheapest:Object|null, etd:string|null}}
 */
async function checkServiceability({ deliveryPincode, weight = 0.5, cod = 0, declaredValue = 0 }) {
  try {
    const data = await request('get', '/courier/serviceability/', {
      params: {
        pickup_postcode: process.env.STORE_PINCODE || '452001',
        delivery_postcode: deliveryPincode,
        weight,
        cod: cod ? 1 : 0,
        declared_value: declaredValue,
      },
    });

    const couriers = data?.data?.available_courier_companies || [];
    const sorted = [...couriers].sort((a, b) => Number(a.rate) - Number(b.rate));
    const cheapest = sorted[0] || null;

    if (couriers.length > 0) {
      return {
        serviceable: true,
        couriers: sorted.map((c) => ({
          courierCompanyId: c.courier_company_id,
          name: c.courier_name,
          rate: Number(c.rate),
          etd: c.etd,
          estimatedDeliveryDays: c.estimated_delivery_days,
          codAvailable: Boolean(c.cod),
          rating: c.rating,
        })),
        cheapest: cheapest
          ? { courierCompanyId: cheapest.courier_company_id, name: cheapest.courier_name, rate: Number(cheapest.rate) }
          : null,
        etd: cheapest?.etd || null,
      };
    }
  } catch (err) {
    logger.warn(`Shiprocket serviceability API error: ${err.message}`);
  }

  return {
    serviceable: true,
    couriers: [
      { courierCompanyId: 'std_express', name: 'Express Shipping', rate: 0, etd: '3–5 days', estimatedDeliveryDays: '3–5', codAvailable: true },
    ],
    cheapest: { courierCompanyId: 'std_express', name: 'Express Shipping', rate: 0 },
    etd: '3–5 business days',
  };
}

/* ──────────────────────────── Tracking ─────────────────────────────── */

/** Normalises the several tracking response shapes Shiprocket returns. */
function normaliseTracking(raw) {
  const td = raw?.tracking_data || raw?.[Object.keys(raw || {})[0]]?.tracking_data || {};
  const activities = td.shipment_track_activities || [];
  const track = (td.shipment_track || [])[0] || {};
  return {
    currentStatus: track.current_status || td.shipment_status_text || 'Unknown',
    awb: track.awb_code || null,
    courierName: track.courier_name || null,
    etd: track.edd || null,
    trackUrl: td.track_url || null,
    activities: activities.map((a) => ({
      date: a.date,
      status: a.status,
      activity: a.activity,
      location: a.location,
    })),
  };
}

const trackByAwb = async (awb) => normaliseTracking(await request('get', `/courier/track/awb/${awb}`));

/**
 * Track by the order id Shiprocket Checkout gave the customer.
 * `channel_id` scopes the lookup to this store's checkout channel.
 */
const trackByOrderId = async (orderId) =>
  normaliseTracking(
    await request('get', '/courier/track', {
      params: { order_id: orderId, channel_id: process.env.SHIPROCKET_CHANNEL_ID || undefined },
    }),
  );
const trackByShipmentId = async (id) => normaliseTracking(await request('get', `/courier/track/shipment/${id}`));

/** GET /channels — useful when filling SHIPROCKET_CHANNEL_ID. */
const listChannels = () => request('get', '/channels');

/** Maps a Shiprocket status string onto our internal ORDER_STATUS enum. */
function mapStatus(shiprocketStatus = '') {
  const s = String(shiprocketStatus).toUpperCase();
  if (s.includes('DELIVERED')) return 'delivered';
  if (s.includes('OUT FOR DELIVERY')) return 'out-for-delivery';
  if (s.includes('RTO')) return 'rto';
  if (s.includes('RETURN')) return 'returned';
  if (s.includes('CANCEL')) return 'cancelled';
  if (s.includes('TRANSIT') || s.includes('SHIPPED')) return 'in-transit';
  if (s.includes('PICKED')) return 'shipped';
  if (s.includes('READY')) return 'ready-to-ship';
  if (s.includes('LOST') || s.includes('UNDELIVERED')) return 'failed';
  if (s.includes('NEW') || s.includes('PENDING')) return 'confirmed';
  return 'processing';
}

/** GET pickup addresses registered on the Shiprocket account. */
async function listPickupLocations() {
  const data = await request('get', '/settings/company/pickup');
  const locs = data?.data?.shipping_address || data?.data || data?.shipping_address || [];
  return Array.isArray(locs) ? locs : [];
}

/**
 * Resolve the exact pickup_location nickname Shiprocket expects.
 * SHIPROCKET_PICKUP_LOCATION can be:
 *   - the nickname (e.g. "Primary", "shop 5")
 *   - or part of the street address (we map it to the nickname)
 */
async function resolvePickupLocationName() {
  const wantedRaw = cleanEnv(process.env.SHIPROCKET_PICKUP_LOCATION) || 'Primary';
  const wanted = wantedRaw.toLowerCase();
  const locs = await listPickupLocations();

  if (!locs.length) {
    throw ApiError.badRequest(
      'Shiprocket account mein koi pickup location nahi mili. Shiprocket panel → Settings → Pickup Address add karo.',
    );
  }

  const rows = locs.map((l) => {
    const name = String(l.pickup_location || l.name || '').trim();
    const hay = [
      name,
      l.address,
      l.address_2,
      l.address2,
      l.city,
      l.state,
      l.pin_code,
      l.pincode,
      l.phone,
      l.email,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return { name, hay, id: l.id };
  });

  const names = rows.map((r) => r.name).filter(Boolean);

  // 1) Exact nickname
  const exact = rows.find((r) => r.name === wantedRaw);
  if (exact?.name) return { name: exact.name, available: names, auto: false, id: exact.id };

  // 2) Case-insensitive nickname
  const ci = rows.find((r) => r.name.toLowerCase() === wanted);
  if (ci?.name) return { name: ci.name, available: names, auto: false, id: ci.id };

  // 3) Nickname / address contains the env value (or env contains nickname)
  const partial = rows.find(
    (r) =>
      (r.name && (r.name.toLowerCase().includes(wanted) || wanted.includes(r.name.toLowerCase()))) ||
      (r.hay && (r.hay.includes(wanted) || wanted.split(/[,\n]/).some((part) => {
        const p = part.trim();
        return p.length >= 6 && r.hay.includes(p);
      }))),
  );
  if (partial?.name) {
    logger.warn(`Shiprocket pickup env matched address → using nickname "${partial.name}" (id=${partial.id})`);
    return { name: partial.name, available: names, auto: true, id: partial.id };
  }

  // 4) Significant tokens from address (vinayak, bhawarkua, 452001, tinkus…)
  const tokens = wanted
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 5);
  if (tokens.length) {
    const scored = rows
      .map((r) => ({
        ...r,
        score: tokens.filter((t) => r.hay.includes(t)).length,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored[0]?.name && scored[0].score >= Math.min(2, tokens.length)) {
      logger.warn(
        `Shiprocket pickup env token-matched → "${scored[0].name}" (score ${scored[0].score}/${tokens.length})`,
      );
      return { name: scored[0].name, available: names, auto: true, id: scored[0].id };
    }
  }

  if (names.length === 1) {
    logger.warn(`Shiprocket pickup env unmatched; using only available nickname "${names[0]}"`);
    return { name: names[0], available: names, auto: true, id: rows[0]?.id };
  }

  throw ApiError.badRequest(
    `Shiprocket pickup match nahi hua. Env mein poora address mat dalo — nickname chahiye. ` +
      `Available nicknames: ${names.join(' | ')}. ` +
      `Shiprocket → Settings → Pickup Address pe left side ka short name copy karke ` +
      `SHIPROCKET_PICKUP_LOCATION mein set karo.`,
  );
}

/**
 * Create a custom/adhoc B2C Order in Shiprocket for delivery fulfillment.
 * Endpoint: POST /orders/create/adhoc
 */
function shiprocketChannelOrderId(order) {
  // Shiprocket docs: avoid letters in order_id (breaks some courier APIs).
  // Build a digit-only id from ObjectId + orderNumber digits, max 20 chars.
  const hex = String(order._id || '');
  let fromId = '';
  try {
    fromId = BigInt(`0x${hex.slice(-10)}`).toString();
  } catch {
    fromId = String(Date.now());
  }
  const fromNumber = String(order.orderNumber || '').replace(/\D/g, '');
  const id = `${fromNumber}${fromId}`.replace(/\D/g, '').slice(0, 20);
  return id || String(Date.now()).slice(-12);
}

function extractCreatedOrder(result) {
  // Wrong pickup often returns an array of pickup addresses instead of an order.
  if (Array.isArray(result) || Array.isArray(result?.data)) {
    const locs = Array.isArray(result) ? result : result.data;
    const names = locs.map((l) => l?.pickup_location || l?.name).filter(Boolean);
    if (names.length && locs[0]?.pickup_location) {
      return {
        orderId: '',
        shipmentId: '',
        awb: '',
        courier: '',
        status: 'PICKUP_MISMATCH',
        statusCode: 0,
        raw: result,
        pickupHint: names,
      };
    }
  }

  const root = result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? { ...result, ...result.data }
    : result || {};
  const orderId = root.order_id ?? root.orderId ?? root.sr_order_id ?? null;
  const shipmentId = root.shipment_id ?? root.shipmentId ?? null;
  const statusCode = root.status_code ?? root.statusCode;
  const msg = root.message || result?.message || '';
  return {
    orderId: orderId === 0 || orderId ? String(orderId) : '',
    shipmentId: shipmentId === 0 || shipmentId ? String(shipmentId) : '',
    awb: root.awb_code || root.awb || '',
    courier: root.courier_name || '',
    status: root.status || 'NEW',
    statusCode,
    raw: result,
    message: msg,
    pickupHint: null,
  };
}

async function createAdhocOrder(order) {
  if (!credentialsPresent()) {
    throw ApiError.internal(
      'Shiprocket Shipping API is not configured. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD on the server (Shiprocket → Settings → API).',
    );
  }

  if (!order || !order.shippingAddress) {
    throw ApiError.badRequest('Invalid order or missing shipping address.');
  }

  const nameParts = String(order.customer?.name || 'Customer').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Customer';
  // Shiprocket requires billing_last_name to be present (non-empty).
  const lastName = nameParts.slice(1).join(' ') || firstName;

  const orderDateFormatted = order.createdAt
    ? new Date(order.createdAt).toISOString().replace('T', ' ').substring(0, 19)
    : new Date().toISOString().replace('T', ' ').substring(0, 19);

  const orderItems = (order.items || []).map((item) => ({
    name: String(item.title || 'Product').slice(0, 200),
    sku: String(item.sku || `SKU-${item.product || 'item'}`).slice(0, 50),
    units: Number(item.quantity) || 1,
    selling_price: Number(item.price) || 0,
    discount: 0,
    tax: 0,
    hsn: 4901,
  }));

  if (!orderItems.length) {
    throw ApiError.badRequest('Order has no items to push to Shiprocket.');
  }

  const phone = String(order.customer?.phone || '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) {
    throw ApiError.badRequest('Customer phone must be a valid 10-digit Indian mobile for Shiprocket.');
  }

  const subTotal = orderItems.reduce(
    (sum, i) => sum + Number(i.selling_price || 0) * Number(i.units || 1),
    0,
  );

  // If a previous push saved empty IDs, don't reuse a colliding channel order_id.
  let channelOrderId = shiprocketChannelOrderId(order);
  if (order.shiprocket?.pushedAt && !order.shiprocket?.orderId) {
    channelOrderId = `${channelOrderId}`.slice(0, 16) + String(Date.now()).slice(-4);
  }

  const pickup = await resolvePickupLocationName();

  const payload = {
    order_id: channelOrderId,
    order_date: orderDateFormatted,
    pickup_location: pickup.name,
    billing_customer_name: firstName,
    billing_last_name: lastName,
    billing_address: order.shippingAddress.address || '',
    billing_address_2: order.shippingAddress.landmark || order.shippingAddress.address2 || '',
    billing_city: order.shippingAddress.city || '',
    billing_pincode: String(order.shippingAddress.pincode || ''),
    billing_state: order.shippingAddress.state || '',
    billing_country: order.shippingAddress.country || 'India',
    billing_email: order.customer?.email || 'customer@shubhamxerox.in',
    billing_phone: phone,
    shipping_is_billing: true,
    order_items: orderItems,
    payment_method: order.payment?.status === 'paid' ? 'Prepaid' : 'COD',
    sub_total: subTotal,
    length: 10,
    breadth: 10,
    height: 5,
    // Always bill/ship as 500g — do not scale with item count or product weight.
    weight: 0.5,
  };

  const channelId = cleanEnv(process.env.SHIPROCKET_CHANNEL_ID);
  if (channelId) payload.channel_id = Number(channelId) || channelId;

  logger.info(
    `Pushing Order ${order.orderNumber} → Shiprocket channel order_id=${channelOrderId} pickup="${payload.pickup_location}"`,
  );

  // request() expects { data, params } — passing payload directly sent an empty body.
  const result = await request('post', '/orders/create/adhoc', { data: payload });
  const created = extractCreatedOrder(result);

  logger.info(
    `Shiprocket create response for ${order.orderNumber}: ` +
      `order_id=${created.orderId || '(none)'} shipment_id=${created.shipmentId || '(none)'} ` +
      `status_code=${created.statusCode}`,
  );

  if (created.pickupHint?.length) {
    throw ApiError.badRequest(
      `Shiprocket pickup location galat hai. Available: ${created.pickupHint.join(' | ')}. ` +
        `Railway pe SHIPROCKET_PICKUP_LOCATION exact set karo (tried: "${payload.pickup_location}").`,
    );
  }

  if (created.statusCode === 0 || created.statusCode === '0') {
    throw ApiError.badRequest(
      `Shiprocket rejected the order (status_code=0): ${created.message || JSON.stringify(result).slice(0, 400)}`,
    );
  }

  if (!created.orderId || !created.shipmentId) {
    throw ApiError.badRequest(
      'Shiprocket did not return order_id/shipment_id. ' +
        `Tried pickup "${payload.pickup_location}". Available: ${pickup.available.join(' | ')}. ` +
        `Response: ${JSON.stringify(result).slice(0, 300)}`,
    );
  }

  return {
    ...created,
    channelOrderId,
    pickupLocation: payload.pickup_location,
    order_id: created.orderId,
    shipment_id: created.shipmentId,
    awb_code: created.awb,
    courier_name: created.courier,
  };
}

module.exports = {
  login,
  credentialsPresent,
  diagnoseConnection,
  listPickupLocations,
  resolvePickupLocationName,
  checkServiceability,
  trackByAwb,
  trackByShipmentId,
  trackByOrderId,
  listChannels,
  mapStatus,
  createAdhocOrder,
};
