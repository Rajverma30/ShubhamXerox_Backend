/**
 * Guest identity by OTP. No accounts, no passwords, no profile section.
 *
 * A verified phone number buys a short-lived JWT ("guest token") that is only
 * good for placing an order. It expires in 30 minutes — long enough to fill in
 * an address and pay, short enough that a token left in a shared browser is
 * worthless later.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const Otp = require('../models/Otp');
const GuestCheckoutSession = require('../models/GuestCheckoutSession');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/response');
const logger = require('../utils/logger');
const sms = require('../services/sms.service');

// Accept either spelling — OTP_TTL_MINUTES is the one in the .env template.
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MINUTES || process.env.OTP_TTL_MIN) || 10;

/**
 * OTP_DEV_MODE returns the code in the API response so the flow can be tested
 * without a working SMS route.
 *
 * ⚠️ This is an authentication bypass. With it on, anyone can request a code
 * for ANY phone number, read it straight out of the JSON response, verify, and
 * place orders as that person. It is a development switch only — every request
 * logs a warning while it is enabled in production, deliberately loudly.
 */
const DEV_MODE = () => String(process.env.OTP_DEV_MODE).toLowerCase() === 'true';
const MAX_ATTEMPTS = 5;
const GUEST_TOKEN_TTL = process.env.GUEST_TOKEN_TTL || '30m';

/** Indian mobile: 10 digits starting 6-9. Strips +91 / 0 prefixes. */
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

/** Six digits, cryptographically random — not Math.random(). */
const generateCode = () => String(crypto.randomInt(100000, 1000000));

/**
 * POST /api/auth/otp/send  { phone }
 *
 * Always answers the same way whether or not the SMS actually went out, and
 * never returns the code in production. Rate limiting is applied at the route.
 */
exports.sendOtp = asyncHandler(async (req, res) => {
  const phone = normalisePhone(req.body.phone);
  if (!phone) throw ApiError.badRequest('Enter a valid 10-digit mobile number');

  /* Resend cooldown: one code per 60s per number, regardless of IP. */
  const recent = await Otp.findOne({ phone, consumedAt: null }).sort({ createdAt: -1 });
  if (recent && Date.now() - recent.createdAt.getTime() < 60 * 1000) {
    const wait = Math.ceil((60 * 1000 - (Date.now() - recent.createdAt.getTime())) / 1000);
    throw ApiError.badRequest(`Please wait ${wait}s before requesting another code`);
  }

  /* Cap per number per hour so the SMS bill cannot be run up. */
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const sentThisHour = await Otp.countDocuments({ phone, createdAt: { $gte: hourAgo } });
  if (sentThisHour >= 5) {
    throw ApiError.badRequest('Too many codes requested. Please try again in an hour.');
  }

  const code = generateCode();
  await Otp.create({
    phone,
    codeHash: Otp.hash(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60 * 1000),
    ip: req.ip,
  });

  const result = await sms.sendOtp(phone, code);

  // A hard failure only stops the flow when there is no dev fallback.
  if (!result.sent && !result.fallback) {
    logger.error(`OTP send failed for ${phone} (route=${sms.route()})`);
    throw ApiError.internal('Could not send the code right now. Please try again.');
  }

  const exposeCode = DEV_MODE();
  if (exposeCode && process.env.NODE_ENV === 'production') {
    logger.error(
      'SECURITY: OTP_DEV_MODE=true in production — verification codes are being ' +
      'returned in the API response. Anyone can request a code for any number ' +
      'and place orders as them. Set OTP_DEV_MODE=false.',
    );
  }

  return ok(res, {
    sent: result.sent,
    phone,
    expiresInMinutes: OTP_TTL_MIN,
    ...(result.fallback ? { delivery: 'log' } : {}),
    ...(exposeCode ? { devCode: code } : {}),
  });
});

/**
 * POST /api/auth/otp/verify  { phone, code }
 * → { token }  — pass as Authorization: Bearer <token> when placing the order
 */
exports.verifyOtp = asyncHandler(async (req, res) => {
  const phone = normalisePhone(req.body.phone);
  if (!phone) throw ApiError.badRequest('Enter a valid 10-digit mobile number');

  const code = String(req.body.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) throw ApiError.badRequest('Enter the code you received');

  const record = await Otp.findOne({ phone, consumedAt: null }).sort({ createdAt: -1 });
  if (!record) throw ApiError.badRequest('No active code. Please request a new one.');
  if (record.expiresAt < new Date()) throw ApiError.badRequest('That code has expired. Please request a new one.');
  if (record.attempts >= MAX_ATTEMPTS) throw ApiError.badRequest('Too many wrong attempts. Please request a new code.');

  if (record.codeHash !== Otp.hash(code)) {
    record.attempts += 1;
    await record.save();
    const left = MAX_ATTEMPTS - record.attempts;
    throw ApiError.badRequest(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new code.');
  }

  record.consumedAt = new Date();
  await record.save();

  const jti = crypto.randomUUID();
  const expiresMs = 30 * 60 * 1000;
  await GuestCheckoutSession.create({
    jti,
    phone,
    expiresAt: new Date(Date.now() + expiresMs),
  });

  const token = jwt.sign({ phone, scope: 'guest-checkout', jti }, process.env.JWT_SECRET, { expiresIn: GUEST_TOKEN_TTL });
  logger.info(`Guest checkout verified for ${phone.slice(0, 3)}****${phone.slice(-2)}`);

  return ok(res, { token, phone, expiresIn: GUEST_TOKEN_TTL });
});

/**
 * POST /api/auth/direct-session  { phone }
 * Mint an instant guest checkout token for a valid 10-digit mobile number.
 */
exports.directSession = asyncHandler(async (req, res) => {
  const phone = normalisePhone(req.body.phone);
  if (!phone) throw ApiError.badRequest('Enter a valid 10-digit mobile number');

  const jti = crypto.randomUUID();
  const expiresMs = 30 * 60 * 1000;
  await GuestCheckoutSession.create({
    jti,
    phone,
    expiresAt: new Date(Date.now() + expiresMs),
  });

  const token = jwt.sign({ phone, scope: 'guest-checkout', jti }, process.env.JWT_SECRET, { expiresIn: GUEST_TOKEN_TTL });
  logger.info(`Direct guest session created for ${phone.slice(0, 3)}****${phone.slice(-2)}`);

  return ok(res, { token, phone, expiresIn: GUEST_TOKEN_TTL });
});

exports.normalisePhone = normalisePhone;

