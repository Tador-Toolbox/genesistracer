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

// A real logged-in portal page carries the top-right "conected as: <user>"
// banner (the portal's own spelling). That's the only reliable auth signal —
// HTML length / "introduce your credentials" are not present in the raw markup.
function isLoggedIn(html) {
  return typeof html === 'string' && /conected as/i.test(html);
}
// The login page is the one that carries the password-encrypt form.
function isLoginPage(html) {
  const s = typeof html === 'string' ? html : '';
  return /CryptoJS\.AES\.encrypt\(|password_protect|do_login|introduce your credentials/i.test(s);
}
// Scrape the rotating passphrase (2nd arg of CryptoJS.AES.encrypt). Accept any
// quoted token, not just hex — the format can vary per page load.
function scrapePassphrase(html) {
  const s = String(html);
  let m = s.match(/CryptoJS\.AES\.encrypt\s*\([^,]+,\s*["']([^"']{6,})["']/);
  if (m) return m[1];
  m = s.match(/AES\.encrypt\s*\([^,]+,\s*["']([^"']{6,})["']/);
  return m ? m[1] : null;
}

async function vbLogin() {
  const user = process.env.VOIPBELL_USER;
  const pass = process.env.VOIPBELL_PASS;
  if (!user || !pass) throw new Error('VoIPBell not configured (set VOIPBELL_USER / VOIPBELL_PASS)');

  // 1) GET the entry page. If it's already a logged-in page, we're done.
  const page = await vbGet(`${VB_URL}/index.php`);
  if (isLoggedIn(page.data)) { dbg('vbLogin:already-authed'); session.ts = Date.now(); return; }

  // 2) scrape the rotating passphrase from the login form
  const passphrase = scrapePassphrase(page.data);
  if (!passphrase) {
    // Capture the region around "encrypt" so we can see the real format.
    const idx = String(page.data).search(/AES\.encrypt/i);
    dbg('vbLogin:no-passphrase', { encReg: idx >= 0 ? snippet(String(page.data).slice(idx - 40, idx + 160)) : '(no AES.encrypt in page)', len: String(page.data).length });
    throw new Error('Could not scrape VoIPBell login passphrase');
  }
  // 3) encrypt exactly like the browser's password_protect()
  const encPass = CryptoJS.AES.encrypt(pass, passphrase).toString();

  // 4) small delay (the fresh passphrase must commit server-side) then POST
  await sleep(900);
  await vbPostForm(`${VB_URL}/index.php?a=login`,
    { username: user, password: encPass, do_login: '' },
    { Referer: `${VB_URL}/index.php` });

  // 4) verify — a logged-in page must carry the "conected as" banner
  const check = await vbGet(`${VB_URL}/index.php?p=intercom`);
  if (!isLoggedIn(check.data)) { dbg('vbLogin:verify-failed', { len: String(check.data).length }); throw new Error('VoIPBell login failed (check creds / another session is active)'); }
  dbg('vbLogin:ok');
  session.ts = Date.now();
}

async function ensureLogin() {
  if (session.ts && Date.now() - session.ts < 6 * 60 * 1000) return;  // trust a very recent login
  // Otherwise check the REAL auth state — only log in if actually logged out.
  // (Blindly re-logging in while the portal session is still valid returns the
  //  dashboard instead of the login form, so the passphrase scrape fails.)
  try {
    const r = await vbGet(`${VB_URL}/index.php?p=intercom`);
    if (isLoggedIn(r.data)) { dbg('ensureLogin:still-authed'); session.ts = Date.now(); return; }
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

module.exports = { getQrForAccount, getDebug };
