/**
 * Transactional mail for the contact form and admin replies.
 *
 * Order confirmation and shipping-status emails are sent by Shiprocket
 * Checkout, which owns the order, so they are deliberately absent here.
 * No-ops (with a log line) when SMTP is unconfigured, so local development
 * never breaks on a missing mail server.
 */
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter = null;

function getTransporter() {
  if (transporter !== null) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_EMAIL) {
    transporter = false;
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD },
  });
  return transporter;
}

async function send({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    logger.warn(`[mail skipped] "${subject}" -> ${to} (SMTP not configured)`);
    return { skipped: true };
  }
  return t.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Shubham Xerox'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_EMAIL}>`,
    to,
    subject,
    text,
    html,
  });
}

const shell = (title, body) => `
<div style="font-family:Inter,Segoe UI,Arial,sans-serif;background:#f6f7fb;padding:32px">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,.08)">
    <div style="padding:22px 28px;background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff">
      <h1 style="margin:0;font-size:19px;letter-spacing:-.3px">Shubham Xerox</h1>
      <p style="margin:4px 0 0;font-size:12px;opacity:.7">Books &amp; Stationery</p>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 14px;font-size:17px;color:#0f172a">${title}</h2>
      ${body}
    </div>
    <div style="padding:16px 28px;background:#f8fafc;color:#64748b;font-size:11px">
      You are receiving this email because you placed an order or subscribed at Shubham Xerox.
    </div>
  </div>
</div>`;

exports.send = send;

exports.sendContactNotification = (msg) =>
  send({
    to: process.env.STORE_EMAIL || process.env.SMTP_EMAIL,
    subject: `New enquiry: ${msg.subject || 'Website contact form'}`,
    html: shell(
      'New contact message',
      `<p style="font-size:13px;color:#475569"><b>${msg.name}</b> &lt;${msg.email}&gt; ${msg.phone || ''}</p>
       <p style="font-size:14px;color:#0f172a;white-space:pre-wrap">${msg.message}</p>`,
    ),
  });
