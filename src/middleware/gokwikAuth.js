/**
 * Guards the cart API that GoKwik's servers call.
 *
 * GoKwik authenticates with the App ID and App Secret it issued to this store,
 * sent as plain headers on every request. Their WooCommerce plugin accepts
 * `appid`/`app-id` and `appsecret`/`app-secret`; the `gk-` spellings are what
 * GoKwik's own APIs use, so those are accepted too.
 *
 * Failure answers in WordPress's REST error shape, because that is what the
 * calling side is written to parse.
 */
const crypto = require('crypto');
const logger = require('../utils/logger');
const gokwik = require('../services/gokwik/api');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  // Compare against itself when lengths differ so timing does not leak length.
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

module.exports = function gokwikAuth(req, res, next) {
  const { appId, appSecret } = gokwik.config();
  const sentId = req.get('appid') || req.get('app-id') || req.get('gk-app-id');
  const sentSecret = req.get('appsecret') || req.get('app-secret') || req.get('gk-app-secret');

  if (appId && appSecret && sentId && sentSecret && safeEqual(sentId, appId) && safeEqual(sentSecret, appSecret)) {
    return next();
  }

  logger.warn(`GoKwik cart API: rejected ${req.method} ${req.originalUrl} from ${req.ip} — ${sentId ? 'wrong' : 'missing'} app id/secret`);
  return res.status(401).json({
    code: 'rest_forbidden',
    message: 'Sorry, you are not allowed to do that.',
    data: { status: 401 },
  });
};
