require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== IP RESTRICTION (ISRAEL ONLY) ====================
const ISRAEL_IP_RANGES = [
  '2.176.0.0/12', '5.28.0.0/14', '31.154.0.0/15', '37.142.0.0/15',
  '46.116.0.0/14', '77.124.0.0/14', '79.176.0.0/13', '80.178.0.0/15',
  '82.80.0.0/12', '85.64.0.0/13', '85.250.0.0/15', '87.68.0.0/14',
  '89.138.0.0/15', '91.90.0.0/15', '94.188.0.0/14', '109.64.0.0/13',
  '176.12.0.0/14', '185.2.0.0/16', '185.94.0.0/16', '188.64.0.0/13',
  '212.25.0.0/16', '217.11.16.0/20'
];

function ipToInt(ip) {
  return ip.split('.').reduce((int, octet) => (int << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIsraeliIP(ip) {
  // Local/Private IPs are always allowed
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return true;
  }

  // IPv6 localhost
  if (ip === '::ffff:127.0.0.1') return true;

  // Extract IPv4 from IPv6 format
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  const ipInt = ipToInt(ip);

  for (const range of ISRAEL_IP_RANGES) {
    const [subnet, bits] = range.split('/');
    const mask = ~(2 ** (32 - parseInt(bits)) - 1);
    const subnetInt = ipToInt(subnet);

    if ((ipInt & mask) === (subnetInt & mask)) {
      return true;
    }
  }

  return false;
}

// Middleware: Check IP before every request
app.use((req, res, next) => {
  // Enable/disable IP restriction via environment variable
  const ENABLE_IP_RESTRICTION = process.env.RESTRICT_TO_ISRAEL === 'true';

  if (!ENABLE_IP_RESTRICTION) return next();

  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection.remoteAddress;

  if (!isIsraeliIP(clientIP)) {
    console.log(`❌ Blocked IP: ${clientIP}`);
    return res.status(403).json({ 
      success: false, 
      error: 'Access denied. This service is only available in Israel. / גישה נדחתה. שירות זה זמין רק בישראל.' 
    });
  }

  next();
});

app.use(express.static('public'));

const NEXHOME_BASE = 'https://nexsmart-us.nexhome.ai';
const USERNAME = 'ort_tadorcom';
const PASSWORD = '5uWRg8sR';
const APP_ID = 'INTERNATIONAL_COMMUNITY_MANAGER_WEB';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// -------------------- NexHome auth token cache (for speed) --------------------
let cachedAuth = null;
let cachedAuthExpiresAt = 0; // epoch ms

function isAuthValid() {
  return cachedAuth && Date.now() < cachedAuthExpiresAt;
}

async function tryLoginToNexHome(passwordToSend) {
  const res = await axios.post(
    `${NEXHOME_BASE}/api/employees/account/login`,
    {
      loginName: USERNAME,
      password: passwordToSend,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        AppId: APP_ID,
        Referer: NEXHOME_BASE + '/login',
        Origin: NEXHOME_BASE,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
      },
      timeout: 15000,
    }
  );

  return res.data;
}

async function getAuthToken() {
  if (isAuthValid()) return cachedAuth;

  // Try MD5 first (old behavior), then plain text (in case they changed)
  const candidates = [md5(PASSWORD), PASSWORD];

  let lastData = null;

  for (const pass of candidates) {
    try {
      const data = await tryLoginToNexHome(pass);
      lastData = data;

      const token = data?.result?.tokenInfo?.token;
      const employeeAccountId = data?.result?.employeeInfo?.accountId;
      const customerId = data?.result?.employeeInfo?.customerId;
      const engineeringId = data?.result?.employeeInfo?.engineeringId;

      if (token) {
        cachedAuth = { token, employeeAccountId, customerId, engineeringId };
        cachedAuthExpiresAt = Date.now() + 8 * 60 * 1000;
        console.log('✅ NexHome login success (cached)');
        return cachedAuth;
      }
    } catch (err) {
      lastData = err?.response?.data || { message: err.message };
    }
  }

  const code = lastData?.code || lastData?.result?.code || null;
  const message =
    lastData?.message ||
    lastData?.msg ||
    lastData?.result?.message ||
    'NexHome login failed';

  throw new Error(
    `NexHome login failed${code ? ` (${code})` : ''}: ${message}`
  );
}

async function searchMac(auth, mac) {
  const headers = {
    Authorization: auth.token,
    AppId: APP_ID,
    Version: '1.0.0',
    ApiVersion: '1.0',
    Language: 'en',
    EmployeeAccountId: auth.employeeAccountId,
    'Customer-Id': auth.customerId,
    RequestId: crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json, text/plain, */*',
  };

  const endpoints = [
    `${NEXHOME_BASE}/api/employees/publics/devicelibraries?page=0&size=10&engineeringId=${auth.engineeringId}&mac=${mac}`,
    `${NEXHOME_BASE}/api/employees/device/mac/list`,
    `${NEXHOME_BASE}/api/device/mac/list`,
  ];

  for (const url of endpoints) {
    try {
      const params = url.includes('?') ? {} : { mac, pageNum: 1, pageSize: 10 };
      const res = await axios.get(url, { params, headers, timeout: 15000 });
      if (
        res.data?.code === '0' ||
        (res.data?.code !== 'SYS_1' && res.data?.code !== 'SYS_0050')
      ) {
        return res.data;
      }
    } catch (err) {
      // Try next endpoint
    }
  }
  return null;
}

async function getDeviceByMac(auth, mac, communityId) {
  const headers = {
    Authorization: auth.token,
    AppId: APP_ID,
    Version: '1.0',
    Apiversion: '1.0',
    Language: 'en',
    'Community-Id': communityId,
    'Customer-Id': auth.customerId,
    EmployeeAccountId: auth.employeeAccountId,
    RequestId: crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
  };

  const url = `${NEXHOME_BASE}/api/employees/publics/devices`;

  const res = await axios.get(url, {
    params: {
      type: '2,3,7,8,9',
      size: 10,
      page: 0,
      isReload: true,
      mac,
      isCloudEnabled: true,
    },
    headers,
    timeout: 15000,
  });

  return res.data;
}

async function getReverseLoginInfo(auth, deviceId, communityId) {
  const headers = {
    Authorization: auth.token,
    AppId: APP_ID,
    Version: '1.0',
    Apiversion: '1.0',
    Language: 'en',
    'Community-Id': communityId,
    'Customer-Id': auth.customerId,
    EmployeeAccountId: auth.employeeAccountId,
    RequestId: crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=UTF-8',
  };

  const url = `${NEXHOME_BASE}/api/employees/publics/devices/${deviceId}:reverseLogin`;
  const res = await axios.post(url, { type: 'WEB' }, { headers, timeout: 15000 });
  return res.data;
}

// -------------------- API: Lookup --------------------
app.post('/api/lookup', async (req, res) => {
  const { mac } = req.body;
  if (!mac || !mac.trim()) {
    return res.status(400).json({ success: false, error: 'MAC address is required' });
  }

  const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();

  try {
    const auth = await getAuthToken();
    const macData = await searchMac(auth, cleanMac);

    const macList = macData?.result?.elements || macData?.result?.list || [];
    const macEntry = macList[0] || null;

    if (!macEntry) {
      return res.json({ success: false, error: 'No device found with this MAC in MAC library' });
    }

    const communityId = macEntry.usedCommunityId || macEntry.communityId;
    const deviceData = await getDeviceByMac(auth, cleanMac, communityId);

    const deviceList = deviceData?.result?.elements || deviceData?.result?.list || [];
    const deviceEntry = deviceList[0] || null;

    if (!deviceEntry) {
      return res.json({ success: false, error: 'No device found in device list' });
    }

    const deviceId = deviceEntry.id;
    const reverseLoginData = await getReverseLoginInfo(auth, deviceId, communityId);

    const ip = reverseLoginData?.result?.targetHost || null;
    const port = reverseLoginData?.result?.targetPort || null;

    return res.json({
      success: true,
      mac: cleanMac,
      ip: ip || 'Not found',
      port: port || null,
      fullAddress: ip && port ? `${ip}:${port}` : ip || 'Not available',
      sn: macEntry.sn || deviceEntry.mac,
      project: macEntry.communityName || deviceEntry.communityName,
      deviceName: deviceEntry.name || macEntry.communityName,
      deviceType: deviceEntry.type || 'Door Phone',
      deviceModel: deviceEntry.model || 'T98',
      status: deviceEntry.onlineStatus || macEntry.status,
      building: deviceEntry.buildingName || null,
      apartment: deviceEntry.roomNumber || null,
    });
  } catch (err) {
    console.error('Lookup error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Debug endpoint
app.get('/api/debug/:mac', async (req, res) => {
  try {
    const auth = await getAuthToken();
    const cleanMac = req.params.mac.replace(/[:\-\s]/g, '').toUpperCase();
    const macData = await searchMac(auth, cleanMac);
    res.json({ success: true, macData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== MANAGEMENT ENDPOINTS ====================

// Manager login
app.post('/api/manager/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await db.loginManager(username, password);
  res.json(result);
});

// Create installer account
app.post('/api/manager/installers', async (req, res) => {
  try {
    const { phoneNumber, macAddresses, panelType, accountType } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    const password = await db.createInstaller(phoneNumber, macAddresses || [], panelType || "genesis7");
    if (accountType && accountType !== 'installer') {
      await db.updateAccountType(phoneNumber, accountType);
    }
    res.json({ success: true, phoneNumber, password });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all installers
app.get('/api/manager/installers', async (req, res) => {
  const installers = await db.getInstallers();
  res.json({ success: true, installers });
});

// Get installer details
app.get('/api/manager/installers/:phoneNumber', async (req, res) => {
  const installer = await db.getInstallerDetails(req.params.phoneNumber);
  if (!installer) {
    return res.status(404).json({ success: false, error: 'Installer not found' });
  }
  res.json({ success: true, installer });
});

// Assign MAC to installer
app.post('/api/manager/installers/:phoneNumber/macs', async (req, res) => {
  try {
    const {
      macAddress,
      address = '',
      city = '',
      notes = '',
      purchaseDate = '',
      startDate = '',
      technicianName = '',
      technicianPhone = '',
      supplierName = '',
      committeeName = '',
      committeePhone = '',
      description = '',
      annualFee = '',
      licensesPurchased = '',
      licensePaid = false,
      panelType = 'genesis7',
      voipbellAccount = '',
    } = req.body;

    const cleanMac = (macAddress || '').replace(/[:\s-]/g, '').toUpperCase();
    if (!cleanMac) return res.status(400).json({ success: false, error: 'macAddress required' });

    await db.assignMacToInstaller(
      req.params.phoneNumber,
      cleanMac,
      address,
      city,
      notes,
      purchaseDate,
      startDate,
      technicianName,
      technicianPhone,
      supplierName,
      committeeName,
      committeePhone,
      description,
      annualFee,
      licensesPurchased,
      licensePaid,
      panelType,
      voipbellAccount
    );

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Remove MAC
app.delete('/api/manager/installers/:phoneNumber/macs/:macAddress', async (req, res) => {
  try {
    const cleanMac = (req.params.macAddress || '').replace(/[:\s-]/g, '').toUpperCase();
    await db.removeMacFromInstaller(req.params.phoneNumber, cleanMac);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete installer
app.delete('/api/manager/installers/:phoneNumber', async (req, res) => {
  await db.deleteInstaller(req.params.phoneNumber);
  res.json({ success: true });
});


app.post('/api/manager/installers/:phoneNumber/panel-type', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { panelType } = req.body;
    if (!['genesis7', 'genesis5'].includes(panelType)) return res.status(400).json({ success: false, error: 'Invalid panel type' });
    await require('./db').updateInstallerPanelType(phoneNumber, panelType);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// Reset installer password
app.post('/api/manager/installers/:phoneNumber/reset-password', async (req, res) => {
  try {
    const newPassword = await db.resetPassword(req.params.phoneNumber);
    res.json({ success: true, password: newPassword });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get login logs
app.get('/api/manager/logs', async (req, res) => {
  const logs = await db.getLoginLogs();
  res.json({ success: true, logs });
});

// ==================== DATABASE BACKUP ENDPOINT ====================
app.get('/api/manager/backup', async (req, res) => {
  try {
    const backup = await db.getFullDatabaseBackup();
    
    const filename = `genesistracer-backup-${new Date().toISOString().split('T')[0]}.json`;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(backup);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== EXCEL EXPORT ====================
app.get('/api/manager/export-excel', async (req, res) => {
  try {
    const installers = await db.getAllInstallersWithMacs();
    // Build CSV with BOM for Excel Hebrew support
    const bom = '﻿';
    const headers = ['מספר טלפון','סיסמה','דגם','כתובת MAC','עיר','כתובת','שם טכנאי','טלפון טכנאי','שם ועד','טלפון ועד','שם ספק','תאריך רכישה','תאריך תחילת עבודה','דמי רישיון','כמה רשיונות','שולם','הערות מנהל','תאריך יצירה'];
    const rows = [];
    for (const inst of installers) {
      if (!inst.macAddresses || inst.macAddresses.length === 0) {
        rows.push([inst.phoneNumber, inst.plainPassword || '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', inst.managerNote || '', inst.createdAt ? new Date(inst.createdAt).toLocaleDateString('he-IL') : '']);
      } else {
        for (const mac of inst.macAddresses) {
          rows.push([
            inst.phoneNumber, inst.plainPassword || '',
            (mac.panelType||'genesis7')==='genesis5'?'Genesis 5':'Genesis 7',
            mac.mac||'', mac.city||'', mac.address||'',
            mac.technicianName||'', mac.technicianPhone||'',
            mac.committeeName||'', mac.committeePhone||'',
            mac.supplierName||'', mac.purchaseDate||'', mac.startDate||'',
            mac.annualFee||'', mac.licensesPurchased||'',
            mac.licensePaid?'כן':'לא',
            inst.managerNote||'',
            inst.createdAt ? new Date(inst.createdAt).toLocaleDateString('he-IL') : ''
          ]);
        }
      }
    }
    const escape = v => '"' + String(v||'').replace(/"/g,'""') + '"';
    const csv = bom + [headers, ...rows].map(r => r.map(escape).join(',')).join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="genesistracer-export-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== CHAT ====================
// IMPORTANT: specific routes before :phoneNumber wildcard
app.get('/api/chat/unread/all', async (req, res) => {
  try {
    const counts = await db.getAllUnreadCounts();
    res.json({ success: true, counts });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/chat/:phoneNumber', async (req, res) => {
  try {
    const messages = await db.getChatMessages(req.params.phoneNumber);
    console.log(`💬 Chat GET: phone=${req.params.phoneNumber} count=${messages.length}`);
    res.json({ success: true, messages });
  } catch(e) {
    console.error(`❌ Chat GET error:`, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/chat/:phoneNumber/read', async (req, res) => {
  try {
    const { from } = req.body;
    await db.markMessagesRead(req.params.phoneNumber, from);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/chat/:phoneNumber', async (req, res) => {
  try {
    const { from, text } = req.body;
    console.log(`💬 Chat POST: phone=${req.params.phoneNumber} from=${from} text=${text}`);
    if (!text || !from) return res.status(400).json({ success: false, error: 'missing fields' });
    const msg = await db.sendChatMessage(req.params.phoneNumber, from, text);
    console.log(`✅ Chat message saved`);
    res.json({ success: true, message: msg });
  } catch(e) {
    console.error(`❌ Chat POST error:`, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== MANAGER NOTES ====================
app.post('/api/manager/installers/:phoneNumber/note', async (req, res) => {
  try {
    const { note } = req.body;
    await db.setManagerNote(req.params.phoneNumber, note || '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/installer/note', async (req, res) => {
  try {
    const { phoneNumber } = req.query;
    const note = await db.getManagerNote(phoneNumber);
    res.json({ success: true, note });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Installer saves description
app.post('/api/installer/description', async (req, res) => {
  try {
    const { phoneNumber, mac, description } = req.body;
    const cleanMac = (mac || '').replace(/[:\s-]/g, '').toUpperCase();

    // Update ONLY the description field — do not touch any other field
    await db.updateMacField(phoneNumber, cleanMac, 'description', description || '');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Keep-alive ping endpoint
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ==================== REBOOT ENDPOINT ====================
app.post('/api/manager/reboot', async (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ success: false, error: 'MAC required' });

  const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();

  try {
    const auth = await getAuthToken();

    // Step 1: Find communityId from MAC library
    const macData = await searchMac(auth, cleanMac);
    const macList = macData?.result?.elements || macData?.result?.list || [];
    const macEntry = macList[0] || null;

    if (!macEntry) {
      return res.json({ success: false, error: 'Device not found in MAC library' });
    }

    const communityId = macEntry.usedCommunityId || macEntry.communityId;

    // Step 2: Get device internal ID
    const deviceData = await getDeviceByMac(auth, cleanMac, communityId);
    const deviceList = deviceData?.result?.elements || deviceData?.result?.list || [];
    const deviceEntry = deviceList[0] || null;

    if (!deviceEntry) {
      return res.json({ success: false, error: 'Device not found in device list' });
    }

    const deviceId = deviceEntry.id;

    // Step 3: Send reboot command
    const headers = {
      Authorization: auth.token,
      AppId: APP_ID,
      Version: '1.0',
      Apiversion: '1.0',
      Language: 'en',
      'Community-Id': communityId,
      'Customer-Id': auth.customerId,
      EmployeeAccountId: auth.employeeAccountId,
      RequestId: crypto.randomUUID(),
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=UTF-8',
    };

    const rebootRes = await axios.post(
      `${NEXHOME_BASE}/api/employees/publics/devices/${deviceId}:reboot`,
      {},
      { headers, timeout: 15000 }
    );

    const code = rebootRes.data?.code;
    if (code === '0' || code === 0) {
      return res.json({ success: true, message: 'Reboot command sent successfully' });
    } else {
      return res.json({ success: false, error: rebootRes.data?.message || `Unexpected response code: ${code}` });
    }

  } catch (err) {
    console.error('Reboot error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Change installer phone number
app.post('/api/manager/installers/:phoneNumber/change-phone', async (req, res) => {
  try {
    const { newPhoneNumber } = req.body;
    const oldPhoneNumber = req.params.phoneNumber;
    
    if (!newPhoneNumber) {
      return res.status(400).json({ success: false, error: 'New phone number required' });
    }
    
    await db.changeInstallerPhone(oldPhoneNumber, newPhoneNumber);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==================== AUTO REBOOT SCHEDULER ====================

// In-memory schedules: { mac: { intervalDays, hour, lastReboot, enabled } }
let autoRebootSchedules = {};

// Load schedules from DB on startup
async function loadSchedules() {
  try {
    const db = require('./db');
    await db.connectDB();
    const saved = await db.getAutoRebootSchedules();
    if (saved) autoRebootSchedules = saved;
    console.log(`✅ Auto-reboot schedules loaded (${Object.keys(autoRebootSchedules).length})`);
  } catch (err) {
    console.error('Failed to load schedules:', err.message);
  }
}

// Check and run due reboots every minute
setInterval(async () => {
  const now = new Date();

  // חישוב שעון ישראל אמין — UTC + offset
  const israelOffset = 2; // UTC+2 חורף, נשנה לקיץ בהמשך
  // בדיקת שעון קיץ ישראל: אחרון שישי מרץ עד אחרון ראשון באוקטובר
  function getIsraelOffset(d) {
    const year = d.getUTCFullYear();
    // אחרון שישי במרץ
    const marchEnd = new Date(Date.UTC(year, 2, 31));
    while (marchEnd.getUTCDay() !== 5) marchEnd.setUTCDate(marchEnd.getUTCDate() - 1);
    // אחרון ראשון באוקטובר
    const octEnd = new Date(Date.UTC(year, 9, 31));
    while (octEnd.getUTCDay() !== 0) octEnd.setUTCDate(octEnd.getUTCDate() - 1);
    return (d >= marchEnd && d < octEnd) ? 3 : 2;
  }

  const offset = getIsraelOffset(now);
  const israelMs = now.getTime() + offset * 60 * 60 * 1000;
  const il = new Date(israelMs);

  const ilYear  = il.getUTCFullYear();
  const ilMonth = String(il.getUTCMonth() + 1).padStart(2, '0');
  const ilDay   = String(il.getUTCDate()).padStart(2, '0');
  const ilHour  = il.getUTCHours();
  const ilMin   = il.getUTCMinutes();
  const israelDateTimeStr = `${ilYear}-${ilMonth}-${ilDay}T${String(ilHour).padStart(2,'0')}:${String(ilMin).padStart(2,'0')}`;

  console.log(`⏱️ Scheduler tick — Israel time: ${israelDateTimeStr}`);

  for (const [mac, sched] of Object.entries(autoRebootSchedules)) {
    if (!sched.enabled) continue;

    let shouldReboot = false;

    if (sched.type === 'once') {
      const schedDT = (sched.onceDateTime || '').slice(0, 16);
      console.log(`🔍 Once check: sched=${schedDT} now=${israelDateTimeStr}`);
      if (schedDT && israelDateTimeStr === schedDT) shouldReboot = true;
    } else {
      const [schedH, schedM] = (sched.israelTime || `${sched.israelHour || 3}:00`).split(':').map(Number);
      if (schedH === ilHour && schedM === ilMin) {
        const days = Array.isArray(sched.days) ? sched.days : [];
        const todayDOW = il.getUTCDay(); // 0=Sun
        if (days.length === 0 || days.includes(todayDOW)) shouldReboot = true;
      }
    }

    if (!shouldReboot) continue;

    try {
      console.log(`🔄 Auto-reboot: ${mac}`);
      const auth = await getAuthToken();
      const macData = await searchMac(auth, mac);
      const macList = macData?.result?.elements || macData?.result?.list || [];
      const macEntry = macList[0];
      if (!macEntry) { console.log(`⚠️ Auto-reboot: ${mac} not found`); continue; }

      const communityId = macEntry.usedCommunityId || macEntry.communityId;
      const deviceData = await getDeviceByMac(auth, mac, communityId);
      const deviceList = deviceData?.result?.elements || deviceData?.result?.list || [];
      const deviceEntry = deviceList[0];
      if (!deviceEntry) { console.log(`⚠️ Auto-reboot: device not found for ${mac}`); continue; }

      const headers = {
        Authorization: auth.token, AppId: APP_ID, Version: '1.0', Apiversion: '1.0',
        Language: 'en', 'Community-Id': communityId, 'Customer-Id': auth.customerId,
        EmployeeAccountId: auth.employeeAccountId, RequestId: crypto.randomUUID(),
        'User-Agent': 'Mozilla/5.0', Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
      };
      await axios.post(`${NEXHOME_BASE}/api/employees/publics/devices/${deviceEntry.id}:reboot`, {}, { headers, timeout: 15000 });

      autoRebootSchedules[mac].lastReboot = now.toISOString();
      if (sched.type === 'once') autoRebootSchedules[mac].enabled = false;
      await require('./db').saveAutoRebootSchedules(autoRebootSchedules);
      console.log(`✅ Auto-reboot success: ${mac}`);
    } catch (err) {
      console.error(`❌ Auto-reboot failed for ${mac}:`, err.message);
    }
  }
}, 60 * 1000);

// GET all schedules
app.get('/api/manager/auto-reboot', async (req, res) => {
  res.json({ success: true, schedules: autoRebootSchedules });
});

// SET schedule for a MAC
app.post('/api/manager/auto-reboot', async (req, res) => {
  const { mac, type, intervalDays, hour, minute, israelTime, enabled, onceDateTime } = req.body;
  if (!mac) return res.status(400).json({ success: false, error: 'MAC required' });

  const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();

  if (type === 'once') {
    autoRebootSchedules[cleanMac] = {
      type: 'once',
      onceDateTime,
      hour: parseInt(hour) || 0,
      enabled: true,
      lastReboot: autoRebootSchedules[cleanMac]?.lastReboot || null,
    };
  } else {
    const { days } = req.body;
    autoRebootSchedules[cleanMac] = {
      type: 'recurring',
      days: Array.isArray(days) ? days : [],
      hour: parseInt(hour) || 3,
      minute: parseInt(minute) || 0,
      israelTime: israelTime || '03:00',
      enabled: enabled !== false,
      lastReboot: autoRebootSchedules[cleanMac]?.lastReboot || null,
    };
  }

  try {
    await require('./db').saveAutoRebootSchedules(autoRebootSchedules);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE schedule for a MAC
app.delete('/api/manager/auto-reboot/:mac', async (req, res) => {
  const cleanMac = req.params.mac.replace(/[:\-\s]/g, '').toUpperCase();
  delete autoRebootSchedules[cleanMac];
  try {
    await require('./db').saveAutoRebootSchedules(autoRebootSchedules);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Installer login
app.post('/api/installer/login', async (req, res) => {
  const { phoneNumber, password } = req.body;
  const result = await db.loginInstaller(phoneNumber, password);
  if (result.success) result.data.ip = req.ip;
  res.json(result);
});

// ==================== INSTALLER REBOOT ====================
app.post('/api/installer/reboot', async (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ success: false, error: 'MAC required' });
  const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();
  try {
    const auth = await getAuthToken();
    const macData = await searchMac(auth, cleanMac);
    const macList = macData?.result?.elements || macData?.result?.list || [];
    const macEntry = macList[0];
    if (!macEntry) return res.json({ success: false, error: 'MAC not found in NEXhome' });
    const communityId = macEntry.usedCommunityId || macEntry.communityId;
    const deviceData = await getDeviceByMac(auth, cleanMac, communityId);
    const deviceList = deviceData?.result?.elements || deviceData?.result?.list || [];
    const deviceEntry = deviceList[0];
    if (!deviceEntry) return res.json({ success: false, error: 'Device not found' });
    const headers = {
      Authorization: auth.token, AppId: APP_ID, Version: '1.0', Apiversion: '1.0',
      Language: 'en', 'Community-Id': communityId, 'Customer-Id': auth.customerId,
      EmployeeAccountId: auth.employeeAccountId, RequestId: crypto.randomUUID(),
      'User-Agent': 'Mozilla/5.0', Accept: 'application/json',
      'Content-Type': 'application/json; charset=UTF-8',
    };
    await axios.post(`${NEXHOME_BASE}/api/employees/publics/devices/${deviceEntry.id}:reboot`, {}, { headers, timeout: 15000 });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});






// Update account type (installer / committee)
app.post('/api/manager/installers/:phoneNumber/account-type', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { accountType } = req.body;
    if (!['installer', 'committee'].includes(accountType))
      return res.status(400).json({ success: false, error: 'Invalid type' });
    await db.updateAccountType(phoneNumber, accountType);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ==================== MERGE ACCOUNTS ====================
app.post('/api/manager/installers/merge', async (req, res) => {
  try {
    const { primaryPhone, secondaryPhone } = req.body;
    if (!primaryPhone || !secondaryPhone)
      return res.status(400).json({ success: false, error: 'Both phone numbers required' });
    if (primaryPhone === secondaryPhone)
      return res.status(400).json({ success: false, error: 'Cannot merge same account' });
    const result = await db.mergeInstallers(primaryPhone, secondaryPhone);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update installer name / voipbell account
app.post('/api/manager/installers/:phoneNumber/info', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { installerName, voipbellAccount } = req.body;
    await db.updateInstallerInfo(phoneNumber, { installerName, voipbellAccount });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== RELAY TOGGLE (Always On) ====================
const http = require('http');
const { exec } = require('child_process');

function curlPost(host, port, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    // Escape single quotes in body for shell safety
    const safeBody = bodyStr.replace(/'/g, "'\''");
    const url = `http://${host}:${port}${path}`;
    const cmd = [
      'curl', '-s', '--max-time', '12',
      '-X', 'POST',
      '-H', `'Accept: application/json, text/plain, */*'`,
      '-H', `'Content-Type: application/json;charset=UTF-8'`,
      '-H', `'Origin: http://${host}:${port}'`,
      '-H', `'Referer: http://${host}:${port}/'`,
      '-H', `'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'`,
      '-H', `'Connection: keep-alive'`,
      `--data '${safeBody}'`,
      `'${url}'`
    ].join(' ');

    exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(error.message || stderr));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch(e) {
        resolve({ status: 'OK' }); // panel may return non-JSON on success
      }
    });
  });
}

