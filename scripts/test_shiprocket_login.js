require('dotenv').config();
const axios = require('axios');

const emailRaw = process.env.SHIPROCKET_EMAIL || '';
const passRaw = process.env.SHIPROCKET_PASSWORD || '';
const email = String(emailRaw).trim().replace(/^["']|["']$/g, '');
const pass = String(passRaw).trim().replace(/^["']|["']$/g, '');
const pick = String(process.env.SHIPROCKET_PICKUP_LOCATION || '').trim();
const base = process.env.SHIPROCKET_BASE_URL || 'https://apiv2.shiprocket.in/v1/external';

function maskEmail(e) {
  if (!e || !e.includes('@')) return e ? `(len=${e.length}, no @)` : null;
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}***@${d}`;
}

(async () => {
  const report = {
    emailSet: !!email,
    emailMasked: maskEmail(email),
    emailLen: email.length,
    emailHasWhitespace: /\s/.test(emailRaw),
    passwordSet: !!pass,
    passwordLen: pass.length,
    pickup: pick,
    base,
  };

  if (!email || !pass) {
    console.log(JSON.stringify({ ...report, login: 'SKIPPED — email or password empty in local .env' }, null, 2));
    process.exit(1);
  }

  try {
    const { status, data } = await axios.post(
      `${base}/auth/login`,
      { email, password: pass },
      { timeout: 20000, validateStatus: () => true },
    );
    report.loginHttpStatus = status;
    report.loginOk = Boolean(data?.token);
    report.loginBodyKeys = data && typeof data === 'object' ? Object.keys(data) : typeof data;
    report.loginMessage = data?.message || data?.error || null;
    if (data?.token) {
      report.tokenLen = String(data.token).length;
      // Try listing pickup locations / channels to verify permissions
      try {
        const ch = await axios.get(`${base}/channels`, {
          headers: { Authorization: `Bearer ${data.token}` },
          timeout: 20000,
          validateStatus: () => true,
        });
        report.channelsStatus = ch.status;
        report.channelsMessage = ch.data?.message || null;
        report.channelCount = Array.isArray(ch.data?.data) ? ch.data.data.length : null;
      } catch (e) {
        report.channelsError = e.message;
      }
      try {
        const settings = await axios.get(`${base}/settings/company/pickup`, {
          headers: { Authorization: `Bearer ${data.token}` },
          timeout: 20000,
          validateStatus: () => true,
        });
        report.pickupApiStatus = settings.status;
        const locs = settings.data?.data?.shipping_address || settings.data?.data || settings.data;
        if (Array.isArray(locs)) {
          report.pickupNames = locs.map((l) => l.pickup_location || l.name || l).filter(Boolean);
          report.pickupMatch = report.pickupNames.includes(pick);
        } else {
          report.pickupRawType = typeof locs;
          report.pickupMessage = settings.data?.message || null;
        }
      } catch (e) {
        report.pickupError = e.message;
      }
    } else {
      report.loginBodyPreview =
        typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 300);
    }
  } catch (err) {
    report.loginNetworkError = err.message;
    report.loginHttpStatus = err.response?.status || null;
    report.loginBodyPreview = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : null;
  }

  console.log(JSON.stringify(report, null, 2));
})();
