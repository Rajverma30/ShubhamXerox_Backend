/**
 * WhatsApp Notification Service for Shubham Xerox.
 *
 * ENV variables:
 *   WHATSAPP_API_URL         (Optional) REST API Endpoint for WhatsApp Gateway (e.g. Meta Cloud API, UltraMsg, Wati, Interakt, Twilio)
 *   WHATSAPP_API_KEY         (Optional) Authorization API Key / Bearer token
 *   WHATSAPP_SENDER_NUMBER   (Optional) Defaults to 9826462963
 *   WHATSAPP_ENABLED         (Optional) "true" or "false" (default: true)
 */
const axios = require('axios');
const logger = require('../utils/logger');

function getFrontendUrl() {
  let url = process.env.FRONTEND_URL || 'https://www.shubhamxerox.in';
  return url.replace(/\/+$/, '');
}

function getSenderNumber() {
  return process.env.WHATSAPP_SENDER_NUMBER || '9826462963';
}

function normalisePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits.slice(-10) ? `91${digits.slice(-10)}` : digits;
}

/**
 * Builds direct payment link for an order awaiting payment.
 * When clicked on mobile/browser, OrderPlaced component loads the order and displays "Complete Payment Now".
 */
function buildPaymentUrl(orderNumber, customerPhone) {
  const phoneDigits = String(customerPhone || '').replace(/\D/g, '').slice(-10);
  const baseUrl = getFrontendUrl();
  return `${baseUrl}/order-placed?order=${encodeURIComponent(orderNumber)}&phone=${encodeURIComponent(phoneDigits)}`;
}

/**
 * Build Payment Pending / Abandoned Checkout WhatsApp message text.
 */
function buildPaymentPendingMessage(order) {
  const name = order.customer?.name || 'Customer';
  const orderNum = order.orderNumber || '';
  const total = order.total || 0;
  const payUrl = buildPaymentUrl(orderNum, order.customer?.phone);
  const sender = getSenderNumber();

  return (
    `Namaste ${name}! 🙏\n\n` +
    `Aapka Shubham Xerox Order #${orderNum} (₹${total}) abhi payment ka wait kar raha hai.\n\n` +
    `Agar payment ke dauran koi issue aaya hai, toh aap neeche diye gaye link se aasani se payment complete kar sakte hain 👇\n\n` +
    `🔗 *Complete Payment:* \n` +
    `${payUrl}\n\n` +
    `Agar payment ko lekar koi problem ya query ho, toh hume WhatsApp par ${sender} par message karein. 💬\n\n` +
    `Dhanyawad! ❤️\n` +
    `Shubham Xerox Team`
  );
}

/**
 * Build Order Confirmation / Greeting WhatsApp message text.
 */
function buildOrderConfirmationMessage(order) {
  const name = order.customer?.name || 'Customer';
  const orderNum = order.orderNumber || '';
  const total = order.total || 0;
  const itemCount = (order.items || []).length;
  const orderUrl = buildPaymentUrl(orderNum, order.customer?.phone);
  const sender = getSenderNumber();

  return (
    `Namaste ${name}! 🙏\n\n` +
    `Shubham Xerox par aapka order successfully confirm ho gaya hai! 🎉\n\n` +
    `Aapka payment (₹${total}) hume mil chuka hai. Hum aapke order par kaam shuru kar rahe hain. 📦\n\n` +
    `📋 *Order Summary:*\n` +
    `• Order Number: #${orderNum}\n` +
    `• Total Items: ${itemCount} item(s)\n` +
    `• Amount Paid: ₹${total}\n\n` +
    `🔗 *View Order Details:* \n` +
    `${orderUrl}\n\n` +
    `Kisi bhi help ya query ke liye hume is WhatsApp number par contact karein: ${sender} 💬\n\n` +
    `Dhanyawad! ❤️\n` +
    `Shubham Xerox Team`
  );
}

/**
 * Send a WhatsApp message.
 * Supports configured WhatsApp API Gateway (Meta, UltraMsg, Wati, Interakt, Twilio, etc.)
 * or logs wa.me deep-link in fallback mode when API key is not configured.
 */
async function sendWhatsAppMessage({ phone, message }) {
  const targetPhone = normalisePhone(phone);
  if (!targetPhone) {
    logger.warn('WhatsApp send failed: Invalid target phone number');
    return { sent: false, error: 'Invalid phone number' };
  }

  const encodedMsg = encodeURIComponent(message);
  const waLink = `https://wa.me/${targetPhone}?text=${encodedMsg}`;

  const apiUrl = process.env.WHATSAPP_API_URL;
  const apiKey = process.env.WHATSAPP_API_KEY;

  if (!apiUrl || !apiKey) {
    logger.info(`[WhatsApp Service] (Dev/Fallback mode) Message to ${targetPhone}:\n${message}\nDeep-link: ${waLink}`);
    return { sent: true, channel: 'log', waLink, message };
  }

  try {
    let response;
    
    if (apiUrl.includes('ultramsg.com')) {
      // UltraMsg native request format (application/x-www-form-urlencoded)
      const formattedTo = targetPhone.startsWith('+') ? targetPhone : `+${targetPhone}`;
      const params = new URLSearchParams();
      params.append('token', apiKey);
      params.append('to', formattedTo);
      params.append('body', message);

      response = await axios.post(apiUrl, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      });
    } else {
      // Generic JSON REST Gateway format (Meta Cloud API, Wati, Interakt, etc.)
      const payload = {
        token: apiKey,
        phone: targetPhone,
        to: targetPhone,
        message,
        body: message,
        sender: getSenderNumber(),
      };

      response = await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'x-api-key': apiKey,
        },
        timeout: 10000,
      });
    }

    logger.info(`WhatsApp message successfully dispatched to ${targetPhone} via API`);
    return { sent: true, channel: 'api', responseData: response.data, waLink, message };
  } catch (err) {
    const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`WhatsApp API call failed for ${targetPhone}: ${errorMsg}`);
    return { sent: false, channel: 'api-error', error: errorMsg, waLink, message };
  }
}

/**
 * Send Payment Pending Notification for an Order.
 */
async function sendPaymentPendingWhatsApp(order) {
  if (!order || !order.customer?.phone) return { sent: false, error: 'No customer phone' };
  const message = buildPaymentPendingMessage(order);
  return sendWhatsAppMessage({ phone: order.customer.phone, message });
}

/**
 * Send Order Confirmation Greeting for an Order.
 */
async function sendOrderConfirmationWhatsApp(order) {
  if (!order || !order.customer?.phone) return { sent: false, error: 'No customer phone' };
  const message = buildOrderConfirmationMessage(order);
  return sendWhatsAppMessage({ phone: order.customer.phone, message });
}

module.exports = {
  sendWhatsAppMessage,
  sendPaymentPendingWhatsApp,
  sendOrderConfirmationWhatsApp,
  buildPaymentPendingMessage,
  buildOrderConfirmationMessage,
  buildPaymentUrl,
  getSenderNumber,
};
