// VoIPBell portal (eu1.voipbell.net) — login + fetch a panel's softphone QR.
// Reproduces the browser login: password = CryptoJS.AES.encrypt(plain, passphrase)
// where the passphrase rotates per page load and is scraped from the login page.
const axios = require('axios');
const CryptoJS = require('crypto-js');

const VB_URL = 'https://eu1.voipbell.net';
const VB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const session = { cookies: {}, ts: 0 };
const qrCache = {};                 // account -> { payload, intercomId, ts }
const QR_TTL = 60 * 60 * 1000;      // 1h (QR payload is stable per panel)
let chain = Promise.resolve();      // serialize all portal ops (single session per user)

// Rolling debug log (viewable at /api/manager/voipbell-debug)
const debugLog = [];
function dbg(step, extra) {
  debugLog.push({ t: new Date().toISOString(), step, ...(extra || {}) });
  while (debugLog.length > 60) debugLog.shift();
}
function snippet(data) {
  try { return String(typeof data === 'object' ? JSON.stringify(data) : data).replace(/\s+/g, ' ').slice(0, 300); }
  catch (e) { return '(unprintable)'; }
}
function getDebug() { return debugLog.slice(-40); }

function cookieHeader() {
  return Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(setCookie) {
  if (!setCookie) return;
  for (const c of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
    const first = c.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) session.cookies[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function vbGet(url, extra = {}) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': VB_UA, Cookie: cookieHeader(), ...extra },
    maxRedirects: 0, validateStatus: s => s >= 200 && s < 400, timeout: 20000,
  });
  storeCookies(res.headers['set-cookie']);
  dbg('GET', { url: url.split('?')[0] + (url.includes('print=') ? '?print' : url.includes('background=') ? '?list' : ''), status: res.status, len: String(res.data || '').length, body: snippet(res.data) });
  return res;
}
async function vbPostForm(url, fields, extra = {}) {
  const body = new URLSearchParams(fields).toString();
  const res = await axios.post(url, body, {
    headers: { 'User-Agent': VB_UA, Cookie: cookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded', ...extra },
    maxRedirects: 0, validateStatus: s => s >= 200 && s < 400, timeout: 20000,
  });
  storeCookies(res.headers['set-cookie']);
  return res;
}

// The portal's login page carries the password-encrypt login form. Detect it by
// those form markers (language-independent) — the prompt text itself is Spanish
// ("por favor introduzca los datos de acceso"), so matching English text failed
// and the page was wrongly treated as already-authenticated.
function isLoginPage(html) {
  if (typeof html !== 'string') return false;
  return /password_protect\(|do_login|index\.php\?a=login/i.test(html);
}

async function vbLogin() {
  const user = process.env.VOIPBELL_USER;
  const pass = process.env.VOIPBELL_PASS;
  if (!user || !pass) throw new Error('VoIPBell not configured (set VOIPBELL_USER / VOIPBELL_PASS)');

  // 1) GET the login page → scrape the rotating passphrase
  const page = await vbGet(`${VB_URL}/index.php`);
  const m = String(page.data).match(/CryptoJS\.AES\.encrypt\([^,]+,\s*["']([0-9a-fA-F]{16,})["']/);
  if (!m) {
    // No login form on the page — most likely we're already authenticated. Accept it.
    if (!isLoginPage(page.data)) { session.ts = Date.now(); return; }
    throw new Error('Could not scrape VoIPBell login passphrase');
  }
  const passphrase = m[1];

  // 2) encrypt exactly like the browser's password_protect()
  const encPass = CryptoJS.AES.encrypt(pass, passphrase).toString();

  // 3) small delay (the fresh passphrase must commit server-side) then POST
  await sleep(900);
  await vbPostForm(`${VB_URL}/index.php?a=login`,
    { username: user, password: encPass, do_login: '' },
    { Referer: `${VB_URL}/index.php` });

  // 4) verify
  const check = await vbGet(`${VB_URL}/index.php?p=intercom`);
  if (isLoginPage(check.data)) throw new Error('VoIPBell login failed (check creds / another session is active)');
  session.ts = Date.now();
}

async function ensureLogin() {
  if (session.ts && Date.now() - session.ts < 6 * 60 * 1000) return;  // trust a very recent login
  // Otherwise check the REAL auth state — only log in if actually logged out.
  // (Blindly re-logging in while the portal session is still valid returns the
  //  dashboard instead of the login form, so the passphrase scrape fails.)
  try {
    const r = await vbGet(`${VB_URL}/index.php?p=intercom`);
    if (!isLoginPage(r.data) && String(r.data).length > 500) { session.ts = Date.now(); return; }
  } catch (e) { /* fall through to login */ }
  // back-to-back logins can be rejected; retry a few times with back-off
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { await vbLogin(); return; }
    catch (e) { lastErr = e; await sleep(1000 * (i + 1)); }
  }
  throw lastErr;
}

// DataTables list query (minimal but with the columns the backend expects)
function listUrl(search) {
  const cols = ['action','name','client','description','softphones','monitors','card',
    'administration','pin_app','phonenumber_app','apartmentnumber_app','allow_ip','billing',
    'activated','last_register','status','validate_softphones'];
  const p = new URLSearchParams();
  p.set('background', 'intercom'); p.set('draw', '1');
  cols.forEach((c, i) => {
    p.set(`columns[${i}][data]`, c);
    p.set(`columns[${i}][searchable]`, 'true');
    p.set(`columns[${i}][orderable]`, 'false');
    p.set(`columns[${i}][search][value]`, '');
    p.set(`columns[${i}][search][regex]`, 'false');
  });
  p.set('order[0][column]', '1'); p.set('order[0][dir]', 'asc');
  p.set('start', '0'); p.set('length', '25');
  p.set('search[value]', search); p.set('search[regex]', 'false');
  p.set('_', String(Date.now()));
  return `${VB_URL}/index.php?${p.toString()}`;
}

// Fetch the QR "manual loading" payload for a VoIPBell account (intercom name).
// Returns { account, intercomId, payload }. payload is the base64 the QR encodes.
async function getQrForAccount(account) {
  const acct = String(account || '').trim();
  if (!acct) throw new Error('account required');

  const cached = qrCache[acct];
  if (cached && Date.now() - cached.ts < QR_TTL) return { account: acct, intercomId: cached.intercomId, payload: cached.payload };

  // serialize portal access (single session)
  const run = chain.then(async () => {
    dbg('getQr:start', { account: acct });

    // Fetch the list, parsing to JSON; one re-login + retry if it comes back as
    // HTML / a redirect / the login page (non-JSON).
    async function fetchList() {
      await ensureLogin();
      const res = await vbGet(listUrl(acct), { 'X-Requested-With': 'XMLHttpRequest', Referer: `${VB_URL}/index.php?p=intercom` });
      if (typeof res.data === 'object' && res.data && res.data.data) return res.data;       // already JSON
      if (typeof res.data === 'string') { try { return JSON.parse(res.data); } catch (e) {} }
      return null; // not JSON (redirect/login/html)
    }

    let data = await fetchList();
    if (!data) { dbg('list:not-json → re-login+retry'); session.ts = 0; data = await fetchList(); }
    if (!data) throw new Error('Unexpected VoIPBell list response (not JSON) — see voipbell-debug');

    const rows = (data && data.data) || [];
    dbg('list:ok', { rows: rows.length, names: rows.slice(0, 5).map(r => r.name) });
    const row = rows.find(r => String(r.name).trim().toLowerCase() === acct.toLowerCase()) || rows[0];
    if (!row) { dbg('row:not-found', { account: acct, got: rows.map(r => r.name) }); throw new Error(`VoIPBell account "${acct}" not found`); }

    const idm = String(row.action).match(/print=(\d+)/);
    if (!idm) { dbg('id:not-found', { name: row.name, action: snippet(row.action) }); throw new Error('Could not find intercom id for ' + acct); }
    const intercomId = idm[1];
    dbg('matched', { name: row.name, intercomId });

    const printPage = await vbGet(`${VB_URL}/index.php?p=intercom&print=${intercomId}`, { Referer: `${VB_URL}/index.php?p=intercom` });
    const pm = String(printPage.data).match(/(eyJ[A-Za-z0-9+/=]{20,})/);
    if (!pm) throw new Error('Could not extract QR payload from print page');
    const payload = pm[1];

    qrCache[acct] = { payload, intercomId, ts: Date.now() };
    return { account: acct, intercomId, payload };
  });
  chain = run.catch(() => {});   // keep the chain alive even on error
  return run;
}

// READ-ONLY diagnostic. Fetches the entry page and reports what's actually in
// it (login markers, passphrase format). Does NOT change the login path.
async function probeLogin() {
  const res = await vbGet(`${VB_URL}/index.php`);
  const html = String(res.data || '');
  const around = (re, pad = 180) => {
    const i = html.search(re);
    return i < 0 ? null : html.slice(Math.max(0, i - 40), i + pad).replace(/\s+/g, ' ');
  };
  const passM = html.match(/CryptoJS\.AES\.encrypt\([^,]+,\s*["']([0-9a-fA-F]{16,})["']/);
  return {
    len: html.length,
    status: res.status,
    markers: {
      aesEncrypt: /AES\.encrypt/i.test(html),
      password_protect: /password_protect/i.test(html),
      do_login: /do_login/i.test(html),
      namePassword: /name=["']?password/i.test(html),
      credentials: /introduce your credentials/i.test(html),
      conectedAs: /conected as/i.test(html),
      formLogin: /a=login/i.test(html),
    },
    passphraseRegexMatches: !!passM,
    passphrase: passM ? passM[1] : null,
    aesRegion: around(/AES\.encrypt/i),
    passwordRegion: around(/name=["']?password/i),
    formRegion: around(/<form/i, 240),
    head: html.slice(0, 600).replace(/\s+/g, ' '),
    tail: html.slice(-1200).replace(/\s+/g, ' '),
  };
}

module.exports = { getQrForAccount, getDebug, probeLogin };
