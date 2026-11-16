// ==================== GENESIS GYM PORTAL ====================
// Separate management portal for gym managers (public/gym.html).
// Self-contained: own collections (gyms, gym_sessions, gym_plans, gym_members,
// gym_entries, gym_actions), own login, own routes under /api/gym/* plus a few
// admin routes under /api/manager/gyms/*. Does not touch any existing route.
//
// Panel writes are deliberately limited to ONE member at a time (push-face).
// Freeze / renew / expiry write-back to the panel is NOT automated yet: it waits
// for the test-panel check (TODO list). Until then those actions update the
// portal and mark the member panelSync = 'needs_update'.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');

const SESSION_HOURS = 12;
const EXPIRING_DAYS = 7;
const TZ = 'Asia/Jerusalem';

module.exports = function registerGym(app, deps) {
  const {
    db, resolvePanelAddress, panelHttpPost, panelHttpGetWithHeaders,
    getAllPanelFaces, deleteFaceFromPanel, exec, axios, upload, cloudinary, loginLimiter, logActivity,
  } = deps;

  // ---------- in-memory debug log (read-only route: /api/gym/debug) ----------
  const DEBUG_MAX = 300;
  const debugLog = [];
  function dbg(gymId, event, data) {
    debugLog.push({ at: new Date().toISOString(), gymId: gymId ? String(gymId) : null, event, data });
    if (debugLog.length > DEBUG_MAX) debugLog.shift();
    console.log(`🏋️ [gym] ${event}`, data ? JSON.stringify(data).slice(0, 300) : '');
  }

  // ---------- helpers ----------
  const database = () => db.connectDB();
  const oid = (id) => { try { return new ObjectId(String(id)); } catch (e) { return null; } };
  const cleanMac = (m) => String(m || '').replace(/[:\-\s]/g, '').toUpperCase();
  const cleanPhone = (p) => String(p || '').replace(/[^\d]/g, '');
  const isAdmin = (b) => b && b.username === (process.env.ADMIN_USER || 'admin') && b.password === process.env.ADMIN_PASS;
  const genPassword = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
    return s;
  };

  // Wall-clock time in Jerusalem → epoch ms. dateStr 'YYYY-MM-DD'.
  function jerusalemMs(dateStr, hh = 0, mm = 0, ss = 0) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = p.value, a), {});
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return guess - (asIfUtc - guess);
  }
  function todayStr(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
  }
  // Membership of N months from a start date: last valid day = start + N months - 1 day.
  // Example: start 2026-11-16, 1 month → valid until 2026-12-15. Jan 31 + 1 month clamps to Feb 28.
  function monthsEnd(startStr, months) {
    const [y, m, d] = startStr.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
    // Start day missing in the target month (e.g. Jan 31 → Feb): valid to that month's last day.
    if (d > lastDay) return new Date(Date.UTC(y, m - 1 + months, lastDay)).toISOString().slice(0, 10);
    const t = new Date(Date.UTC(y, m - 1 + months, d));
    return addDays(t.toISOString().slice(0, 10), -1);
  }
  const parseMonths = (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 12 ? n : null; };
  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  }

  // Effective status of a member, computed (never stored as truth).
  function memberStatus(m) {
    const today = todayStr();
    if (m.frozen) return 'frozen';
    if (m.entriesLeft !== undefined && m.entriesLeft !== null && m.entriesLeft <= 0) return 'expired';
    if (!m.endDate || m.endDate < today) return 'expired';
    if (m.endDate <= todayStr(EXPIRING_DAYS)) return 'expiring';
    return 'active';
  }
  function publicMember(m, plansById) {
    const plan = plansById ? plansById[String(m.planId)] : null;
    return {
      id: String(m._id), firstName: m.firstName, lastName: m.lastName, phone: m.phone,
      planId: m.planId ? String(m.planId) : null, planName: plan ? plan.name : '',
      startDate: m.startDate, endDate: m.endDate, entriesLeft: m.entriesLeft ?? null,
      frozen: !!m.frozen, frozenUntil: m.frozenUntil || null,
      status: memberStatus(m), notes: m.notes || '', faceSaved: !!m.snapshot,
      consent: !!m.consent, card: m.card || '', pin: m.pin || '',
      faceOnPanel: !!(m.face && m.face.panels && Object.keys(m.face.panels).length),
      panelSync: m.panelSync || 'none', lastEntry: m.lastEntry || null,
      createdAt: m.createdAt,
    };
  }
  async function plansMap(d, gymId) {
    const plans = await d.collection('gym_plans').find({ gymId }).toArray();
    return Object.fromEntries(plans.map(p => [String(p._id), p]));
  }
  async function logAction(gymId, memberId, action, by, details = {}) {
    try {
      const d = await database();
      await d.collection('gym_actions').insertOne({ gymId, memberId: memberId || null, action, by: by || null, details, at: new Date() });
    } catch (e) { dbg(gymId, 'action_log_error', { error: e.message }); }
  }

  // ---------- indexes ----------
  (async () => {
    try {
      const d = await database();
      await d.collection('gyms').createIndex({ loginPhone: 1 }, { unique: true });
      await d.collection('gym_sessions').createIndex({ token: 1 }, { unique: true });
      await d.collection('gym_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await d.collection('gym_members').createIndex({ gymId: 1, lastName: 1 });
      await d.collection('gym_entries').createIndex({ gymId: 1, time: -1 });
      await d.collection('gym_entries').createIndex({ gymId: 1, key: 1 }, { unique: true });
    } catch (e) { console.log('🏋️ [gym] index init:', e.message); }
  })();

  // ---------- auth middleware ----------
  async function gymAuth(req, res, next) {
    try {
      const token = req.headers['x-gym-token'];
      if (!token) return res.status(401).json({ success: false, error: 'not_logged_in' });
      const d = await database();
      const s = await d.collection('gym_sessions').findOne({ token, expiresAt: { $gt: new Date() } });
      if (!s) return res.status(401).json({ success: false, error: 'session_expired' });
      const gym = await d.collection('gyms').findOne({ _id: s.gymId });
      if (!gym || gym.disabled) return res.status(401).json({ success: false, error: 'gym_disabled' });
      req.gym = gym;
      req.gymUser = s.user || gym.loginPhone;
      next();
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  }
  async function memberOf(req, res) {
    const id = oid(req.params.id);
    if (!id) { res.status(400).json({ success: false, error: 'bad_id' }); return null; }
    const d = await database();
    const m = await d.collection('gym_members').findOne({ _id: id, gymId: req.gym._id });
    if (!m) { res.status(404).json({ success: false, error: 'member_not_found' }); return null; }
    return m;
  }

  // ==================== GYM LOGIN ====================
  app.post('/api/gym/login', loginLimiter, async (req, res) => {
    try {
      const phone = cleanPhone(req.body.phone);
      const password = String(req.body.password || '');
      const d = await database();
      const gym = await d.collection('gyms').findOne({ loginPhone: phone });
      const ok = gym && !gym.disabled && bcrypt.compareSync(password, gym.password || '');
      logActivity({ phoneNumber: phone || 'unknown', action: ok ? 'gym_login' : 'login_failed', mac: null, details: { portal: 'gym' }, success: !!ok });
      if (!ok) return res.status(401).json({ success: false, error: 'מספר טלפון או סיסמה שגויים' });
      const token = crypto.randomBytes(24).toString('hex');
      await d.collection('gym_sessions').insertOne({
        token, gymId: gym._id, user: phone, createdAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_HOURS * 3600000),
      });
      await d.collection('gyms').updateOne({ _id: gym._id }, { $set: { lastLogin: new Date() } });
      res.json({ success: true, token, gym: { id: String(gym._id), name: gym.name, panels: gym.panels || [] } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/gym/logout', gymAuth, async (req, res) => {
    const d = await database();
    await d.collection('gym_sessions').deleteOne({ token: req.headers['x-gym-token'] });
    res.json({ success: true });
  });

  app.get('/api/gym/me', gymAuth, (req, res) => {
    res.json({ success: true, gym: { id: String(req.gym._id), name: req.gym.name, panels: req.gym.panels || [] } });
  });

  // ==================== DASHBOARD ====================
  app.get('/api/gym/dashboard', gymAuth, async (req, res) => {
    try {
      const d = await database();
      const gymId = req.gym._id;
      const pm = await plansMap(d, gymId);
      const members = await d.collection('gym_members').find({ gymId }).toArray();
      const counts = { active: 0, expiring: 0, frozen: 0, expired: 0, total: members.length };
      members.forEach(m => { counts[memberStatus(m)]++; });
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const joinedWeek = members.filter(m => m.createdAt && m.createdAt > weekAgo).length;
      const expiring = members.filter(m => memberStatus(m) === 'expiring')
        .sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''))
        .slice(0, 8).map(m => publicMember(m, pm));
      const dayStart = new Date(jerusalemMs(todayStr(), 0, 0, 0));
      const todayEntries = await d.collection('gym_entries').find({ gymId, time: { $gte: dayStart } }).toArray();
      const byHour = {};
      todayEntries.forEach(e => {
        const h = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(e.time);
        byHour[h] = (byHour[h] || 0) + 1;
      });
      const peak = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
      const recent = await d.collection('gym_entries').find({ gymId }).sort({ time: -1 }).limit(8).toArray();
      const lastSync = req.gym.lastEntrySync || null;
      res.json({
        success: true,
        counts: { ...counts, activeAll: counts.active + counts.expiring, joinedWeek },
        entriesToday: todayEntries.filter(e => e.result !== 'denied').length,
        deniedToday: todayEntries.filter(e => e.result === 'denied').length,
        peakHour: peak ? `${peak[0]}:00` : null,
        expiring, recent: recent.map(publicEntry), lastSync,
        panels: req.gym.panels || [],
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ==================== PLANS ====================
  function sanitizePlan(b) {
    const days = Array.isArray(b.days) ? b.days.map(Number).filter(n => n >= 0 && n <= 6) : [0, 1, 2, 3, 4, 5, 6];
    const hm = (s, def) => (/^\d{2}:\d{2}$/.test(String(s || '')) ? s : def);
    const durationType = b.durationType === 'entries' ? 'entries' : 'days';
    const durationValue = Math.max(1, Math.min(3650, parseInt(b.durationValue, 10) || 30));
    return {
      name: String(b.name || '').trim().slice(0, 60),
      days: [...new Set(days)].sort(),
      start: hm(b.start, '06:00'), end: hm(b.end, '23:00'),
      durationType, durationValue,
      doors: Array.isArray(b.doors) ? b.doors.map(cleanMac).filter(Boolean) : [],
      price: String(b.price || '').slice(0, 30),
    };
  }
  app.get('/api/gym/plans', gymAuth, async (req, res) => {
    const d = await database();
    const plans = await d.collection('gym_plans').find({ gymId: req.gym._id }).sort({ createdAt: 1 }).toArray();
    const counts = await d.collection('gym_members').aggregate([{ $match: { gymId: req.gym._id } }, { $group: { _id: '$planId', n: { $sum: 1 } } }]).toArray();
    const cm = Object.fromEntries(counts.map(c => [String(c._id), c.n]));
    res.json({ success: true, plans: plans.map(p => ({ ...p, id: String(p._id), _id: undefined, gymId: undefined, members: cm[String(p._id)] || 0 })) });
  });
  app.post('/api/gym/plans', gymAuth, async (req, res) => {
    const p = sanitizePlan(req.body);
    if (!p.name) return res.status(400).json({ success: false, error: 'חסר שם מסלול' });
    if (!p.days.length) return res.status(400).json({ success: false, error: 'יש לבחור לפחות יום אחד' });
    if (p.start >= p.end) return res.status(400).json({ success: false, error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
    const d = await database();
    const r = await d.collection('gym_plans').insertOne({ ...p, gymId: req.gym._id, createdAt: new Date() });
    logAction(req.gym._id, null, 'plan_create', req.gymUser, { name: p.name });
    res.json({ success: true, id: String(r.insertedId) });
  });
  app.put('/api/gym/plans/:id', gymAuth, async (req, res) => {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
    const p = sanitizePlan(req.body);
    if (!p.name) return res.status(400).json({ success: false, error: 'חסר שם מסלול' });
    if (p.start >= p.end) return res.status(400).json({ success: false, error: 'שעת הסיום חייבת להיות אחרי שעת ההתחלה' });
    const d = await database();
    const r = await d.collection('gym_plans').updateOne({ _id: id, gymId: req.gym._id }, { $set: { ...p, updatedAt: new Date() } });
    if (!r.matchedCount) return res.status(404).json({ success: false, error: 'plan_not_found' });
    // Hours/days changed → every member on this plan needs a panel update.
    await d.collection('gym_members').updateMany({ gymId: req.gym._id, planId: id, 'face.panels': { $exists: true } }, { $set: { panelSync: 'needs_update' } });
    logAction(req.gym._id, null, 'plan_update', req.gymUser, { name: p.name });
    res.json({ success: true });
  });
  app.delete('/api/gym/plans/:id', gymAuth, async (req, res) => {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
    const d = await database();
    const used = await d.collection('gym_members').countDocuments({ gymId: req.gym._id, planId: id });
    if (used) return res.status(409).json({ success: false, error: `יש ${used} מנויים במסלול הזה. העבר אותם למסלול אחר לפני מחיקה.` });
    await d.collection('gym_plans').deleteOne({ _id: id, gymId: req.gym._id });
    logAction(req.gym._id, null, 'plan_delete', req.gymUser, {});
    res.json({ success: true });
  });

  // ==================== MEMBERS ====================
  async function planFor(d, gymId, planId) {
    const id = oid(planId); if (!id) return null;
    return d.collection('gym_plans').findOne({ _id: id, gymId });
  }
  function sanitizeMember(b) {
    const date = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);
    return {
      firstName: String(b.firstName || '').trim().slice(0, 40),
      lastName: String(b.lastName || '').trim().slice(0, 40),
      phone: cleanPhone(b.phone).slice(0, 15),
      startDate: date(b.startDate), endDate: date(b.endDate),
      notes: String(b.notes || '').slice(0, 500),
      card: String(b.card || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 16),
      pin: String(b.pin || '').replace(/\D/g, '').slice(0, 8),
      consent: !!b.consent,
    };
  }

  app.get('/api/gym/members', gymAuth, async (req, res) => {
    try {
      const d = await database();
      const pm = await plansMap(d, req.gym._id);
      let list = (await d.collection('gym_members').find({ gymId: req.gym._id }).sort({ firstName: 1, lastName: 1 }).toArray()).map(m => publicMember(m, pm));
      const counts = { all: list.length, active: 0, expiring: 0, frozen: 0, expired: 0 };
      list.forEach(m => { counts[m.status]++; });
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q) list = list.filter(m => `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) || (m.phone || '').includes(q.replace(/\D/g, '') || '§'));
      const st = String(req.query.status || 'all');
      if (st !== 'all') list = list.filter(m => (st === 'active' ? (m.status === 'active' || m.status === 'expiring') : m.status === st));
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const size = 25;
      res.json({ success: true, counts, total: list.length, page, pageSize: size, members: list.slice((page - 1) * size, page * size) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/gym/members', gymAuth, async (req, res) => {
    try {
      const d = await database();
      const m = sanitizeMember(req.body);
      if (!m.firstName) return res.status(400).json({ success: false, error: 'חסר שם פרטי' });
      if (m.phone.length < 9) return res.status(400).json({ success: false, error: 'מספר טלפון לא תקין' });
      const plan = await planFor(d, req.gym._id, req.body.planId);
      if (!plan) return res.status(400).json({ success: false, error: 'יש לבחור מסלול' });
      const dup = await d.collection('gym_members').findOne({ gymId: req.gym._id, phone: m.phone });
      if (dup) return res.status(409).json({ success: false, error: 'כבר קיים מנוי עם מספר הטלפון הזה' });
      m.startDate = m.startDate || todayStr();
      const months = parseMonths(req.body.months);
      if (plan.durationType === 'entries') {
        m.entriesLeft = plan.durationValue;
        m.endDate = m.endDate || (months ? monthsEnd(m.startDate, months) : addDays(m.startDate, 365));
      } else {
        m.endDate = m.endDate || (months ? monthsEnd(m.startDate, months) : addDays(m.startDate, plan.durationValue - 1));
      }
      if (months) m.months = months;
      const doc = { ...m, planId: plan._id, gymId: req.gym._id, frozen: false, panelSync: 'none', createdAt: new Date(), createdBy: req.gymUser };
      const r = await d.collection('gym_members').insertOne(doc);
      logAction(req.gym._id, r.insertedId, 'member_create', req.gymUser, { name: `${m.firstName} ${m.lastName}` });
      res.json({ success: true, id: String(r.insertedId) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/gym/members/:id', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const d = await database();
      const pm = await plansMap(d, req.gym._id);
      const plan = pm[String(m.planId)] || null;
      const entries = await d.collection('gym_entries').find({ gymId: req.gym._id, memberId: m._id }).sort({ time: -1 }).limit(30).toArray();
      const since30 = new Date(Date.now() - 30 * 86400000);
      const count30 = await d.collection('gym_entries').countDocuments({ gymId: req.gym._id, memberId: m._id, time: { $gte: since30 }, result: { $ne: 'denied' } });
      const actions = await d.collection('gym_actions').find({ gymId: req.gym._id, memberId: m._id }).sort({ at: -1 }).limit(20).toArray();
      res.json({
        success: true, member: publicMember(m, pm),
        plan: plan ? { id: String(plan._id), name: plan.name, days: plan.days, start: plan.start, end: plan.end, durationType: plan.durationType, durationValue: plan.durationValue } : null,
        entries: entries.map(publicEntry), entries30: count30,
        actions: actions.map(a => ({ action: a.action, by: a.by, at: a.at, details: a.details })),
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ==================== PANEL SYNC ====================
  // Face photos live ON THE PANEL only. The server keeps a private copy only while a
  // member is frozen (same idea as the installer "חסום משתמש" flow):
  //   freeze   = save a private copy (from the panel) + delete the face from every panel
  //   unfreeze = upload the copy back with fresh dates + delete the copy
  //   renew / edit = re-upload the face with the new dates, then delete the old record
  const fs = require('fs'); const os = require('os'); const path = require('path');
  function curlJson(cmd) {
    return new Promise((resolve) => {
      exec(cmd, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ _error: err.message });
        try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ _raw: String(stdout || '').slice(0, 300) }); }
      });
    });
  }
  async function panelConn(mac) {
    const addr = await resolvePanelAddress(mac);
    if (!addr) throw new Error('הפנל לא מחובר');
    const [host, portStr] = addr.split(':'); const port = parseInt(portStr, 10) || 80;
    const login = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
    const token = login?.data?.token;
    if (!token) throw new Error('התחברות לפנל נכשלה');
    return { host, port, token };
  }
  async function downloadFace(conn, id) {
    const tmp = path.join(os.tmpdir(), `gymdl_${Date.now()}_${crypto.randomInt(1e6)}.jpg`);
    try {
      // Same request the panel web page makes (HAR 16.11): GET /api/v1/access/image/{id}.jpg?id={id} with a Referer.
      const base = `http://${conn.host}:${conn.port}`;
      await new Promise((resolve) => exec(`curl -s --max-time 20 -H "Authorization: Bearer ${conn.token}" -H "Referer: ${base}/" "${base}/api/v1/access/image/${id}.jpg?id=${id}" -o "${tmp}"`, { maxBuffer: 8 * 1024 * 1024 }, () => resolve()));
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 500) return null;
      return fs.readFileSync(tmp);
    } finally { fs.unlink(tmp, () => {}); }
  }
  async function uploadFace(conn, label, buf, access) {
    const stamp = `${Date.now()}_${crypto.randomInt(1e6)}`;
    const tmpImg = path.join(os.tmpdir(), `gymface_${stamp}.jpg`);
    const tmpJson = path.join(os.tmpdir(), `gymaccess_${stamp}.json`);
    try {
      const before = new Set((await getAllPanelFaces(conn.host, conn.port, conn.token)).map(f => String(f.id)));
      fs.writeFileSync(tmpImg, buf);
      const up = await curlJson(`curl -s --max-time 20 -X POST -H "Authorization: Bearer ${conn.token}" -F "file=@${tmpImg};type=image/jpeg" "http://${conn.host}:${conn.port}/api/v1/access/image/jpg"`);
      const serverFile = up?.data?.name || up?.data?.filename || up?.name || up?.data?.face_picture_name || (typeof up?.data === 'string' ? up.data : null);
      if (!serverFile) return { ok: false, step: 'image', response: up };
      const body = {
        label, effective_date: access.effective, expired_date: access.expired,
        valid_weekdays: access.weekdays, valid_count: access.count,
        facePictureName: serverFile, content: serverFile,
        valid_periods: JSON.stringify([{ begin: access.begin, end: access.end }]),
        valid_door: '1',
      };
      fs.writeFileSync(tmpJson, JSON.stringify(body));
      const rec = await curlJson(`curl -s --max-time 15 -X POST -H "Authorization: Bearer ${conn.token}" -H "Content-Type: application/json;charset=UTF-8" --data @${tmpJson} "http://${conn.host}:${conn.port}/api/v1/access"`);
      const failed = rec?._error || rec?.error || (rec?.status && !['OK', 0, '0'].includes(rec.status));
      if (failed) return { ok: false, step: 'record', response: rec, sent: body };
      const after = await getAllPanelFaces(conn.host, conn.port, conn.token);
      const created = after.filter(f => !before.has(String(f.id)) && (f.label || '').trim() === label);
      return { ok: true, id: created.length ? created[created.length - 1].id : null, sent: body };
    } finally { fs.unlink(tmpImg, () => {}); fs.unlink(tmpJson, () => {}); }
  }
  function accessFor(m, plan) {
    return {
      effective: jerusalemMs(m.startDate || todayStr(), 0, 0, 0),
      expired: jerusalemMs(m.endDate, 23, 59, 59),
      weekdays: plan.days,
      begin: `${plan.start}:00`, end: `${plan.end}:59`,
      count: plan.durationType === 'entries' ? Math.max(0, m.entriesLeft || 0) : -1,
    };
  }
  function doorsFor(gym, plan) {
    const gymMacs = (gym.panels || []).map(p => p.mac);
    return (plan && plan.doors && plan.doors.length ? plan.doors : gymMacs).filter(mac => gymMacs.includes(mac));
  }
  // Private copy (Cloudinary "authenticated" = no public URL), only while frozen.
  async function snapshotSave(gymId, buf) {
    const r = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: `tador/gym-frozen/${String(gymId)}`, resource_type: 'image', type: 'authenticated' },
        (err, out) => (err ? reject(err) : resolve(out))).end(buf);
    });
    return { publicId: r.public_id, format: r.format || 'jpg' };
  }
  async function snapshotLoad(snap) {
    const url = cloudinary.utils.private_download_url(snap.publicId, snap.format || 'jpg', { resource_type: 'image', type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + 300 });
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    return Buffer.from(r.data);
  }
  async function snapshotDrop(snap) {
    if (!snap) return;
    try { await cloudinary.uploader.destroy(snap.publicId, { resource_type: 'image', type: 'authenticated', invalidate: true }); } catch (e) {}
  }
  // Best available face image: frozen copy → older public test photo → any panel record.
  async function sourceImage(m) {
    if (m.snapshot) { try { return await snapshotLoad(m.snapshot); } catch (e) { dbg(m.gymId, 'snapshot_load_error', { error: e.message }); } }
    if (m.photoUrl) { try { return Buffer.from((await axios.get(m.photoUrl, { responseType: 'arraybuffer', timeout: 20000 })).data); } catch (e) {} }
    for (const [mac, info] of Object.entries((m.face && m.face.panels) || {})) {
      if (!info || info.id === null || info.id === undefined) continue;
      try { const buf = await downloadFace(await panelConn(mac), info.id); if (buf) return buf; } catch (e) {}
    }
    return null;
  }

  // Bring the panel in line with the member: frozen → off the panel; otherwise → on the
  // plan's doors with the member's current dates/hours. Returns { ok, results, message }.
  async function syncMember(gym, m, opts = {}) {
    const d = await database();
    const label = `${m.firstName} ${m.lastName}`.trim();
    const facePanels = { ...((m.face && m.face.panels) || {}) };
    const results = [];
    const set = {}; const unset = {};

    if (m.frozen) {
      if (!Object.keys(facePanels).length) return { ok: true, results, message: 'אין פנים בפנל' };
      let snap = m.snapshot || null;
      if (!snap) {
        const buf = await sourceImage(m);
        if (!buf) return { ok: false, results, message: 'לא הצלחנו להוריד את תמונת הפנים מהפנל, לכן היא לא נמחקה. נסו שוב כשהפנל מחובר.' };
        snap = await snapshotSave(gym._id, buf);
        set.snapshot = snap;
      }
      for (const [mac, info] of Object.entries(facePanels)) {
        const r = { mac };
        try {
          const conn = await panelConn(mac);
          if (info && info.id !== null && info.id !== undefined) await deleteFaceFromPanel(conn.host, conn.port, conn.token, info.id);
          delete facePanels[mac]; r.ok = true;
        } catch (e) { r.error = e.message; }
        results.push(r);
      }
      set['face.panels'] = facePanels;
      set.panelSync = Object.keys(facePanels).length ? 'pending' : 'frozen_saved';
    } else {
      if (!opts.newPhoto && !Object.keys(facePanels).length && !m.snapshot && !m.photoUrl) return { ok: true, results, message: 'אין תמונת פנים' };
      if (memberStatus(m) === 'expired' && !opts.newPhoto) return { ok: true, results, message: 'המנוי לא בתוקף, הפנל חוסם לפי תאריך' };
      const plan = await planFor(d, gym._id, m.planId);
      if (!plan) return { ok: false, results, message: 'למנוי אין מסלול' };
      const doors = doorsFor(gym, plan);
      if (!doors.length) return { ok: false, results, message: 'לא הוגדרו דלתות לחדר הכושר' };
      const buf = opts.newPhoto || await sourceImage(m);
      if (!buf) return { ok: false, results, message: 'לא נמצאה תמונת פנים לשליחה' };
      const access = accessFor(m, plan);
      for (const mac of doors) {
        const r = { mac };
        try {
          const conn = await panelConn(mac);
          const old = facePanels[mac];
          if (!old) {
            const existing = await getAllPanelFaces(conn.host, conn.port, conn.token);
            if (existing.some(f => (f.label || '').trim() === label)) throw new Error(`כבר קיימת בפנל פנים בשם "${label}" שלא נוצרה מהפורטל`);
          }
          const out = await uploadFace(conn, label, buf, access);
          dbg(gym._id, 'upload_face', { member: String(m._id), mac, ok: out.ok, step: out.step, id: out.id, response: out.response });
          if (!out.ok) throw new Error('הפנל דחה את התמונה');
          if (old && old.id !== null && old.id !== undefined && String(old.id) !== String(out.id)) {
            try { await deleteFaceFromPanel(conn.host, conn.port, conn.token, old.id); } catch (e) { dbg(gym._id, 'old_record_delete_error', { mac, id: old.id, error: e.message }); }
          }
          facePanels[mac] = { id: out.id, uploadedAt: new Date(), expired: access.expired };
          r.ok = true;
        } catch (e) { r.error = e.message; }
        results.push(r);
      }
      // Doors the plan no longer opens: remove the face there.
      for (const [mac, info] of Object.entries(facePanels)) {
        if (doors.includes(mac)) continue;
        const r = { mac, removed: true };
        try { const conn = await panelConn(mac); if (info && info.id != null) await deleteFaceFromPanel(conn.host, conn.port, conn.token, info.id); delete facePanels[mac]; r.ok = true; }
        catch (e) { r.error = e.message; }
        results.push(r);
      }
      const allOk = results.every(r => r.ok);
      set['face.panels'] = facePanels;
      set.panelSync = allOk ? 'synced' : 'pending';
      if (allOk) {
        if (m.snapshot) { await snapshotDrop(m.snapshot); unset.snapshot = ''; }
        if (m.photoPublicId) { try { await cloudinary.uploader.destroy(m.photoPublicId); } catch (e) {} unset.photoUrl = ''; unset.photoPublicId = ''; }
      }
    }
    const upd = { $set: set }; if (Object.keys(unset).length) upd.$unset = unset;
    await d.collection('gym_members').updateOne({ _id: m._id }, upd);
    const ok = results.every(r => r.ok);
    return { ok, results, message: ok ? '' : 'חלק מהפנלים לא עודכנו. אפשר לנסות שוב מכרטיס המנוי.' };
  }
  async function reloadMember(id) { const d = await database(); return d.collection('gym_members').findOne({ _id: id }); }

  // ==================== MEMBER ACTIONS ====================
  app.put('/api/gym/members/:id', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const d = await database();
      const u = sanitizeMember({ ...m, ...req.body });
      if (!u.firstName) return res.status(400).json({ success: false, error: 'חסר שם פרטי' });
      const set = { ...u, updatedAt: new Date() };
      if (req.body.planId && String(req.body.planId) !== String(m.planId)) {
        const plan = await planFor(d, req.gym._id, req.body.planId);
        if (!plan) return res.status(400).json({ success: false, error: 'מסלול לא קיים' });
        set.planId = plan._id;
      }
      const panelFieldsChanged = set.planId || u.endDate !== m.endDate || u.startDate !== m.startDate || u.firstName !== m.firstName || u.lastName !== m.lastName;
      await d.collection('gym_members').updateOne({ _id: m._id }, { $set: set });
      logAction(req.gym._id, m._id, 'member_update', req.gymUser, {});
      let panel = null;
      if (panelFieldsChanged && m.face && m.face.panels && Object.keys(m.face.panels).length && !m.frozen) {
        // Name changes need the old label gone: the sync re-uploads under the new name and deletes the old record.
        panel = await syncMember(req.gym, await reloadMember(m._id));
      }
      res.json({ success: true, panel });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Renew: extends from the day after the current end (or today if already expired).
  app.post('/api/gym/members/:id/renew', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const d = await database();
      const plan = await planFor(d, req.gym._id, req.body.planId || m.planId);
      if (!plan) return res.status(400).json({ success: false, error: 'מסלול לא קיים' });
      const set = { planId: plan._id, updatedAt: new Date() };
      const months = parseMonths(req.body.months);
      const base = m.endDate && m.endDate >= todayStr() ? addDays(m.endDate, 1) : todayStr();
      if (!(m.endDate && m.endDate >= todayStr())) set.startDate = todayStr();
      if (plan.durationType === 'entries') {
        set.entriesLeft = (m.entriesLeft > 0 ? m.entriesLeft : 0) + plan.durationValue;
        set.endDate = months ? monthsEnd(base, months) : addDays(todayStr(), 365);
      } else {
        set.endDate = months ? monthsEnd(base, months) : addDays(base, plan.durationValue - 1);
      }
      if (months) set.months = months;
      await d.collection('gym_members').updateOne({ _id: m._id }, { $set: set });
      logAction(req.gym._id, m._id, 'member_renew', req.gymUser, { endDate: set.endDate, entriesLeft: set.entriesLeft });
      const panel = await syncMember(req.gym, await reloadMember(m._id));
      res.json({ success: true, endDate: set.endDate, entriesLeft: set.entriesLeft ?? null, panel });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/gym/members/:id/freeze', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      if (m.frozen) return res.status(400).json({ success: false, error: 'המנוי כבר מוקפא' });
      const until = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.until || '')) ? req.body.until : null;
      const d = await database();
      await d.collection('gym_members').updateOne({ _id: m._id }, { $set: { frozen: true, frozenUntil: until, frozenAt: new Date() } });
      const panel = await syncMember(req.gym, await reloadMember(m._id));
      if (!panel.ok && !(panel.results || []).some(r => r.ok)) {
        // Could not save a copy / reach any panel: the face is still on the panel.
        await d.collection('gym_members').updateOne({ _id: m._id }, { $set: { panelSync: 'pending' } });
      }
      logAction(req.gym._id, m._id, 'member_freeze', req.gymUser, { until, panel: panel.results });
      res.json({ success: true, panel });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Unfreeze: frozen days are added back to the end date, then the face goes back on the panel.
  app.post('/api/gym/members/:id/unfreeze', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const d = await database();
      const set = { frozen: false, frozenUntil: null, updatedAt: new Date() };
      if (m.frozenAt && m.endDate) {
        const frozenDays = Math.max(0, Math.round((Date.now() - new Date(m.frozenAt).getTime()) / 86400000));
        if (frozenDays > 0) set.endDate = addDays(m.endDate, frozenDays);
        set.lastFreezeDays = frozenDays;
      }
      await d.collection('gym_members').updateOne({ _id: m._id }, { $set: set, $unset: { frozenAt: '' } });
      const panel = await syncMember(req.gym, await reloadMember(m._id));
      logAction(req.gym._id, m._id, 'member_unfreeze', req.gymUser, { endDate: set.endDate, frozenDays: set.lastFreezeDays, panel: panel.results });
      res.json({ success: true, endDate: set.endDate || m.endDate, panel });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Retry: bring the panel in line with the member (after a panel was offline).
  app.post('/api/gym/members/:id/panel-sync', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const panel = await syncMember(req.gym, m);
      logAction(req.gym._id, m._id, 'panel_sync', req.gymUser, { results: panel.results });
      res.json({ success: panel.ok, panel, error: panel.ok ? undefined : panel.message });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.delete('/api/gym/members/:id', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const d = await database();
      const results = [];
      for (const [mac, info] of Object.entries((m.face && m.face.panels) || {})) {
        const r = { mac };
        try {
          if (!info || info.id === null || info.id === undefined) throw new Error('מזהה הרשומה בפנל לא ידוע');
          const conn = await panelConn(mac);
          await deleteFaceFromPanel(conn.host, conn.port, conn.token, info.id);
          r.ok = true;
        } catch (e) { r.error = e.message; }
        results.push(r);
      }
      const failed = results.filter(r => !r.ok);
      if (failed.length && req.query.force !== '1') {
        return res.status(409).json({ success: false, error: 'לא ניתן היה להסיר את הפנים מכל הפנלים', results });
      }
      await snapshotDrop(m.snapshot);
      if (m.photoPublicId) { try { await cloudinary.uploader.destroy(m.photoPublicId); } catch (e) {} }
      await d.collection('gym_members').deleteOne({ _id: m._id });
      logAction(req.gym._id, m._id, 'member_delete', req.gymUser, { name: `${m.firstName} ${m.lastName}`, panels: results });
      res.json({ success: true, results });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Photo (multipart "photo"): goes straight to the panel(s). Not stored on our server.
  app.post('/api/gym/members/:id/photo', gymAuth, upload.single('photo'), async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      if (!req.file) return res.status(400).json({ success: false, error: 'לא נבחרה תמונה' });
      if (req.body.consent !== 'true' && !m.consent) return res.status(400).json({ success: false, error: 'נדרשת הסכמת המנוי לשמירת תמונת פנים' });
      if (m.frozen) return res.status(400).json({ success: false, error: 'המנוי מוקפא. הפשירו אותו קודם' });
      if (memberStatus(m) === 'expired') return res.status(400).json({ success: false, error: 'המנוי לא בתוקף. חדשו אותו קודם' });
      const d = await database();
      await d.collection('gym_members').updateOne({ _id: m._id }, { $set: { consent: true, consentAt: m.consentAt || new Date() } });
      const panel = await syncMember(req.gym, await reloadMember(m._id), { newPhoto: req.file.buffer });
      logAction(req.gym._id, m._id, 'member_photo', req.gymUser, { results: panel.results });
      const anyOk = (panel.results || []).some(r => r.ok);
      res.status(anyOk ? 200 : 502).json({ success: anyOk, panel, error: anyOk ? undefined : (panel.message && panel.results.length === 0 ? panel.message : (panel.results.map(r => r.error).filter(Boolean)[0] || panel.message)) });
    } catch (e) { dbg(req.gym._id, 'photo_error', { error: e.message }); res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- Faces already on the panel (enrolled by hand, not through the portal) ----------
  // List every face record on the gym's doors so the manager can link one to a member.
  app.get('/api/gym/panel-faces', gymAuth, async (req, res) => {
    try {
      const d = await database();
      const members = await d.collection('gym_members').find({ gymId: req.gym._id }).project({ firstName: 1, lastName: 1, face: 1 }).toArray();
      const linked = {};
      members.forEach(m => Object.entries((m.face && m.face.panels) || {}).forEach(([mac, info]) => { if (info && info.id != null) linked[`${mac}|${info.id}`] = `${m.firstName} ${m.lastName}`.trim(); }));
      const out = [];
      for (const p of (req.gym.panels || [])) {
        try {
          const conn = await panelConn(p.mac);
          const faces = (await getAllPanelFaces(conn.host, conn.port, conn.token)).filter(f => !f.type || f.type === 'face');
          faces.forEach(f => out.push({ mac: p.mac, door: p.label, id: f.id, label: f.label || '', linkedTo: linked[`${p.mac}|${f.id}`] || null }));
        } catch (e) { out.push({ mac: p.mac, door: p.label, error: e.message }); }
      }
      res.json({ success: true, faces: out });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/gym/panel-faces/:mac/:faceId/image', gymAuth, async (req, res) => {
    try {
      const mac = cleanMac(req.params.mac);
      if (!(req.gym.panels || []).some(p => p.mac === mac)) return res.status(404).end();
      const buf = await downloadFace(await panelConn(mac), parseInt(req.params.faceId, 10));
      if (!buf) return res.status(404).end();
      res.setHeader('Cache-Control', 'no-store');
      res.type('jpg').send(buf);
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Link an existing panel face record to a member (then freeze / renew / delete act on it).
  app.post('/api/gym/members/:id/link-face', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const mac = cleanMac(req.body.mac); const faceId = parseInt(req.body.faceId, 10);
      if (!(req.gym.panels || []).some(p => p.mac === mac) || !Number.isFinite(faceId)) return res.status(400).json({ success: false, error: 'פנים לא תקינות' });
      const d = await database();
      const taken = await d.collection('gym_members').findOne({ gymId: req.gym._id, _id: { $ne: m._id }, [`face.panels.${mac}.id`]: faceId });
      if (taken) return res.status(409).json({ success: false, error: `הפנים כבר משויכות ל${taken.firstName} ${taken.lastName}` });
      const conn = await panelConn(mac);
      const exists = (await getAllPanelFaces(conn.host, conn.port, conn.token)).some(f => Number(f.id) === faceId);
      if (!exists) return res.status(404).json({ success: false, error: 'הפנים לא נמצאו בפנל' });
      await d.collection('gym_members').updateOne({ _id: m._id }, { $set: { [`face.panels.${mac}`]: { id: faceId, linkedAt: new Date() }, panelSync: 'synced' } });
      logAction(req.gym._id, m._id, 'link_face', req.gymUser, { mac, faceId });
      // Already frozen? Take the face off the panel right away.
      let panel = null;
      if (m.frozen) panel = await syncMember(req.gym, await reloadMember(m._id));
      res.json({ success: true, panel });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Live face image: from the panel (or the frozen copy). Fetched by the page as a blob.
  app.get('/api/gym/members/:id/face', gymAuth, async (req, res) => {
    try {
      const m = await memberOf(req, res); if (!m) return;
      const buf = await sourceImage(m);
      if (!buf) return res.status(404).json({ success: false, error: 'לא נמצאה תמונה' });
      res.setHeader('Cache-Control', 'no-store');
      res.type('jpg').send(buf);
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ==================== ENTRY LOG ====================
  function publicEntry(e) {
    return {
      id: String(e._id), time: e.time, name: e.name || '', memberId: e.memberId ? String(e.memberId) : null,
      mac: e.mac, door: e.door || '', method: e.method || '', result: e.result || 'unknown', raw: undefined,
    };
  }
  function methodOf(t) {
    const s = String(t || '').toLowerCase();
    if (s.includes('face')) return 'face';
    if (s.includes('card')) return 'card';
    if (s.includes('pass') || s.includes('pin') || s.includes('code')) return 'pin';
    if (s.includes('app') || s.includes('remote') || s.includes('call')) return 'remote';
    return s || 'other';
  }
  function resultOf(r) {
    const s = r.status ?? r.result ?? r.unlock_result;
    if (s === undefined || s === null || s === '') return 'unknown';
    const v = String(s).toLowerCase();
    if (['1', 'true', 'ok', 'success', 'succeed', 'pass'].includes(v)) return 'granted';
    if (['0', 'false', 'fail', 'failed', 'denied', 'refuse'].includes(v)) return 'denied';
    return 'unknown';
  }

  // Pull recent unlock records from every gym panel into gym_entries.
  // Field names are calibrated from the debug log (first record's keys are logged).
  app.post('/api/gym/entries/sync', gymAuth, async (req, res) => {
    const gymId = req.gym._id;
    try {
      const d = await database();
      const members = await d.collection('gym_members').find({ gymId }).project({ firstName: 1, lastName: 1 }).toArray();
      const byName = Object.fromEntries(members.map(m => [`${m.firstName} ${m.lastName}`.trim(), m._id]));
      const out = [];
      for (const p of (req.gym.panels || [])) {
        const r = { mac: p.mac, label: p.label, added: 0 };
        try {
          const addr = await resolvePanelAddress(p.mac);
          if (!addr) { r.error = 'הפנל לא מחובר'; out.push(r); continue; }
          const [host, portStr] = addr.split(':'); const port = parseInt(portStr, 10) || 80;
          const login = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
          const token = login?.data?.token;
          if (!token) { r.error = 'התחברות לפנל נכשלה'; out.push(r); continue; }
          const page = await panelHttpGetWithHeaders(host, port, '/api/v1/records/unlock?page_num=1&page_size=100&type=&label=', { Authorization: 'Bearer ' + token });
          const list = page?.data?.list || [];
          dbg(gymId, 'entries_page', { mac: p.mac, count: list.length, total: page?.data?.total, firstKeys: list[0] ? Object.keys(list[0]) : [], first: list[0] || null });
          for (const rec of list) {
            const t = Number(rec.unlock_time || rec.time || rec.create_time || 0);
            if (!t) continue;
            const name = String(rec.label || rec.name || rec.user_name || rec.access_label || '').trim();
            const key = `${p.mac}|${t}|${rec.access_content || rec.id || name}`;
            const doc = {
              gymId, key, mac: p.mac, door: p.label || p.mac, time: new Date(t), name,
              memberId: byName[name] || null, method: methodOf(rec.access_type || rec.type), result: resultOf(rec), raw: rec,
            };
            const u = await d.collection('gym_entries').updateOne({ gymId, key }, { $setOnInsert: doc }, { upsert: true });
            if (u.upsertedCount) {
              r.added++;
              if (doc.memberId && doc.result !== 'denied') {
                await d.collection('gym_members').updateOne({ _id: doc.memberId, $or: [{ lastEntry: null }, { lastEntry: { $lt: doc.time } }, { lastEntry: { $exists: false } }] }, { $set: { lastEntry: doc.time } });
              }
            }
          }
          r.ok = true;
        } catch (e) { r.error = e.message; }
        out.push(r);
      }
      await d.collection('gyms').updateOne({ _id: gymId }, { $set: { lastEntrySync: new Date() } });
      res.json({ success: true, panels: out });
    } catch (e) { dbg(gymId, 'entries_sync_error', { error: e.message }); res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/gym/entries', gymAuth, async (req, res) => {
    try {
      const d = await database();
      const q = { gymId: req.gym._id };
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayStr();
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
      q.time = { $gte: new Date(jerusalemMs(from, 0, 0, 0)), $lte: new Date(jerusalemMs(to, 23, 59, 59)) };
      if (['granted', 'denied', 'unknown'].includes(req.query.result)) q.result = req.query.result;
      if (req.query.method && req.query.method !== 'all') q.method = String(req.query.method);
      if (req.query.door && req.query.door !== 'all') q.mac = cleanMac(req.query.door);
      if (req.query.q) q.name = { $regex: String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const total = await d.collection('gym_entries').countDocuments(q);
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const size = 50;
      const rows = await d.collection('gym_entries').find(q).sort({ time: -1 }).skip((page - 1) * size).limit(size).toArray();
      const all = await d.collection('gym_entries').find(q).project({ result: 1, time: 1 }).toArray();
      const byHour = {};
      all.forEach(e => { const h = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(e.time); byHour[h] = (byHour[h] || 0) + 1; });
      const peak = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
      const memberIds = [...new Set(rows.map(r => r.memberId).filter(Boolean).map(String))];
      const pm = await plansMap(d, req.gym._id);
      const ms = memberIds.length ? await d.collection('gym_members').find({ _id: { $in: memberIds.map(oid) } }).project({ planId: 1 }).toArray() : [];
      const planOf = Object.fromEntries(ms.map(m => [String(m._id), pm[String(m.planId)] ? pm[String(m.planId)].name : '']));
      res.json({
        success: true, total, page, pageSize: size,
        totals: { attempts: all.length, granted: all.filter(e => e.result === 'granted').length, denied: all.filter(e => e.result === 'denied').length, peakHour: peak ? `${peak[0]}:00` : null },
        entries: rows.map(e => ({ ...publicEntry(e), planName: e.memberId ? planOf[String(e.memberId)] || '' : '' })),
        lastSync: req.gym.lastEntrySync || null,
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/gym/entries/export', gymAuth, async (req, res) => {
    try {
      const d = await database();
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayStr();
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
      const rows = await d.collection('gym_entries').find({ gymId: req.gym._id, time: { $gte: new Date(jerusalemMs(from, 0, 0, 0)), $lte: new Date(jerusalemMs(to, 23, 59, 59)) } }).sort({ time: -1 }).toArray();
      const fmt = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
      const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
      const METHOD_HE = { face: 'פנים', card: 'כרטיס', pin: 'קוד', remote: 'מרחוק', other: 'אחר' };
      const RESULT_HE = { granted: 'נכנס', denied: 'נדחה', unknown: 'לא ידוע' };
      const lines = [['מועד', 'מנוי', 'דלת', 'אמצעי', 'תוצאה'].map(esc).join(',')]
        .concat(rows.map(r => [fmt.format(r.time), r.name || 'לא מזוהה', r.door, METHOD_HE[r.method] || r.method, RESULT_HE[r.result] || r.result].map(esc).join(',')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="entries-${from}-${to}.csv"`);
      res.send('﻿' + lines.join('\r\n'));
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Door connectivity check (one NexHome resolve per door).
  app.get('/api/gym/doors/status', gymAuth, async (req, res) => {
    const out = [];
    for (const p of (req.gym.panels || [])) {
      try { const addr = await resolvePanelAddress(p.mac); out.push({ mac: p.mac, label: p.label, online: !!addr }); }
      catch (e) { out.push({ mac: p.mac, label: p.label, online: false, error: e.message }); }
    }
    res.json({ success: true, doors: out });
  });

  app.get('/api/gym/actions', gymAuth, async (req, res) => {
    const d = await database();
    const rows = await d.collection('gym_actions').find({ gymId: req.gym._id }).sort({ at: -1 }).limit(100).toArray();
    res.json({ success: true, actions: rows.map(a => ({ action: a.action, by: a.by, at: a.at, details: a.details, memberId: a.memberId ? String(a.memberId) : null })) });
  });

  // Read-only debug log for this gym (calibrating panel record fields).
  app.get('/api/gym/debug', gymAuth, (req, res) => {
    res.json({ success: true, log: debugLog.filter(l => l.gymId === String(req.gym._id)).slice(-100) });
  });

  // ==================== MANAGER: GYM ACCOUNTS ====================
  app.post('/api/manager/gyms/list', async (req, res) => {
    if (!isAdmin(req.body)) return res.status(401).json({ success: false, error: 'unauthorized' });
    const d = await database();
    const gyms = await d.collection('gyms').find({}).sort({ createdAt: -1 }).toArray();
    const counts = await d.collection('gym_members').aggregate([{ $group: { _id: '$gymId', n: { $sum: 1 } } }]).toArray();
    const cm = Object.fromEntries(counts.map(c => [String(c._id), c.n]));
    res.json({ success: true, gyms: gyms.map(g => ({ id: String(g._id), name: g.name, address: g.address || '', loginPhone: g.loginPhone, plainPassword: g.plainPassword, panels: g.panels || [], disabled: !!g.disabled, members: cm[String(g._id)] || 0, createdAt: g.createdAt, lastLogin: g.lastLogin || null })) });
  });

  app.post('/api/manager/gyms/create', async (req, res) => {
    try {
      if (!isAdmin(req.body)) return res.status(401).json({ success: false, error: 'unauthorized' });
      const name = String(req.body.name || '').trim().slice(0, 80);
      const loginPhone = cleanPhone(req.body.loginPhone);
      if (!name) return res.status(400).json({ success: false, error: 'חסר שם חדר הכושר' });
      if (loginPhone.length < 9) return res.status(400).json({ success: false, error: 'מספר טלפון לא תקין' });
      const panels = (Array.isArray(req.body.panels) ? req.body.panels : [])
        .map(p => ({ mac: cleanMac(p.mac), label: String(p.label || '').trim().slice(0, 40) || 'כניסה ראשית' }))
        .filter(p => /^[0-9A-F]{12}$/.test(p.mac));
      const d = await database();
      const exists = await d.collection('gyms').findOne({ loginPhone });
      if (exists) return res.status(409).json({ success: false, error: 'מספר הטלפון כבר קיים במערכת' });
      const plain = genPassword();
      const r = await d.collection('gyms').insertOne({
        name, loginPhone, password: bcrypt.hashSync(plain, 10), plainPassword: plain,
        address: String(req.body.address || '').trim().slice(0, 120),
        panels, disabled: false, createdAt: new Date(), createdBy: req.body.username,
      });
      logActivity({ phoneNumber: req.body.username, action: 'gym_create', mac: panels[0]?.mac || null, details: { name, loginPhone }, success: true });
      res.json({ success: true, id: String(r.insertedId), loginPhone, password: plain });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/manager/gyms/update', async (req, res) => {
    try {
      if (!isAdmin(req.body)) return res.status(401).json({ success: false, error: 'unauthorized' });
      const id = oid(req.body.id); if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
      const d = await database();
      const set = {};
      if (req.body.name !== undefined) set.name = String(req.body.name).trim().slice(0, 80);
      if (req.body.disabled !== undefined) set.disabled = !!req.body.disabled;
      if (Array.isArray(req.body.panels)) {
        set.panels = req.body.panels.map(p => ({ mac: cleanMac(p.mac), label: String(p.label || '').trim().slice(0, 40) || 'כניסה' }))
          .filter(p => /^[0-9A-F]{12}$/.test(p.mac));
      }
      let password;
      if (req.body.resetPassword) { password = genPassword(); set.password = bcrypt.hashSync(password, 10); set.plainPassword = password; }
      await d.collection('gyms').updateOne({ _id: id }, { $set: set });
      if (req.body.resetPassword || set.disabled) await d.collection('gym_sessions').deleteMany({ gymId: id });
      res.json({ success: true, password });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  dbg(null, 'gym_module_loaded', null);
};
