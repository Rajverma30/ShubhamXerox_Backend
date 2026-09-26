const rateLimit = require('express-rate-limit');

const windowMs = (Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15) * 60 * 1000;

/** Broad limiter applied to the whole /api surface. */
exports.apiLimiter = rateLimit({
  windowMs,
  max: Number(process.env.RATE_LIMIT_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests — please slow down.' },
});

/** Tight limiter for the admin login endpoint (brute-force protection). */
exports.loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 10 minutes.' },
});

/** Guards order creation + contact/newsletter forms from spam. */
exports.writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many submissions — please wait a moment.' },
});
