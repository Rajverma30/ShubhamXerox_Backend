const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

/** Read a bearer token from the Authorization header or the httpOnly cookie. */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.cookies?.sx_admin_token) return req.cookies.sx_admin_token;
  return null;
}

/** Admin-only guard. There is exactly one admin account; customers never authenticate. */
exports.protectAdmin = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Admin token missing');

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const admin = await Admin.findById(decoded.id).select('+passwordChangedAt');
  if (!admin || !admin.isActive) throw ApiError.unauthorized('Admin account unavailable');

  // Invalidate tokens issued before the last password change.
  if (admin.passwordChangedAt && decoded.iat * 1000 < new Date(admin.passwordChangedAt).getTime()) {
    throw ApiError.unauthorized('Password recently changed, please sign in again');
  }

  req.admin = admin;
  next();
});

/** Verifies the Shiprocket webhook shared token. */
exports.verifyShiprocketWebhook = (req, _res, next) => {
  const expected = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (!expected) return next(); // not configured -> accept (dev convenience)
  const got = req.headers['x-api-key'] || req.headers['x-shiprocket-token'] || req.query.token;
  if (got !== expected) return next(ApiError.forbidden('Invalid webhook token'));
  return next();
};
