/**
 * Global Real-Time Debug Logger for Shiprocket / Fastrr / Checkout requests.
 * Strictly captures ONLY Payment, Webhook, Order, Shipping, Cart Validation and Error calls.
 * Ignores all routine catalogue, collection, product, and image requests.
 */
const logger = require('./logger');

const maxLogs = 100;
const debugLogs = [];

function recordDebugLog(entry) {
  if (entry && entry.url && /collections|products|categories|catalog|img|uploads/i.test(entry.url)) {
    return;
  }
  debugLogs.unshift({
    id: Date.now() + '-' + Math.random().toString(36).substring(2, 7),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (debugLogs.length > maxLogs) debugLogs.pop();
}

function clearDebugLogs() {
  debugLogs.length = 0;
}

function getDebugLogs() {
  return debugLogs.filter(l => l && l.url && !/collections|products|categories|catalog|img|uploads/i.test(l.url));
}

/** Global middleware mounted early in app.js */
function globalDebugMiddleware(req, res, next) {
  const url = req.originalUrl || req.url || '';
  const path = req.path || '';

  // 1. HARD IGNORE all catalogue sync, product fetch, collection fetch, image and static requests (regardless of HTTP method or /shiprocket-checkout/ prefix)
  if (/collections|products|categories|catalog|img|uploads|sitemap|robots|favicon|health|ping/i.test(url)) {
    return next();
  }

  // 2. ONLY RECORD relevant webhook, payment, order creation, shipping, loyalty & error calls
  // Note: We check specific path matches or actions, NOT just generic "checkout" string because route prefix is /shiprocket-checkout/
  const isTarget = /webhook|create-order|confirm-order|serviceability|shipping|payment|razorpay|validate|coupon|loyalty|verify/i.test(url) 
                || (req.method === 'POST' && /order|checkout/i.test(url));
  const isDebugPage = url.includes('/debug') || url.includes('/webhook-logs');

  if (!isTarget || isDebugPage) {
    return next();
  }

  const startTime = Date.now();
  const originalJson = res.json;
  const originalSend = res.send;
  let responseData = null;

  res.json = function (body) {
    responseData = body;
    return originalJson.apply(this, arguments);
  };

  res.send = function (body) {
    if (!responseData) {
      try {
        responseData = typeof body === 'string' ? JSON.parse(body) : body;
      } catch {
        responseData = String(body || '').substring(0, 1000);
      }
    }
    return originalSend.apply(this, arguments);
  };

  res.on('finish', () => {
    recordDebugLog({
      method: req.method,
      url: req.originalUrl,
      path: req.path,
      ip: req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'] || '',
      headers: {
        'content-type': req.headers['content-type'],
        'x-api-hmac-sha256': req.headers['x-api-hmac-sha256'] || req.headers['x-shiprocket-signature'] || req.headers['x-fastrr-signature'],
        authorization: req.headers.authorization ? 'Bearer [HIDDEN]' : undefined,
      },
      query: req.query,
      body: req.body,
      responseStatus: res.statusCode,
      responseBody: responseData,
      durationMs: Date.now() - startTime,
    });
  });

  next();
}

/** Renders a live 0.5s auto-refreshing dark-mode HTML dashboard */
function renderDebugDashboardHtml(req, res) {
  const logsJson = JSON.stringify(debugLogs);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shiprocket / Fastrr Payment & Webhook Debugger</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #131c2e;
      --border: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
    }
    body {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 20px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 15px;
      border-bottom: 2px solid var(--border);
      margin-bottom: 20px;
    }
    h1 { margin: 0; font-size: 1.4rem; color: var(--accent); }
    .controls { display: flex; gap: 10px; align-items: center; }
    button {
      background: #0284c7;
      color: white;
      border: none;
      padding: 10px 18px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: bold;
      font-size: 0.9rem;
    }
    button:hover { background: #0369a1; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: bold;
      font-size: 0.95rem;
    }
    .badge-200 { background: #14532d; color: #4ade80; border: 1px solid #22c55e; }
    .badge-400, .badge-500 { background: #7f1d1d; color: #f87171; border: 1px solid #ef4444; }
    .log-card {
      background: var(--card);
      border: 2px solid var(--border);
      border-radius: 10px;
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .log-card.error-card {
      border-color: #ef4444;
      background: #1c0f16;
    }
    .log-card.success-card {
      border-color: #22c55e;
      background: #0c1a14;
    }
    .log-header {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .method { font-weight: bold; font-size: 1.1rem; color: var(--accent); }
    .url { font-weight: bold; font-size: 1rem; color: #fff; word-break: break-all; margin-left: 8px; }
    .time { color: var(--muted); font-size: 0.9rem; }
    pre {
      background: #050811;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.85rem;
      max-height: 300px;
      border: 1px solid #1e293b;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    .label { color: var(--accent); font-size: 0.85rem; text-transform: uppercase; margin-bottom: 6px; font-weight: bold; }
    .empty { text-align: center; color: var(--muted); padding: 60px; font-size: 1.1rem; line-height: 1.8; }
    .live-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      background: #22c55e;
      border-radius: 50%;
      margin-right: 6px;
      box-shadow: 0 0 8px #22c55e;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1><span class="live-dot"></span> LIVE Payment & Order Webhook Inspector</h1>
      <small style="color: var(--muted);">Auto-refreshes every 0.5 sec. Filtered to ONLY show Payment, Webhook, Order & Error calls. Total logs: <span id="count">0</span></small>
    </div>
    <div class="controls">
      <button onclick="copyLogs()">📋 Copy All Logs for Fastrr Support</button>
      <button class="btn-danger" onclick="clearLogs()">🗑️ Clear Logs</button>
    </div>
  </div>

  <div id="logs-container"></div>

  <script>
    let logs = ${logsJson};

    function render() {
      document.getElementById('count').innerText = logs.length;
      const container = document.getElementById('logs-container');
      if (!logs.length) {
        container.innerHTML = '<div class="empty">⏳ <strong>Waiting for Payment / Webhook Activity…</strong><br>Routine collection/products sync links have been hidden.<br>Make a payment or COD order now on shubhamxerox.in — the exact order payload & failure error will show up here instantly.</div>';
        return;
      }
      container.innerHTML = logs.map(l => {
        const isErr = l.responseStatus >= 400;
        const cardClass = isErr ? 'error-card' : 'success-card';
        const badgeClass = isErr ? 'badge-400' : 'badge-200';
        return \`
          <div class="log-card \${cardClass}">
            <div class="log-header">
              <div>
                <span class="method">\${l.method}</span>
                <span class="url">\${l.url}</span>
              </div>
              <div>
                <span class="status-badge \${badgeClass}">\${l.responseStatus || 'PENDING'} (\${l.durationMs || 0}ms)</span>
                <span class="time">\${new Date(l.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
            <div style="font-size: 0.85rem; color: var(--muted); margin-bottom: 12px;">
              IP: \${l.ip} | User-Agent: \${l.userAgent}
            </div>
            <div class="grid">
              <div>
                <div class="label">📥 Incoming Request Payload (From Fastrr / Client):</div>
                <pre>\${JSON.stringify(l.body || {}, null, 2)}</pre>
              </div>
              <div>
                <div class="label">📤 Response Returned By Server:</div>
                <pre>\${JSON.stringify(l.responseBody || {}, null, 2)}</pre>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    render();

    setInterval(() => {
      fetch('/shiprocket-checkout/debug/data')
        .then(r => r.json())
        .then(data => {
          if (data.logs) {
            logs = data.logs;
            render();
          }
        }).catch(() => {});
    }, 500);

    function clearLogs() {
      fetch('/shiprocket-checkout/debug/clear').then(() => { logs = []; render(); });
    }

    function copyLogs() {
      navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
      alert('Copied all JSON logs to clipboard!');
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = {
  recordDebugLog,
  clearDebugLogs,
  getDebugLogs,
  globalDebugMiddleware,
  renderDebugDashboardHtml,
};
