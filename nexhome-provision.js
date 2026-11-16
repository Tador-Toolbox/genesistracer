// ==================== NEXHOME PROVISIONING ====================
// Open a NexHome project (community) and add a panel (MAC) to it, online.
// Ported 1:1 from ResidentEnroll (nexhome_create_project / nexhome_assign_mac,
// bodies confirmed from HARs). Uses the pool's account[0] (ort_tadorcom), the same
// account ResidentEnroll uses.
//
// Routes (manager auth = ADMIN_USER/ADMIN_PASS in the body):
//   POST /api/manager/nexhome/open   {name, address, mac}  → project (create if missing) + add MAC
//   POST /api/manager/nexhome/debug  → last operations (in-memory log)

const crypto = require('crypto');

const NEXHOME_BASE = 'https://nexsmart-us.nexhome.ai';
const APP_ID = 'INTERNATIONAL_COMMUNITY_MANAGER_WEB';

const PROJECT_TEMPLATE = {"communityType":"COMMUNITY","address":"__ADDR__","name":"__NAME__","managerIds":[],"maxApartmentUser":10,"timeZone":"Asia/Tel_Aviv","deviceOfflineMonitorMinute":3,"isEmailPush":false,"deviceOfflinePushAppEnable":false,"deviceOnlinePushEngineerManager":false,"deviceOnlinePushEstateManager":false,"deviceOnlinePushAppEnable":false,"deviceLanguageConfig":"en","deviceSipPhoneBookDisplay":"1","deviceContactCallConfigMode":"FULL_CALL_NUMBER","deviceCallWay":"sip","deployPushConfigEnable":true,"deviceCloudMode":"DIRECT_MODE","cardFormat":"8HN","userAppAddAccessCardRestricted":true,"userAppFaceEnrollmentRestricted":false,"userAppNfcUnlockRestricted":false,"userAppAccessKeySettingRestricted":false,"userAppTemporaryKeyUseRestricted":false,"memberType":"0","userAccountTypeRestrict":"unrestricted","lockedViewMode":"","countryCode":"IL","communityConfigs":[{"configCode":"SPWC001","values":{"deviceLanguageConfig":"en","deviceOfflinePushEstateManager":"disable","deviceOfflinePushAppEnable":"disable","deviceOnlinePushEngineerManager":"disable","deviceOnlinePushEstateManager":"disable","deviceOnlinePushAppEnable":"disable","deviceCardFormat":"8HN","deviceSipPhoneBookDisplay":"1","deviceCallWay":"sip","deviceOfflineMonitorMinute":3,"deviceOfflinePushEngineerManager":"disable","faviconKey":null,"userAppAddAccessCardRestricted":"enable","userAppFaceEnrollmentRestricted":"disable","userAppNfcUnlockRestricted":"disable","userAppAccessKeySettingRestricted":"disable","userAppTemporaryKeyUseRestricted":"disable","memberType":"0","userAccountTypeRestrict":"unrestricted","lockedViewMode":null,"DEVICE_CONTACT_CALL_CONFIG":"{\"mode\":\"FULL_CALL_NUMBER\"}"}},{"configCode":"DEPLOY_PUSH_CONFIG","values":{"deployPushConfigEnable":"enable","deployPushConfigAlarmType":["1","2","3","4","5","9","99","1001","1002","1003","1004","1005","1006","1007","1300","10","0","9999","2003","2004"]}}]};

const ERRORS = {
  WISP_PUBLICS_DEVICE_MAC_NO_IMPORT: 'ה-MAC לא קיים במאגר המכשירים של NexHome (הפנל לא יובא ל-NexHome)',
};

