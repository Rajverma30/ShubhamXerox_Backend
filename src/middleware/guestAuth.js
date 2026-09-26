/**
 * Requires a guest token minted by POST /api/auth/otp/verify.
 *
 * `scope` is checked explicitly so an ADMIN token cannot be used here and,
 * more importantly, so a guest token can never be mistaken for an admin one.
 * The session `jti` must still be active (not yet consumed by an order).
 */
const jwt = require('jsonwebtoken');
const GuestCheckoutSession = require('../models/GuestCheckoutSession');
const ApiError = require('../utils/ApiError');

module.exports = async function requireVerifiedPhone(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return next(ApiError.unauthorized('Please verify your mobile number first'));

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.scope !== 'guest-checkout' || !payload.phone || !payload.jti) {
      return next(ApiError.unauthorized('Please verify your mobile number first'));
    }

    const session = await GuestCheckoutSession.findOne({ jti: payload.jti, phone: payload.phone });
    if (!session) return next(ApiError.unauthorized('Please verify your mobile number first'));
    if (session.expiresAt < new Date()) {
      return next(ApiError.unauthorized('Your verification expired. Please verify your number again.'));
    }

    req.guestPhone = payload.phone;
    req.guestJti = payload.jti;
    if (session.orderNumber) req.guestOrderNumber = session.orderNumber;
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return next(ApiError.unauthorized(expired
      ? 'Your verification expired. Please verify your number again.'
      : 'Please verify your mobile number first'));
  }
};