function panelHttpGet(host, port, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port: port,
      path: path,
      method: 'GET',
      agent: new http.Agent({ keepAlive: false }),
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Host': `${host}:${port}`,
        'Referer': `http://${host}:${port}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Connection': 'keep-alive',
      },
    };
    const req = http.request(options, (panelRes) => {
      let data = '';
      panelRes.on('data', chunk => data += chunk);
      panelRes.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON: ' + data.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function panelHttpPost(host, port, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    const options = {
      hostname: host,
      port: port,
      path: path,
      method: 'POST',
      agent: new http.Agent({ keepAlive: false }),
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': bodyBuf.length,
        'Host': `${host}:${port}`,
        'Origin': `http://${host}:${port}`,
        'Referer': `http://${host}:${port}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Connection': 'keep-alive',
      },
    };
    const req = http.request(options, (panelRes) => {
      // Handle gzip if needed
      let chunks = [];
      panelRes.on('data', chunk => chunks.push(chunk));
      panelRes.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ status: 'OK' }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('timeout')); });
    req.write(bodyBuf);
    req.end();
  });
}

app.post('/api/installer/relay-toggle', async (req, res) => {
  const { panelAddress } = req.body;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });

  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    // Step 1: Login first (browser always does this — warms up the panel connection)
    try {
      await panelHttpPost(host, port, '/api/v1/accounts/tokens',
        { username: 'admin', password: '123456' });
    } catch(loginErr) {
      console.log('Panel login failed (continuing anyway):', loginErr.message);
    }

    // Step 2: GET current relay config
    const getData = await panelHttpGet(host, port, '/api/v1/configurations/relayfunction/relay1');
    const relayData = getData?.data;
    if (!relayData) return res.json({ success: false, error: `Could not read relay config. Raw: ${JSON.stringify(getData).slice(0,200)}` });

    const relayList = relayData.relay_list || [];
    const relay1    = relayList.find(r => r.relay_id === 'relay1');
    if (!relay1) return res.json({ success: false, error: 'relay1 not found' });

    const currentMode = relay1.relay_mode;
    const newMode     = currentMode === 'alwayson' ? 'normal' : 'alwayson';

    // Step 3: POST full relay config (all relays) to /relayfunction via curl
    const updatedRelayList = relayList.map(r =>
      r.relay_id === 'relay1' ? { ...r, relay_mode: newMode } : r
    );
    const postBody = { relay_count: relayData.relay_count, relay_list: updatedRelayList };

    const postData = await curlPost(host, port, '/api/v1/configurations/relayfunction', postBody);
    if (postData?.status && postData.status !== 'OK') {
      return res.json({ success: false, error: `Panel rejected: ${postData.status}` });
    }

    res.json({ success: true, previousMode: currentMode, newMode });
  } catch (err) {
    console.error('Relay toggle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/installer/relay-status', async (req, res) => {
  const { panelAddress } = req.query;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;
    const getData = await panelHttpGet(host, port, '/api/v1/configurations/relayfunction/relay1');
    const relay1 = (getData?.data?.relay_list || []).find(r => r.relay_id === 'relay1');
    res.json({ success: true, mode: relay1?.relay_mode || 'unknown' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== CATALOG ====================
app.get('/api/catalog', async (req, res) => {
  try {
    const url = await db.getCatalogUrl();
    res.json({ success: true, url });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/manager/catalog', async (req, res) => {
  try {
    const { url } = req.body;
    await db.setCatalogUrl(url || null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

// ==================== MAILING LIST ====================
app.get('/api/manager/mailing-list', async (req, res) => {
  try {
    const list = await db.getMailingList();
    res.json({ success: true, list });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/mailing-list/subscribe', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, error: 'שם ומייל חובה' });
    const result = await db.subscribeToMailingList(name, email);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/manager/mailing-list/:email', async (req, res) => {
  try {
    await db.removeFromMailingList(decodeURIComponent(req.params.email));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});



// ==================== PORTFOLIO ====================
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Upload image (installer)
app.post('/api/installer/portfolio/upload', upload.single('image'), async (req, res) => {
  try {
    const { phoneNumber, description } = req.body;
    if (!phoneNumber || !req.file) return res.status(400).json({ success: false, error: 'Missing data' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: `tador/portfolios/${phoneNumber}`,
          resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto', width: 1200, crop: 'limit' }]
        },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });

    const image = await db.addPortfolioImage(phoneNumber, result.secure_url, result.public_id, description || '');
    res.json({ success: true, image });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get portfolio (installer sees own, manager sees by phoneNumber param)
app.get('/api/installer/portfolio', async (req, res) => {
  try {
    const { phoneNumber } = req.query;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'phoneNumber required' });
    const images = await db.getPortfolio(phoneNumber);
    res.json({ success: true, images });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete image (installer only — must own the image)
app.delete('/api/installer/portfolio/:imageId', async (req, res) => {
  try {
    const { phoneNumber, publicId } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'phoneNumber required' });
    // Delete from Cloudinary
    if (publicId) {
      try { await cloudinary.uploader.destroy(publicId); } catch(e) { /* ignore */ }
    }
    await db.deletePortfolioImage(phoneNumber, req.params.imageId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manager: get any installer's portfolio
app.get('/api/manager/installers/:phoneNumber/portfolio', async (req, res) => {
  try {
    const images = await db.getPortfolio(req.params.phoneNumber);
    res.json({ success: true, images });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== TUTORIALS ====================
app.get('/api/tutorials', async (req, res) => {
  try {
    const tutorials = await db.getTutorials();
    res.json({ success: true, tutorials });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/manager/tutorials', async (req, res) => {
  try {
    const { tutorials } = req.body;
    if (!Array.isArray(tutorials)) return res.status(400).json({ success: false, error: 'tutorials must be array' });
    await db.saveTutorials(tutorials);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});


// ==================== MANAGER FILE STORAGE (XLSX) ====================
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) allowed'));
    }
  }
});

// Upload Excel file (manager only)
app.post('/api/manager/files/upload', xlsxUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: 'tador/manager-files',
          resource_type: 'raw',
          public_id: `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
          use_filename: false,
        },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });

    await db.addManagerFile({
      name: req.file.originalname,
      url: result.secure_url,
      publicId: result.public_id,
      size: req.file.size,
      uploadedAt: new Date(),
    });

    res.json({ success: true, file: { name: req.file.originalname, url: result.secure_url, publicId: result.public_id } });
  } catch (err) {
    console.error('File upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all manager files
app.get('/api/manager/files', async (req, res) => {
  try {
    const files = await db.getManagerFiles();
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Update file title
app.post('/api/manager/files/title', async (req, res) => {
  try {
    const { publicId, title } = req.body;
    if (!publicId) return res.status(400).json({ success: false, error: 'publicId required' });
    await db.updateManagerFileTitle(publicId, title);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a manager file
app.delete('/api/manager/files/:publicId(*)', async (req, res) => {
  try {
    const publicId = req.params.publicId;
    try { await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' }); } catch(e) {}
    await db.deleteManagerFile(publicId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ==================== STATS ====================
app.get('/api/stats', async (req, res) => {
  try {
    const installers = await db.getAllInstallersWithMacs();
    const adminUser = process.env.ADMIN_USER || 'admin';
    const filtered = installers.filter(i => i.phoneNumber !== adminUser);

    // Deduplicate MACs globally across all installers
    const seenMacs = new Set();
    const now = new Date();
    const oneYearMs  = 365 * 24 * 60 * 60 * 1000;
    const twoYearsMs = 2 * oneYearMs;

    const alerts1Year  = []; // passed 1 year, not paid
    const alerts2Years = []; // passed 2 years, not paid

    const installerList = filtered.map(inst => {
      const uniqueMacs = [];
      for (const m of (inst.macAddresses || [])) {
        if (!m.mac || seenMacs.has(m.mac)) continue;
        seenMacs.add(m.mac);
        uniqueMacs.push(m);

        // Check overdue licenses
        if (!m.licensePaid && m.startDate) {
          const start = new Date(m.startDate);
          if (!isNaN(start)) {
            const elapsed = now - start;
            if (elapsed >= twoYearsMs) {
              alerts2Years.push({
                installerName: inst.installerName || inst.phoneNumber,
                phoneNumber: inst.phoneNumber,
                mac: m.mac,
                address: m.address || '',
                city: m.city || '',
                committeeName: m.committeeName || '',
                startDate: m.startDate,
                yearsElapsed: (elapsed / oneYearMs).toFixed(1),
              });
            } else if (elapsed >= oneYearMs) {
              alerts1Year.push({
                installerName: inst.installerName || inst.phoneNumber,
                phoneNumber: inst.phoneNumber,
                mac: m.mac,
                address: m.address || '',
                city: m.city || '',
                committeeName: m.committeeName || '',
                startDate: m.startDate,
                yearsElapsed: (elapsed / oneYearMs).toFixed(1),
              });
            }
          }
        }
      }
      return {
        phoneNumber: inst.phoneNumber,
        installerName: inst.installerName || '',
        accountType: inst.accountType || 'installer',
        createdAt: inst.createdAt,
        lastLogin: inst.lastLogin,
        macAddresses: uniqueMacs.map(m => ({
          mac: m.mac,
          address: m.address || '',
          city: m.city || '',
          panelType: m.panelType || 'genesis7',
          licensePaid: m.licensePaid || false,
          annualFee: m.annualFee || '',
          committeeName: m.committeeName || '',
          startDate: m.startDate || '',
        }))
      };
    });

    const allUniqueMacs = [...seenMacs];
    const totalMacs        = allUniqueMacs.length;
    const totalInstallers  = filtered.filter(i => (i.accountType || 'installer') === 'installer').length;
    const totalLicensesPaid = installerList.reduce((sum, i) =>
      sum + i.macAddresses.filter(m => m.licensePaid).length, 0);
    const genesis7Count = installerList.reduce((sum, i) =>
      sum + i.macAddresses.filter(m => (m.panelType || 'genesis7') === 'genesis7').length, 0);
    const genesis5Count = installerList.reduce((sum, i) =>
      sum + i.macAddresses.filter(m => m.panelType === 'genesis5').length, 0);

    res.json({
      success: true,
      summary: { totalInstallers, totalMacs, totalLicensesPaid, genesis7Count, genesis5Count },
      installers: installerList,
      alerts: { oneYear: alerts1Year, twoYears: alerts2Years },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ GenesisTracer Server Running');
  console.log(`🌐 Main: http://localhost:${PORT}`);
  console.log(`👨‍💼 Manager: http://localhost:${PORT}/manager.html`);
  console.log(`🔧 Installer: http://localhost:${PORT}/installer.html`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (process.env.RESTRICT_TO_ISRAEL === 'true') {
    console.log('🔒 IP Restriction: Israel only');
  }
  console.log('Powered by Tador Technologies LTD');
  loadSchedules();

  // Keep-alive: ping עצמי כל 10 דקות כדי למנוע שינה ב-Render Free
  const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await axios.get(`${APP_URL}/api/ping`, { timeout: 10000 });
      console.log('💓 Keep-alive ping sent');
    } catch (err) {
      // שקט — לא קריטי
    }
  }, 10 * 60 * 1000); // כל 10 דקות
});