module.exports = function registerNexhomeProvision(app, { axios, getProvisionAccount, searchMac, logActivity }) {
  const debugLog = [];
  function dbg(event, data) {
    debugLog.push({ at: new Date().toISOString(), event, data });
    if (debugLog.length > 200) debugLog.shift();
    console.log(`🏗️ [nexhome-provision] ${event}`, data ? JSON.stringify(data).slice(0, 400) : '');
  }
  const isAdmin = (b) => b && b.username === (process.env.ADMIN_USER || 'admin') && b.password === process.env.ADMIN_PASS;
  const cleanMac = (m) => String(m || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

  function headers(acc, extra = {}) {
    return {
      'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0', AppId: APP_ID, Language: 'en', ApiVersion: '1.0', Version: '1.0.0',
      RequestId: crypto.randomUUID().replace(/-/g, ''),
      EmployeeAccountId: acc.employeeAccountId, 'Customer-Id': acc.customerId,
      Authorization: acc.token, Token: acc.token, AccessToken: acc.token,
      ...extra,
    };
  }
  async function nhGet(path, h, label) {
    try { const r = await axios.get(NEXHOME_BASE + path, { headers: h, timeout: 30000 }); dbg(label, { code: r.data?.code }); return r.data || {}; }
    catch (e) { dbg(label + '_error', { status: e.response?.status, body: e.response?.data }); return e.response?.data || { code: 'ERR', msg: e.message }; }
  }
  async function nhPost(path, body, h, label) {
    try { const r = await axios.post(NEXHOME_BASE + path, body, { headers: h, timeout: 30000 }); dbg(label, { code: r.data?.code, msg: r.data?.msg }); return r.data || {}; }
    catch (e) { dbg(label + '_error', { status: e.response?.status, body: e.response?.data }); return e.response?.data || { code: 'ERR', msg: e.message }; }
  }
  const ok = (r) => String(r && r.code) === '0';
  const errText = (r) => ERRORS[r?.code] || ERRORS[r?.msg] || r?.msg || ('code ' + (r && r.code));

  async function findProject(acc, name) {
    const cl = await nhGet('/api/employees/communities?unPage=true', headers(acc), 'communities');
    const els = (cl.result && cl.result.elements) || [];
    return els.find(e => (e.name || '').trim() === name) || null;
  }

  // Full flow for one panel. Every step is reported back so the manager sees what happened.
  async function openInNexhome({ name, address, mac }) {
    const steps = [];
    const acc = await getProvisionAccount();
    const pname = String(name || '').trim();
    const m = cleanMac(mac);
    if (!pname) return { ok: false, error: 'חסר שם פרויקט', steps };
    if (!/^[0-9A-F]{12}$/.test(m)) return { ok: false, error: 'MAC לא תקין (12 תווים)', steps };

    // 1) Is this MAC already used in some project? Then don't touch anything.
    try {
      const md = await searchMac(acc, m);
      const entry = ((md && md.result && (md.result.elements || md.result.list)) || [])[0];
      dbg('mac_entry', { mac: m, entry: entry || null });
      const used = entry && (entry.usedCommunityId || entry.communityName);
      steps.push({ step: 'בדיקת MAC', ok: true, detail: entry ? (used ? `כבר משויך לפרויקט ${entry.communityName || entry.usedCommunityId}` : 'קיים במאגר, לא משויך') : 'לא נמצא במאגר' });
      if (used) return { ok: true, already: true, project: entry.communityName || null, steps };
    } catch (e) { steps.push({ step: 'בדיקת MAC', ok: false, detail: e.message }); }

    // 2) Project: reuse by exact name, else create.
    let proj = await findProject(acc, pname);
    if (proj) steps.push({ step: 'פרויקט', ok: true, detail: `קיים: ${proj.name}` });
    else {
      const body = JSON.parse(JSON.stringify(PROJECT_TEMPLATE));
      body.name = pname; body.address = String(address || '').trim() || 'not assigned yet';
      const cr = await nhPost('/api/employees/communities', body, headers(acc), 'create_project');
      if (!ok(cr)) { steps.push({ step: 'יצירת פרויקט', ok: false, detail: errText(cr) }); return { ok: false, error: errText(cr), steps }; }
      steps.push({ step: 'יצירת פרויקט', ok: true, detail: `נוצר: ${cr.result?.name || pname} (${cr.result?.code || ''})` });
      proj = { id: cr.result?.id, name: cr.result?.name || pname, code: cr.result?.code };
      if (!proj.id) proj = await findProject(acc, pname);
      if (!proj) return { ok: false, error: 'הפרויקט נוצר אבל לא נמצא ברשימה', steps };
    }

    // 3) Public area of the project.
    const ch = headers(acc, { 'Community-Id': proj.id });
    const ap = await nhGet('/api/employees/apartments?unPage=true', ch, 'apartments');
    const aels = (ap.result && ap.result.elements) || [];
    const area = aels.find(e => e.roomNumber === '0000' || e.buildingName === 'Public') || aels[0];
    if (!area) { steps.push({ step: 'אזור ציבורי', ok: false, detail: 'לא נמצא' }); return { ok: false, error: 'לא נמצא אזור ציבורי בפרויקט', steps }; }

    // 4) Add the panel as a public door phone (body from ResidentEnroll / HAR).
    const body = {
      name: pname, publicsAreaId: area.id, publicsAreaType: 0, networkGroup: 0,
      type: 3, ipMode: 'DHCP', mac: m, isPublicDevice: true,
      nodeIdList: [area.id], nodeType: 0,
      deviceConfigs: { monitorEnable: true, transferMode: 'UDP' },
      relayList: [{ name: 'Relay1', code: 1, openMethodList: ['APP_HOME_PAGE', 'CALL_PAGE', 'PASSWORD', 'FACE', 'CARD', 'QRCODE', 'NFC'], isOpen: true }],
      installLocation: 2, floorId: null, autoLight: false, releaseButtonPermission: false,
    };
    const dr = await nhPost('/api/employees/publics/devices', body, ch, 'create_device');
    if (!ok(dr)) { steps.push({ step: 'הוספת הפנל', ok: false, detail: errText(dr) }); return { ok: false, error: errText(dr), project: proj.name, steps }; }
    steps.push({ step: 'הוספת הפנל', ok: true, detail: `נוסף לפרויקט ${proj.name}` });
    return { ok: true, project: proj.name, projectCode: proj.code || null, deviceId: dr.result?.id || null, steps };
  }

  app.post('/api/manager/nexhome/open', async (req, res) => {
    if (!isAdmin(req.body)) return res.status(401).json({ success: false, error: 'unauthorized' });
    try {
      const out = await openInNexhome(req.body);
      dbg('open_result', { name: req.body.name, mac: req.body.mac, ok: out.ok, error: out.error, steps: out.steps });
      logActivity({ phoneNumber: req.body.username, action: 'nexhome_open', mac: cleanMac(req.body.mac), details: { name: req.body.name, ok: out.ok, error: out.error }, success: !!out.ok });
      res.json({ success: !!out.ok, ...out });
    } catch (e) { dbg('open_error', { error: e.message }); res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/manager/nexhome/debug', (req, res) => {
    if (!isAdmin(req.body)) return res.status(401).json({ success: false, error: 'unauthorized' });
    res.json({ success: true, log: debugLog.slice(-80) });
  });

  return { openInNexhome };
};
