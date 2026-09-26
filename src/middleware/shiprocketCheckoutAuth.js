/**
 * Authenticates inbound requests from Shiprocket Checkout.
 *
 * Direction note: these endpoints live on *our* server and Shiprocket calls
 * them to sync the catalogue. The API key / secret pair the merchant is issued
 * is what Shiprocket presents on each call.
 *
 * Shiprocket's custom-platform onboarding doesn't publish which auth style it
 * uses, and it has varied between accounts, so we accept any of the four
 * common forms and log which one matched. Once you see the real header in the
 * logs you can narrow this down.
 *
 *   1. x-api-key + x-api-secret headers
 *   2. Authorization: Basic base64(key:secret)
 *   3. Authorization: Bearer <key>          (secret then unused)
 *   4. ?api_key=&api_secret= query params   (last resort)
 *
 * Plus optional HMAC-SHA256 body signing via x-sr-signature / x-shiprocket-hmac.
 */
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/** Constant-time compare that tolerates length mismatch. */
function safeEqual(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = function shiprocketCheckoutAuth(req, _res, next) {
  // Shiprocket's onboarding emails use SHIPROCKET_CHECKOUT_API_SECRET while
  // older docs use _SECRET. Accept either so a copy-pasted .env just works.
  const KEY = process.env.SHIPROCKET_CHECKOUT_API_KEY || process.env.SHIPROCKET_API_KEY;
  const SECRET = process.env.SHIPROCKET_CHECKOUT_API_SECRET || process.env.SHIPROCKET_CHECKOUT_SECRET || process.env.SHIPROCKET_API_SECRET;

  const h = req.headers;
  let method = null;

  const hasAuthAttempt = Boolean(
    h['x-api-key'] || h['x-api-secret'] || h.authorization || req.query.api_key
    || h['x-api-hmac-sha256'] || h['x-sr-signature'] || h['x-shiprocket-hmac'] || h['x-shiprocket-signature'],
  );

  if (KEY && SECRET && hasAuthAttempt) {
    // 1. dedicated headers.
    if (h['x-api-key'] || h['x-api-secret']) {
      const presented = String(h['x-api-key'] || '').replace(/^Bearer\s+/i, '').trim();
      if (safeEqual(presented, KEY) && (!h['x-api-secret'] || safeEqual(h['x-api-secret'], SECRET))) {
        method = 'x-api-key header';
      }
    }

    // 2 & 3. Authorization header
    const auth = h.authorization || '';
    if (!method && auth.startsWith('Basic ')) {
      const [key, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      if (safeEqual(key, KEY) && safeEqual(secret, SECRET)) method = 'Basic auth';
    }
    if (!method && auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (safeEqual(token, KEY) || safeEqual(token, SECRET)) method = 'Bearer token';
    }

    // 4. query params
    if (!method && req.query.api_key) {
      if (safeEqual(req.query.api_key, KEY) && (!req.query.api_secret || safeEqual(req.query.api_secret, SECRET))) {
        method = 'query params';
      }
    }

    // optional HMAC over the raw body (POST callbacks)
    const signature = h['x-api-hmac-sha256'] || h['x-sr-signature']
      || h['x-shiprocket-hmac'] || h['x-shiprocket-signature'];
    if (!method && signature && req.rawBody) {
      const digest = crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('base64');
      if (safeEqual(digest, signature)) method = 'HMAC signature';
    }

    if (!method) {
      logger.warn(`Shiprocket Checkout auth failed from ${req.ip}.`);
      return next(ApiError.unauthorized('Invalid Shiprocket Checkout credentials'));
    }
  } else if (req.method === 'GET') {
    method = 'public GET';
  } else if (!KEY || !SECRET) {
    logger.error('Shiprocket Checkout endpoints are mounted but SHIPROCKET_CHECKOUT_API_KEY / _SECRET are not set.');
    return next(ApiError.internal('Shiprocket Checkout is not configured on this server'));
  } else {
    return next(ApiError.unauthorized('Shiprocket Checkout credentials required'));
  }

  logger.debug(`Shiprocket Checkout authenticated via ${method}`);
  req.shiprocketAuthMethod = method;
  return next();
};
