/**
 * `npm run gokwik:check` — is this server ready for GoKwik to call?
 *
 * Walks the same path GoKwik's servers walk, against the PUBLIC address of
 * this API (BACKEND_URL), so it also catches what a local test cannot: a
 * reverse proxy that swallows /wp-json, a missing https certificate, headers
 * stripped on the way in.
 *
 *   npm run gokwik:check                         # tests BACKEND_URL
 *   npm run gokwik:check -- http://localhost:5005 # tests a local server
 *
 * It opens a checkout session and reads the cart. It places NO order and
 * never contacts GoKwik. The App ID and App Secret are sent only to your own
 * server, and are never printed.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const axios = require('axios');
const gokwik = require('../services/gokwik/api');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;
const ok = (m) => console.log(`  ${GREEN}✓${RESET} ${m}`);
const warn = (m) => console.log(`  ${YELLOW}!${RESET} ${m}`);
const bad = (m, fix) => { failures += 1; console.log(`  ${RED}✗${RESET} ${m}${fix ? `\n      ${GREEN}fix:${RESET} ${fix}` : ''}`); };

(async () => {
  const cfg = gokwik.config();
  const host = String(process.argv[2] || process.env.BACKEND_URL || '').replace(/\/$/, '');
  const PREFIX = '/wp-json/gokwik/v1';

  console.log('\nCredentials (.env)');
  for (const [name, value] of [['GOKWIK_MID', cfg.mid], ['GOKWIK_APP_ID', cfg.appId], ['GOKWIK_APP_SECRET', cfg.appSecret]]) {
    if (value) ok(`${name} is set`);
    else bad(`${name} is empty`, `Paste it from the GoKwik dashboard into .env, then restart the server.`);
  }
  ok(`Environment: ${cfg.environment}  ${DIM}(GOKWIK_ENV)${RESET}`);

  console.log('\nServer');
  if (!host) {
    bad('BACKEND_URL is not set, so there is nothing to test.', 'Set BACKEND_URL in .env to the public https address of this API.');
    return finish();
  }
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  if (!local && !/^https:\/\//.test(host)) {
    bad(`${host} is not https — GoKwik will not call it, and the app secret must not travel over plain http.`);
    return finish();
  }
  if (local) warn(`Testing ${host} — fine for a local check, but GoKwik needs the public https URL.`);

  const http = axios.create({ baseURL: host, timeout: 20000, validateStatus: () => true });
  const explain = (res) => (typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 160) : `non-JSON reply (${String(res.data).slice(0, 60).replace(/\s+/g, ' ')}…)`);

  /* 1. reachable at the path GoKwik calls */
  let res;
  try {
    res = await http.post(`${PREFIX}/cart/health-check`);
  } catch (err) {
    bad(`Could not reach ${host}: ${err.message}`, 'Is the server running, and is BACKEND_URL its public address?');
    return finish();
  }
  if (res.status === 200 && res.data?.status === 'success') ok(`${host}${PREFIX}/cart/health-check answers`);
  else {
    bad(
      `health-check returned HTTP ${res.status}: ${explain(res)}`,
      'The running server does not have the GoKwik routes — deploy this code and restart. If it does, the reverse proxy (nginx) is not passing /wp-json/ through to Node.',
    );
    return finish();
  }

  /* 2. locked without credentials */
  res = await http.post(`${PREFIX}/cart`, { session_key: 'x' });
  if (res.status === 401) ok('Cart API refuses a request without the app id/secret');
  else bad(`Cart API answered HTTP ${res.status} without credentials — it must be 401.`);

  if (!gokwik.configured()) return finish();

  /* 3. a real cart, read the way GoKwik reads it */
  res = await http.get('/api/products', { params: { limit: 20 } });
  const list = Array.isArray(res.data?.data) ? res.data.data : res.data?.data?.items || [];
  const product = list.find((p) => p.type === 'ebook' || p.allowBackorder || (p.stock ?? 0) > 0);
  if (!product) {
    warn('No in-stock product found through /api/products, so the cart could not be tested.');
    return finish();
  }

  res = await http.post('/api/checkout/session', { items: [{ productId: product._id, slug: product.slug, quantity: 1 }] });
  const sessionKey = res.data?.data?.sessionKey;
  if (res.status !== 200 || !sessionKey) {
    bad(
      `POST /api/checkout/session returned HTTP ${res.status}: ${explain(res)}`,
      'If the message says checkout is not set up, the RUNNING server has no GoKwik credentials — update its .env and restart it.',
    );
    return finish();
  }
  ok('Storefront can open a checkout session');
  if (res.data.data.mid !== cfg.mid) warn('The running server reports a different Merchant ID from this .env — was it restarted after the change?');

  const headers = { appid: cfg.appId, appsecret: cfg.appSecret };
  res = await http.post(`${PREFIX}/cart`, { session_key: sessionKey }, { headers });
  if (res.status === 401) {
    bad(
      'The cart API rejected the App ID / App Secret from this .env.',
      'Either the running server has different values (restart it), or a proxy is dropping the appid/appsecret headers.',
    );
    return finish();
  }
  if (res.status !== 200 || !res.data?.totals) {
    bad(`Cart API returned HTTP ${res.status}: ${explain(res)}`);
    return finish();
  }
  const { totals, items } = res.data;
  ok(`Cart API returns the cart: "${String(items[0]?.product_data?.name).slice(0, 40)}" — subtotal ₹${totals.subtotal}, delivery ₹${totals.shipping_total}, total ₹${totals.total}`);

  const image = items[0]?.product_data?.images?.[0]?.src;
  if (image && !/^https:\/\//.test(image) && !local) warn(`Product image URL is not https (${image}) — it may not show inside GoKwik's popup.`);

  res = await http.get(`${PREFIX}/cart/get-coupons`, { params: { session_key: sessionKey }, headers });
  if (res.status === 200 && Array.isArray(res.data?.coupons)) ok(`Coupon list answers (${res.data.coupons.length} offered for this cart)`);
  else bad(`get-coupons returned HTTP ${res.status}: ${explain(res)}`);

  return finish();

  function finish() {
    console.log('');
    if (failures) {
      console.log(`${RED}${failures} problem(s) to fix before GoKwik can use this server.${RESET}\n`);
      process.exit(1);
    }
    console.log(`${GREEN}Your side is ready.${RESET} What remains is on GoKwik's side: they must point Merchant ID`);
    console.log(`${cfg.mid || '(unset)'} at  ${host}  — see GOKWIK.md, "What to send GoKwik".\n`);
    process.exit(0);
  }
})().catch((err) => {
  console.error(`\n${RED}gokwik:check failed:${RESET}`, err.message);
  process.exit(1);
});
