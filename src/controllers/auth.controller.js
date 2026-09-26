const jwt = require('jsonwebtoken');
const { Admin } = require('../models');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const signToken = (admin) =>
  jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d',
  });

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
});

const publicAdmin = (a) => ({
  id: a._id,
  username: a.username,
  name: a.name,
  email: a.email,
  avatar: a.avatar,
  phone: a.phone,
  role: a.role,
  lastLoginAt: a.lastLoginAt,
});

/** POST /api/admin/auth/login — the only admin entry point (no registration). */
exports.login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  const admin = await Admin.findOne({ username: String(username).toLowerCase().trim() }).select('+password');
  if (!admin || !(await admin.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid username or password');
  }
  if (!admin.isActive) throw ApiError.forbidden('This admin account is disabled');

  admin.lastLoginAt = new Date();
  admin.lastLoginIp = req.ip;
  await admin.save({ validateBeforeSave: false });

  const token = signToken(admin);
  res.cookie('sx_admin_token', token, cookieOptions());
  return ok(res, { token, admin: publicAdmin(admin) });
});

/** GET /api/admin/auth/me */
exports.me = asyncHandler(async (req, res) => ok(res, publicAdmin(req.admin)));

/** POST /api/admin/auth/logout */
exports.logout = asyncHandler(async (_req, res) => {
  res.clearCookie('sx_admin_token', { ...cookieOptions(), maxAge: 0 });
  return ok(res, { message: 'Signed out' });
});

/** PUT /api/admin/auth/profile */
exports.updateProfile = asyncHandler(async (req, res) => {
  const allowed = ['name', 'email', 'phone', 'avatar', 'username'];
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) req.admin[f] = req.body[f];
  });
  await req.admin.save();
  return ok(res, publicAdmin(req.admin));
});

/** PUT /api/admin/auth/password — credentials live in the DB and are changeable. */
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = await Admin.findById(req.admin._id).select('+password');

  if (!(await admin.comparePassword(currentPassword))) {
    throw ApiError.badRequest('Current password is incorrect');
  }
  admin.password = newPassword;
  await admin.save();

  const token = signToken(admin);
  res.cookie('sx_admin_token', token, cookieOptions());
  return ok(res, { token, message: 'Password updated' });
});
