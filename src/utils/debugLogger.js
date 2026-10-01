/**
 * Global Real-Time Debug Logger for Shiprocket / Fastrr / Checkout requests.
 * Records all incoming traffic matching checkout/webhook/fastrr/order keywords,
 * capturing request headers, body, client IP, response status, and response body.
 */
const logger = require('./logger');

const maxLogs = 100;
const debugLogs = [];

function recordDebugLog(entry) {
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
  return debugLogs;
}

/** Global middleware mounted early in app.js */
function globalDebugMiddleware(req, res, next) {
  const url = req.originalUrl || req.url || '';
  const isRelevant = /shiprocket|fastrr|checkout|webhook|order|cart|loyalty|serviceability/i.test(url);

  if (!isRelevant || url.includes('/debug') || url.includes('/webhook-logs')) {
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
        responseData = String(body || '').substring(0, 500);
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

/** Renders a live auto-refreshing dark-mode HTML dashboard */
function renderDebugDashboardHtml(req, res) {
  const logsJson = JSON.stringify(debugLogs);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subham Xerox — Live Webhook & Checkout Debugger</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --green: #4ade80;
      --red: #f87171;
      --yellow: #facc15;
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
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    h1 { margin: 0; font-size: 1.3rem; color: var(--accent); }
    .controls { display: flex; gap: 10px; align-items: center; }
    button {
      background: #0284c7;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: bold;
    }
    button:hover { background: #0369a1; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 0.85rem;
    }
    .badge-200 { background: #166534; color: var(--green); }
    .badge-400, .badge-500 { background: #991b1b; color: var(--red); }
    .log-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 15px;
    }
    .log-header {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .method { font-weight: bold; color: var(--accent); }
    .url { font-weight: bold; color: #fff; word-break: break-all; }
    .time { color: var(--muted); font-size: 0.85rem; }
    pre {
      background: #090d16;
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.85rem;
      max-height: 250px;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    .label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; margin-bottom: 4px; }
    .empty { text-align: center; color: var(--muted); padding: 50px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>⚡ Subham Xerox — Real-Time Checkout Debugger</h1>
      <small style="color: var(--muted);">Auto-refreshes every 3 seconds. Total captured logs: <span id="count">0</span></small>
    </div>
    <div class="controls">
      <button onclick="copyLogs()">📋 Copy JSON for Support</button>
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
        container.innerHTML = '<div class="empty">No checkout or webhook requests captured yet.<br>Place a test order on shubhamxerox.in to see live HTTP logs here.</div>';
        return;
      }
      container.innerHTML = logs.map(l => {
        const badgeClass = l.responseStatus >= 200 && l.responseStatus < 300 ? 'badge-200' : 'badge-400';
        return \`
          <div class="log-card">
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
            <div style="font-size: 0.8rem; color: var(--muted); margin-bottom: 10px;">
              IP: \${l.ip} | User-Agent: \${l.userAgent}
            </div>
            <div class="grid">
              <div>
                <div class="label">Incoming Request Payload (Body):</div>
                <pre>\${JSON.stringify(l.body || {}, null, 2)}</pre>
              </div>
              <div>
                <div class="label">Server Response Sent Back:</div>
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
    }, 3000);

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
