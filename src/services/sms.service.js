/**
 * SMS via Fast2SMS.
 *
 * ENV
 * ---
 *   FAST2SMS_API_KEY           required to actually send
 *   FAST2SMS_ROUTE             otp | dlt | q          (default: otp)
 *   FAST2SMS_SENDER_ID         e.g. FSTSMS            (used by dlt / q)
 *   FAST2SMS_DLT_TEMPLATE_ID   required when route=dlt
 *   OTP_DEV_FALLBACK           true → if the send fails, log the code and let
 *                              verification continue instead of erroring
 *
 * ROUTES
 *   otp  Fast2SMS's own OTP route. No DLT template needed, message is fixed to
 *        "Your OTP: NNNNNN". Fastest way to get working.
 *   dlt  Your DLT-approved template. Required for a branded sender id and for
 *        volume. Needs FAST2SMS_DLT_TEMPLATE_ID + FAST2SMS_SENDER_ID.
 *   q    Quick transactional. No DLT, but promotional-grade delivery — codes
 *        can arrive late or not at all. Not recommended for OTP.
 */
const axios = require('axios');
const logger = require('../utils/logger');

const KEY = () => process.env.FAST2SMS_API_KEY || '';
const ROUTE = () => (process.env.FAST2SMS_ROUTE || 'otp').toLowerCase().trim();
const SENDER = () => process.env.FAST2SMS_SENDER_ID || 'FSTSMS';
const DLT_TEMPLATE = () => process.env.FAST2SMS_DLT_TEMPLATE_ID || '';
const DEV_FALLBACK = () => String(process.env.OTP_DEV_FALLBACK).toLowerCase() === 'true';

const ENDPOINT = 'https://www.fast2sms.com/dev/bulkV2';

const isConfigured = () => Boolean(KEY());

/** Build the Fast2SMS query for the selected route. */
function buildParams(phone, code) {
  const base = { authorization: KEY(), numbers: phone };
  const route = ROUTE();

  if (route === 'dlt') {
    if (!DLT_TEMPLATE()) {
      logger.warn('FAST2SMS_ROUTE=dlt but FAST2SMS_DLT_TEMPLATE_ID is empty — falling back to the otp route.');
      return { ...base, route: 'otp', variables_values: String(code) };
    }
    return {
      ...base,
      route: 'dlt',
      sender_id: SENDER(),
      message: DLT_TEMPLATE(),
      variables_values: String(code),
    };
  }

  if (route === 'q') {
    return {
      ...base,
      route: 'q',
      sender_id: SENDER(),
      message: `Your Shubham Xerox verification code is ${code}. Valid for a few minutes. Do not share it.`,
    };
  }

  // default: otp
  return { ...base, route: 'otp', variables_values: String(code) };
}

/**
 * @returns {{sent:boolean, channel:string, fallback?:boolean}}
 *   `fallback: true` means the SMS did not go out but OTP_DEV_FALLBACK let the
 *   flow continue with the code written to the log.
 */
async function sendOtp(phone, code) {
  if (!isConfigured()) {
    logger.warn(
      `FAST2SMS_API_KEY is not set — OTP for ${phone} is ${code}. ` +
      'Development behaviour only; set the key before taking real orders.',
    );
    return { sent: false, channel: 'log', fallback: true };
  }

  try {
    const { data } = await axios.get(ENDPOINT, { params: buildParams(phone, code), timeout: 15000 });

    if (data?.return === true) {
      return { sent: true, channel: ROUTE() };
    }

    // Fast2SMS answers 200 with return:false for business errors — a spent
    // wallet, an unapproved DLT template, a blocked number.
    logger.error(`Fast2SMS refused the message: ${JSON.stringify(data).slice(0, 300)}`);
    if (DEV_FALLBACK()) {
      logger.warn(`OTP_DEV_FALLBACK is on — OTP for ${phone} is ${code}`);
      return { sent: false, channel: 'log', fallback: true };
    }
    return { sent: false, channel: 'error' };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    logger.error(`Fast2SMS request failed: ${detail}`);
    if (DEV_FALLBACK()) {
      logger.warn(`OTP_DEV_FALLBACK is on — OTP for ${phone} is ${code}`);
      return { sent: false, channel: 'log', fallback: true };
    }
    return { sent: false, channel: 'error' };
  }
}

module.exports = { sendOtp, isConfigured, route: ROUTE };
