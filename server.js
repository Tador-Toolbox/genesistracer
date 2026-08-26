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
const APP_ID = 'INTERNATIONAL_COMMUNITY_MANAGER_WEB';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// -------------------- NexHome account pool (round-robin) --------------------
const NEXHOME_ACCOUNTS = [
  {
    username: process.env.NEXHOME_USERNAME_1 || 'ort_tadorcom',
    password: process.env.NEXHOME_PASSWORD_1 || '5uWRg8sR',
    token: null,
    employeeAccountId: null,
    customerId: null,
    engineeringId: null,
    expiresAt: 0,
  },
  {
    username: process.env.NEXHOME_USERNAME_2 || 'mobile_tadorcom',
    password: process.env.NEXHOME_PASSWORD_2 || 'Zv4QM88EC',
    token: null,
    employeeAccountId: null,
    customerId: null,
    engineeringId: null,
    expiresAt: 0,
  },
  {
    username: process.env.NEXHOME_USERNAME_3 || 'sales_tadorcom',
    password: process.env.NEXHOME_PASSWORD_3 || '',
    token: null,
    employeeAccountId: null,
    customerId: null,
    engineeringId: null,
    expiresAt: 0,
  },
];

let roundRobinIndex = 0;
let requestCounter = 0;

function logAccountStatus() {
  const now = Date.now();
  NEXHOME_ACCOUNTS.forEach((a, i) => {
    const valid = a.token && now < a.expiresAt;
    const expiresIn = valid ? Math.round((a.expiresAt - now) / 1000) + 's' : 'expired';
    console.log(`   📋 Account[${i}] ${a.username} — ${valid ? `✅ valid (expires in ${expiresIn})` : '❌ no valid token'}`);
  });
}

async function loginAccount(account) {
  const candidates = [md5(account.password), account.password];

  for (const pass of candidates) {
    try {
      const res = await axios.post(
        `${NEXHOME_BASE}/api/employees/account/login`,
        { loginName: account.username, password: pass },
        {
          headers: {
            'Content-Type': 'application/json',
            AppId: APP_ID,
            Referer: NEXHOME_BASE + '/login',
            Origin: NEXHOME_BASE,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
          },
          timeout: 15000,
        }
      );

      const token = res.data?.result?.tokenInfo?.token;
      if (token) {
        account.token = token;
        account.employeeAccountId = res.data?.result?.employeeInfo?.accountId;
        account.customerId = res.data?.result?.employeeInfo?.customerId;
        account.engineeringId = res.data?.result?.employeeInfo?.engineeringId;
        account.expiresAt = Date.now() + 8 * 60 * 1000;
        console.log(`✅ NexHome login success: ${account.username} (token valid 8 min)`);
        return true;
      }
    } catch (err) {
      console.log(`❌ NexHome login failed for ${account.username}: ${err.message}`);
    }
  }
  return false;
}

async function getAuthToken(requestLabel = 'unknown') {
  const reqId = ++requestCounter;
  const accountIndex = roundRobinIndex % NEXHOME_ACCOUNTS.length;
  const account = NEXHOME_ACCOUNTS[accountIndex];
  roundRobinIndex++;

  if (account.token && Date.now() < account.expiresAt) {
    console.log(`🔄 [req#${reqId}] ${requestLabel} → account[${accountIndex}] ${account.username} (cached token)`);
    return account;
  }

  console.log(`🔑 [req#${reqId}] ${requestLabel} → account[${accountIndex}] ${account.username} token expired, re-logging in...`);
  const success = await loginAccount(account);
  if (success) {
    console.log(`✅ [req#${reqId}] ${requestLabel} → account[${accountIndex}] ${account.username} ready`);
    return account;
  }

  const fallbackIndex = NEXHOME_ACCOUNTS.findIndex(a => a !== account);
  const fallback = NEXHOME_ACCOUNTS[fallbackIndex];
  console.log(`⚠️ [req#${reqId}] ${requestLabel} → account[${accountIndex}] failed, trying fallback account[${fallbackIndex}] ${fallback.username}`);

  if (fallback.token && Date.now() < fallback.expiresAt) {
    console.log(`✅ [req#${reqId}] ${requestLabel} → fallback account[${fallbackIndex}] ${fallback.username} (cached token)`);
    return fallback;
  }

  const fallbackSuccess = await loginAccount(fallback);
  if (fallbackSuccess) {
    console.log(`✅ [req#${reqId}] ${requestLabel} → fallback account[${fallbackIndex}] ${fallback.username} ready`);
    return fallback;
  }

  throw new Error(`[req#${reqId}] All NexHome accounts failed for: ${requestLabel}`);
}

// Pre-login both accounts at startup for zero-delay on first request
async function initNexHomeAccounts() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 Initializing NexHome account pool...');
  for (const account of NEXHOME_ACCOUNTS) {
    await loginAccount(account);
  }
  console.log('📊 Account pool status after init:');
  logAccountStatus();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ==================== ACTIVITY LOG ====================
async function logActivity({ phoneNumber, action, mac, details = {}, success = true }) {
  try {
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('activity_logs');
    await col.insertOne({
      phoneNumber,
      action,        // 'door_open' | 'reboot' | 'temp_code' | 'relay_toggle' | 'lookup'
      mac: mac || null,
      details,       // extra info: pin, days, mode, error etc.
      success,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('⚠️ Failed to log activity:', err.message);
  }
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
    const auth = await getAuthToken('lookup');
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

    const lookupResult = {
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
    };
    await logActivity({
      phoneNumber: req.body.installerPhone || 'unknown',
      action: 'lookup',
      mac: cleanMac,
      details: { status: lookupResult.status, project: lookupResult.project, ip: lookupResult.fullAddress },
      success: true,
    });
    return res.json(lookupResult);
  } catch (err) {
    console.error('Lookup error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Debug endpoint
app.get('/api/debug/:mac', async (req, res) => {
  try {
    const auth = await getAuthToken('debug');
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
  if (result.success) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    await logActivity({ phoneNumber: username, action: 'login', mac: null, details: { ip, role: 'manager' }, success: true });
  }
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
    // NOTE: no '' defaults here on purpose — a missing field must stay `undefined`
    // so db.assignMacToInstaller keeps the value already stored (merge, not replace).
    const {
      macAddress,
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
      voipbellAccount,
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
    const updateCount = await db.getUnreadResidentUpdateCount();
    res.json({ success: true, counts, updateCount });
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
    const { from, text, type } = req.body;
    console.log(`💬 Chat POST: phone=${req.params.phoneNumber} from=${from} text=${text}`);
    if (!text || !from) return res.status(400).json({ success: false, error: 'missing fields' });
    const msg = await db.sendChatMessage(req.params.phoneNumber, from, text, type);
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
    const auth = await getAuthToken('manager-reboot');

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
      await logActivity({ phoneNumber: 'manager', action: 'reboot', mac: cleanMac, details: { source: 'manager' }, success: true });
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
      const auth = await getAuthToken('auto-reboot:' + mac);
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
  const { phoneNumber, password, isManagerAccess } = req.body;
  const result = await db.loginInstaller(phoneNumber, password, isManagerAccess === true);
  if (result.success) {
    result.data.ip = req.ip;
    await logActivity({ phoneNumber, action: 'login', mac: null, details: { ip: req.ip, isManagerAccess: !!isManagerAccess }, success: true });
  }
  res.json(result);
});

// ==================== INSTALLER REBOOT ====================
app.post('/api/installer/reboot', async (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ success: false, error: 'MAC required' });
  const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();
  try {
    const auth = await getAuthToken('installer-reboot');
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
    await logActivity({ phoneNumber: req.body.installerPhone || 'unknown', action: 'reboot', mac: cleanMac, details: { source: 'installer' }, success: true });
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

// Helper: make panel HTTP request with shared agent
function panelReq(agent, host, port, method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const panelOrigin = `http://${host}:${port}`;
    const bodyStr = body ? JSON.stringify(body) : null;
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const options = {
      hostname: host, port, path, method,
      agent,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Connection': 'keep-alive',
        'Origin': panelOrigin,
        'Referer': `${panelOrigin}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
        ...extraHeaders,
      },
    };
    const req = http.request(options, (panelRes) => {
      let chunks = [];
      panelRes.on('data', chunk => chunks.push(chunk));
      panelRes.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data, status: 'OK' }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Helper: relay POST via curl with body in temp file (bypasses Node HTTP issues with NexHome tunnel)
function relayPostViaCurl(host, port, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const os = require('os');
    const tmpFile = require('path').join(os.tmpdir(), `relay_${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(body));

    const panelOrigin = `http://${host}:${port}`;
    const headerArgs = [
      `-H "Accept: application/json, text/plain, */*"`,
      `-H "Accept-Encoding: gzip, deflate"`,
      `-H "Accept-Language: he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7"`,
      `-H "Content-Type: application/json;charset=UTF-8"`,
      `-H "Connection: keep-alive"`,
      `-H "Origin: ${panelOrigin}"`,
      `-H "Referer: ${panelOrigin}/"`,
      `-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"`,
    ];
    if (extraHeaders.Authorization) {
      headerArgs.push(`-H "Authorization: ${extraHeaders.Authorization}"`);
    }

    const cmd = `curl -s --max-time 15 -X POST ${headerArgs.join(' ')} --data @${tmpFile} "http://${host}:${port}${path}"`;
    console.log(`🌀 curl relay POST to ${host}:${port}${path}`);

    require('child_process').exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      fs.unlink(tmpFile, () => {});
      if (err) { reject(new Error(err.message || stderr)); return; }
      try { resolve(JSON.parse(stdout)); } catch(e) { resolve({ status: 'OK', raw: stdout }); }
    });
  });
}

app.post('/api/installer/relay-toggle', async (req, res) => {
  const { panelAddress, relayList: clientRelayList, relayCount: clientRelayCount } = req.body;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });

  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;
    console.log(`🔄 relay-toggle START host=${host} port=${port} hasCache=${!!(clientRelayList?.length)}`);

    // Shared keepAlive agent — all requests reuse the same TCP connection
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    // Step 1: Login with shared agent
    let token = null;
    try {
      console.log('🔑 Logging in to panel...');
      const loginRes = await panelReq(agent, host, port, 'POST', '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
      console.log(`🔑 Login result: ${token ? 'got token ✅' : 'no token'}`);
    } catch(loginErr) {
      console.log('🔑 Login failed (continuing):', loginErr.message);
    }

    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    // Step 2: Get relay config (use cache if available)
    let relayList, relayCount;
    if (clientRelayList && clientRelayList.length > 0) {
      relayList = clientRelayList;
      relayCount = clientRelayCount || clientRelayList.length;
      console.log(`📋 Using cached relay config (${relayList.length} relays) — skipping GET`);
    } else {
      console.log('📡 Fetching relay config...');
      const getData = await panelReq(agent, host, port, 'GET', '/api/v1/configurations/relayfunction/relay1', null, authHeaders);
      const relayData = getData?.data;
      if (!relayData) return res.json({ success: false, error: `Could not read relay config` });
      relayList = relayData.relay_list || [];
      relayCount = relayData.relay_count;
    }

    const relay1 = relayList.find(r => r.relay_id === 'relay1');
    if (!relay1) return res.json({ success: false, error: 'relay1 not found' });

    const currentMode = relay1.relay_mode;
    const newMode     = currentMode === 'alwayson' ? 'normal' : 'alwayson';

    const updatedRelayList = relayList.map(r =>
      r.relay_id === 'relay1' ? { ...r, relay_mode: newMode } : r
    );
    const postBody = { relay_count: relayCount, relay_list: updatedRelayList, relay_changed_pub: 'disable' };

    // Small delay after login before POST
    await new Promise(resolve => setTimeout(resolve, 300));

    // Do NOT send Authorization header with relay POST — NexHome tunnel intercepts and rejects panel JWT
    // Browser succeeds without it — tunnel handles session auth internally
    console.log(`📤 POSTing relay via curl: ${currentMode} → ${newMode}, ${updatedRelayList.length} relays (no auth header)`);
    const postData = await relayPostViaCurl(host, port, '/api/v1/configurations/relayfunction', postBody, {});
    console.log(`📥 POST result:`, JSON.stringify(postData).slice(0, 200));

    if (postData?.status && postData.status !== 'OK') {
      return res.json({ success: false, error: `Panel rejected: ${postData.status}` });
    }

    agent.destroy();
    await logActivity({ phoneNumber: req.body.installerPhone || 'unknown', action: 'relay_toggle', mac: req.body.mac || null, details: { previousMode: currentMode, newMode }, success: true });
    res.json({ success: true, previousMode: currentMode, newMode });
  } catch (err) {
    console.error('Relay toggle error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/installer/relay-status', async (req, res) => {
  const { panelAddress, installerPhone } = req.query;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;
    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    const getData = await panelHttpGetWithHeaders(host, port, '/api/v1/configurations/relayfunction/relay1', authHeaders);
    const relayData = getData?.data;
    const relay1 = (relayData?.relay_list || []).find(r => r.relay_id === 'relay1');
    // Return full config so toggle can skip the GET step
    if (installerPhone) {
      await logActivity({ phoneNumber: installerPhone, action: 'relay_status', mac: panelAddress?.split(':')[0] || null, details: { mode: relay1?.relay_mode }, success: true });
    }
    res.json({
      success: true,
      mode: relay1?.relay_mode || 'unknown',
      relayCount: relayData?.relay_count,
      relayList: relayData?.relay_list || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== MAC MAINTENANCE (browser-run tools) ====================
// Same MAC can live on several accounts, each with its OWN copy of the details.
// These two routes replace the standalone maintenance scripts so they can be run
// from the browser against the live deployment.

const MAC_DETAIL_FIELDS = [
  'address', 'city', 'notes', 'purchaseDate', 'startDate',
  'technicianName', 'technicianPhone', 'supplierName',
  'committeeName', 'committeePhone', 'description',
  'annualFee', 'licensesPurchased', 'panelType', 'voipbellAccount',
];

const macFieldEmpty = v => v === undefined || v === null || String(v).trim() === '';
const macRichness = m => MAC_DETAIL_FIELDS.filter(f => !macFieldEmpty(m[f])).length;

// READ-ONLY: list MACs that are clearly in use but have no description
app.get('/api/manager/audit-macs', async (req, res) => {
  try {
    const database = await require('./db').connectDB();
    const adminUser = process.env.ADMIN_USER || 'admin';
    const all = await database.collection('installers')
      .find({ phoneNumber: { $ne: adminUser } }).sort({ createdAt: 1 }).toArray();

    const contentFields = MAC_DETAIL_FIELDS.filter(f => f !== 'description' && f !== 'panelType');
    const missing = [];
    let totalMacs = 0, withDescription = 0;

    for (const inst of all) {
      for (const m of (inst.macAddresses || [])) {
        totalMacs++;
        if (!macFieldEmpty(m.description)) { withDescription++; continue; }
        const filled = contentFields.filter(f => !macFieldEmpty(m[f]));
        if (filled.length >= 2) {
          missing.push({
            phoneNumber: inst.phoneNumber,
            name: inst.installerName || '',
            accountType: inst.accountType || 'installer',
            mac: m.mac,
            address: m.address || '',
            city: m.city || '',
            notes: m.notes || '',
          });
        }
      }
    }

    res.json({
      success: true,
      summary: { accounts: all.length, totalMacs, withDescription, missingDescription: missing.length },
      missing,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fill EMPTY fields on a MAC copy from the richest copy of the same MAC on another
// account. Never overwrites a field that has content, never deletes.
// Dry run by default — add &apply=1 to actually write.
app.get('/api/manager/sync-mac-details', async (req, res) => {
  try {
    const { username, password, apply, phone } = req.query;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const doWrite = apply === '1' || apply === 'true';

    const database = await require('./db').connectDB();
    const col = database.collection('installers');
    const adminUser = process.env.ADMIN_USER || 'admin';
    const all = await col.find({ phoneNumber: { $ne: adminUser } }).toArray();

    // Best-known copy of each MAC across all accounts
    const best = new Map();
    for (const inst of all) {
      for (const m of (inst.macAddresses || [])) {
        if (!m.mac) continue;
        const cur = best.get(m.mac);
        if (!cur || macRichness(m) > macRichness(cur.entry)) {
          best.set(m.mac, { entry: m, phoneNumber: inst.phoneNumber });
        }
      }
    }

    const plan = [];
    let fieldsFilled = 0, accountsChanged = 0;

    for (const inst of all) {
      if (phone && inst.phoneNumber !== phone) continue;
      const macs = inst.macAddresses || [];
      let changed = false;

      for (const m of macs) {
        const src = best.get(m.mac);
        if (!src || src.phoneNumber === inst.phoneNumber) continue;

        const filled = {};
        for (const f of MAC_DETAIL_FIELDS) {
          if (macFieldEmpty(m[f]) && !macFieldEmpty(src.entry[f])) {
            filled[f] = src.entry[f];
            if (doWrite) m[f] = src.entry[f];
            fieldsFilled++;
          }
        }
        if (Object.keys(filled).length) {
          changed = true;
          plan.push({ account: inst.phoneNumber, name: inst.installerName || '', mac: m.mac, from: src.phoneNumber, fields: filled });
        }
      }

      if (changed) {
        accountsChanged++;
        if (doWrite) {
          await db.snapshotMacs(inst.phoneNumber, macs, 'sync-mac-details');
          await col.updateOne({ phoneNumber: inst.phoneNumber }, { $set: { macAddresses: macs } });
        }
      }
    }

    console.log(`🔗 sync-mac-details (${doWrite ? 'APPLIED' : 'dry run'}): ${accountsChanged} accounts, ${plan.length} MACs, ${fieldsFilled} fields`);
    res.json({
      success: true,
      applied: doWrite,
      summary: { accountsChanged, macsChanged: plan.length, fieldsFilled },
      plan,
      hint: doWrite ? 'Changes written. Previous state saved in mac_history.' : 'Dry run only — add &apply=1 to write.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== MAC HISTORY (safety net) ====================
// Every write to macAddresses is snapshotted first. These routes let the manager
// see the previous versions and roll back if something got wiped.

app.get('/api/manager/mac-history/:phoneNumber', async (req, res) => {
  try {
    const history = await db.getMacHistory(req.params.phoneNumber, 30);
    res.json({
      success: true,
      history: history.map(h => ({
        id: h._id,
        at: h.at,
        reason: h.reason,
        macCount: (h.macAddresses || []).length,
        macAddresses: h.macAddresses,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/manager/mac-history/:phoneNumber/restore', async (req, res) => {
  try {
    const { username, password, snapshotId } = req.body;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!snapshotId) return res.status(400).json({ success: false, error: 'snapshotId required' });

    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    const snap = await database.collection('mac_history').findOne({ _id: new ObjectId(snapshotId) });
    if (!snap) return res.json({ success: false, error: 'Snapshot not found' });
    if (snap.phoneNumber !== req.params.phoneNumber) {
      return res.json({ success: false, error: 'Snapshot belongs to a different account' });
    }

    // Snapshot the CURRENT state before rolling back, so a restore is itself undoable
    const current = await database.collection('installers').findOne({ phoneNumber: req.params.phoneNumber });
    await db.snapshotMacs(req.params.phoneNumber, current?.macAddresses || [], 'before-restore');

    await database.collection('installers').updateOne(
      { phoneNumber: req.params.phoneNumber },
      { $set: { macAddresses: snap.macAddresses } }
    );

    console.log(`♻️ MAC restore: ${req.params.phoneNumber} ← snapshot ${snapshotId} (${snap.at})`);
    res.json({ success: true, restored: (snap.macAddresses || []).length, at: snap.at });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== PANEL HISTORY (unlock records) ====================
app.post('/api/installer/panel-history', async (req, res) => {
  const { panelAddress, pageNum = 1, pageSize = 20, installerPhone } = req.body;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    const data = await panelHttpGetWithHeaders(host, port,
      `/api/v1/records/unlock?page_num=${parseInt(pageNum)}&page_size=${parseInt(pageSize)}&type=&label=`,
      { Authorization: 'Bearer ' + token });

    const list = (data?.data?.list || []).map(r => ({
      id: r.id,
      name: (r.access_label || '').trim(),
      type: r.access_type,        // face | card | password
      door: r.relay || '',        // '1' / ''
      time: r.unlock_time,        // ms timestamp
      status: r.status,           // success | failure
      content: r.access_content || '',
    }));

    if (parseInt(pageNum) === 1 && installerPhone) {
      await logActivity({ phoneNumber: installerPhone, action: 'panel_history', mac: panelAddress, details: { total: data?.data?.total }, success: true });
    }

    res.json({ success: true, records: list, total: data?.data?.total || 0, pageNum: parseInt(pageNum) });
  } catch (err) {
    console.error('Panel history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Search panel history for a specific day (panel API has no date filter — we page until past the day)
app.post('/api/installer/panel-history-date', async (req, res) => {
  const { panelAddress, date, installerPhone } = req.body; // date = 'YYYY-MM-DD' (Israel local day)
  if (!panelAddress || !date) return res.status(400).json({ success: false, error: 'panelAddress and date required' });
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    // Israel-day boundaries in UTC ms (DST-aware, same logic as temp-code)
    const [y, m, d] = date.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d, 12));
    const year = probe.getUTCFullYear();
    const marchEnd = new Date(Date.UTC(year, 2, 31));
    while (marchEnd.getUTCDay() !== 5) marchEnd.setUTCDate(marchEnd.getUTCDate() - 1);
    const octEnd = new Date(Date.UTC(year, 9, 31));
    while (octEnd.getUTCDay() !== 0) octEnd.setUTCDate(octEnd.getUTCDate() - 1);
    const offsetHours = (probe >= marchEnd && probe < octEnd) ? 3 : 2;
    const dayStart = Date.UTC(y, m - 1, d) - offsetHours * 3600000;
    const dayEnd = dayStart + 86400000;

    const matches = [];
    let pageNum = 1;
    const pageSize = 100;
    while (pageNum <= 30) { // safety cap: 3,000 records
      const data = await panelHttpGetWithHeaders(host, port,
        `/api/v1/records/unlock?page_num=${pageNum}&page_size=${pageSize}&type=&label=`,
        { Authorization: 'Bearer ' + token });
      const list = data?.data?.list || [];
      if (!list.length) break;

      for (const r of list) {
        if (r.unlock_time >= dayStart && r.unlock_time < dayEnd) {
          matches.push({
            id: r.id,
            name: (r.access_label || '').trim(),
            type: r.access_type,
            door: r.relay || '',
            time: r.unlock_time,
            status: r.status,
            content: r.access_content || '',
          });
        }
      }

      // Records are newest-first: if the oldest record on this page is before dayStart, stop
      const oldest = list[list.length - 1]?.unlock_time || 0;
      if (oldest < dayStart) break;
      if (list.length < pageSize) break;
      pageNum++;
    }

    await logActivity({ phoneNumber: installerPhone || 'unknown', action: 'panel_history', mac: panelAddress, details: { date, found: matches.length }, success: true });
    res.json({ success: true, records: matches, total: matches.length, date });
  } catch (err) {
    console.error('Panel history date error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== BLOCK USER (temporarily remove a face from the panel) ====================
// Flow: search face by name on the panel → save its photo to Cloudinary → delete from panel.
// Unblock: re-upload the saved photo back to the panel and remove the block record.

// Search faces on the panel by name (for the block picker)
app.post('/api/installer/block-user/search', async (req, res) => {
  const { panelAddress, name } = req.body;
  if (!panelAddress || !name) return res.status(400).json({ success: false, error: 'panelAddress and name required' });
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    const all = await getAllPanelFaces(host, port, token);
    const q = name.trim().toLowerCase();
    const matches = all
      .filter(f => (f.label || '').toLowerCase().includes(q))
      .map(f => ({
        id: f.id,
        name: f.label || '',
        photoUrl: `http://${host}:${port}/api/v1/access/image/${f.id}.jpg?id=${f.id}`,
      }));

    res.json({ success: true, matches, total: matches.length });
  } catch (err) {
    console.error('block-user search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Block a specific face: save photo to Cloudinary, then delete from panel
app.post('/api/installer/block-user', async (req, res) => {
  const { panelAddress, faceId, name, installerPhone, mac } = req.body;
  if (!panelAddress || !faceId) return res.status(400).json({ success: false, error: 'panelAddress and faceId required' });
  const macKey = (mac || '').replace(/[:\-\s]/g, '').toUpperCase();
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    // 1) Download the face image from the panel to a temp file
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const tmpImg = path.join(os.tmpdir(), `block_${Date.now()}.jpg`);
    const imgUrl = `http://${host}:${port}/api/v1/access/image/${faceId}.jpg?id=${faceId}`;
    const dlCmd = `curl -s --max-time 20 -H "Authorization: Bearer ${token}" "${imgUrl}" -o "${tmpImg}"`;
    await new Promise((resolve, reject) => {
      exec(dlCmd, { maxBuffer: 8 * 1024 * 1024 }, (err) => err ? reject(new Error('image download failed')) : resolve());
    });
    if (!fs.existsSync(tmpImg) || fs.statSync(tmpImg).size < 500) {
      try { fs.unlinkSync(tmpImg); } catch(e) {}
      return res.json({ success: false, error: 'Could not fetch face image from panel' });
    }

    // 2) Upload that image to Cloudinary (so unblock can restore it later)
    const uploadRes = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'genesistracer-blocked', resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      fs.createReadStream(tmpImg).pipe(stream);
    });
    fs.unlink(tmpImg, () => {});

    // 3) Record the block FIRST — so the info is saved no matter what the panel does
    const database = await require('./db').connectDB();
    const blockDoc = await database.collection('blocked_users').insertOne({
      panelAddress,
      mac: macKey,
      name: name || '',
      photoUrl: uploadRes.secure_url,
      blockedAt: new Date(),
      blockedBy: installerPhone || 'unknown',
      panelDeleteOk: false, // updated below once we confirm the panel removed it
    });
    await database.collection('block_history').insertOne({
      panelAddress, mac: macKey,
      name: name || '', action: 'block', at: new Date(), by: installerPhone || 'unknown',
    });
    await logActivity({ phoneNumber: installerPhone || 'unknown', action: 'block_user', mac: panelAddress, details: { name }, success: true });
    console.log(`🚫 Block recorded: ${name} on ${panelAddress}`);

    // 4) Delete the face from the panel + verify
    let panelDeleteOk = false;
    let panelWarning = null;
    try {
      await deleteFaceFromPanel(host, port, token, faceId);
      const afterDelete = await getAllPanelFaces(host, port, token);
      panelDeleteOk = !afterDelete.some(f => String(f.id) === String(faceId));
      if (!panelDeleteOk) panelWarning = 'הפנים נשמרו ברשימה אך הפנל עדיין לא מחק אותם — נסה שוב או בצע ריסט';
    } catch (delErr) {
      panelWarning = 'הפנים נשמרו ברשימה אך המחיקה מהפנל נכשלה: ' + delErr.message;
      console.error('block delete failed:', delErr.message);
    }
    if (panelDeleteOk) {
      await database.collection('blocked_users').updateOne({ _id: blockDoc.insertedId }, { $set: { panelDeleteOk: true } });
    }

    // Optional: reboot the panel so the recognition engine reloads immediately
    if (req.body.reboot) {
      try {
        const cleanMac = panelAddress.split(':')[0].replace(/[:\-\s]/g, '').toUpperCase();
        const auth = await getAuthToken('block-reboot');
        const macData = await searchMac(auth, cleanMac);
        const macList = macData?.result?.elements || macData?.result?.list || [];
        const macEntry = macList[0];
        if (macEntry) {
          const communityId = macEntry.usedCommunityId || macEntry.communityId;
          const deviceData = await getDeviceByMac(auth, cleanMac, communityId);
          const deviceEntry = (deviceData?.result?.elements || deviceData?.result?.list || [])[0];
          if (deviceEntry) {
            const headers = {
              Authorization: auth.token, AppId: APP_ID, Version: '1.0', Apiversion: '1.0',
              Language: 'en', 'Community-Id': communityId, 'Customer-Id': auth.customerId,
              EmployeeAccountId: auth.employeeAccountId, RequestId: crypto.randomUUID(),
              'User-Agent': 'Mozilla/5.0', Accept: 'application/json',
              'Content-Type': 'application/json; charset=UTF-8',
            };
            await axios.post(`${NEXHOME_BASE}/api/employees/publics/devices/${deviceEntry.id}:reboot`, {}, { headers, timeout: 15000 });
            console.log(`🔄 Panel rebooted after block: ${cleanMac}`);
          }
        }
      } catch (rebootErr) {
        console.error('post-block reboot failed (non-fatal):', rebootErr.message);
      }
    }
    res.json({ success: true, name, panelDeleteOk, warning: panelWarning });
  } catch (err) {
    console.error('block-user error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// List blocked users for a panel
app.get('/api/installer/block-user', async (req, res) => {
  const { panelAddress, mac } = req.query;
  const macKey = (mac || '').replace(/[:\-\s]/g, '').toUpperCase();
  const ip = (panelAddress || '').split(':')[0];
  if (!macKey && !ip) return res.status(400).json({ success: false, error: 'mac or panelAddress required' });
  try {
    const database = await require('./db').connectDB();
    // Match new records (stored by MAC) and legacy records (stored by IP) for the same panel
    const orKeys = [macKey, ip].filter(Boolean);
    const list = await database.collection('blocked_users')
      .find({ mac: { $in: orKeys } }).sort({ blockedAt: -1 }).toArray();
    res.json({
      success: true,
      blocked: list.map(b => ({ id: b._id, name: b.name, photoUrl: b.photoUrl, blockedAt: b.blockedAt, panelDeleteOk: b.panelDeleteOk !== false })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Unblock: re-upload the saved face back to the panel, then remove the block record
app.post('/api/installer/block-user/:blockId/unblock', async (req, res) => {
  const { panelAddress, installerPhone } = req.body;
  const { blockId } = req.params;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });
  try {
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    const rec = await database.collection('blocked_users').findOne({ _id: new ObjectId(blockId) });
    if (!rec) return res.json({ success: false, error: 'Block record not found' });

    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    // Re-upload the saved photo to the panel (reuses the face upload helper)
    await uploadFaceToPanel(host, port, token, rec.name, rec.photoUrl);

    // Remove the block record
    await database.collection('blocked_users').deleteOne({ _id: new ObjectId(blockId) });

    console.log(`✅ Unblocked: ${rec.name} on ${panelAddress}`);
    await database.collection('block_history').insertOne({
      panelAddress, mac: rec.mac || (panelAddress.split(':')[0]),
      name: rec.name || '', action: 'unblock', at: new Date(), by: installerPhone || 'unknown',
    });
    await logActivity({ phoneNumber: installerPhone || 'unknown', action: 'unblock_user', mac: rec.mac || panelAddress, details: { name: rec.name }, success: true });
    res.json({ success: true, name: rec.name });
  } catch (err) {
    console.error('unblock error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a block record entirely (cleanup — does NOT re-upload to panel)
app.delete('/api/installer/block-user/:blockId', async (req, res) => {
  const { blockId } = req.params;
  try {
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    const rec = await database.collection('blocked_users').findOne({ _id: new ObjectId(blockId) });
    if (rec && rec.photoUrl) {
      // best-effort remove the saved photo from Cloudinary
      try {
        const m = rec.photoUrl.match(/genesistracer-blocked\/([^./]+)/);
        if (m) await cloudinary.uploader.destroy('genesistracer-blocked/' + m[1]);
      } catch(e) {}
    }
    await database.collection('blocked_users').deleteOne({ _id: new ObjectId(blockId) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Block/unblock history for a panel (newest first)
app.get('/api/installer/block-history', async (req, res) => {
  const { panelAddress, mac } = req.query;
  const macKey = (mac || '').replace(/[:\-\s]/g, '').toUpperCase();
  const ip = (panelAddress || '').split(':')[0];
  if (!macKey && !ip) return res.status(400).json({ success: false, error: 'mac or panelAddress required' });
  try {
    const database = await require('./db').connectDB();
    const orKeys = [macKey, ip].filter(Boolean);
    const list = await database.collection('block_history')
      .find({ mac: { $in: orKeys } }).sort({ at: -1 }).limit(100).toArray();
    res.json({
      success: true,
      history: list.map(h => ({ name: h.name, action: h.action, at: h.at })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== PERMANENT CODES ====================
const PERM_CODE_PREFIX = 'קוד קבוע ';

// CREATE permanent code
app.post('/api/installer/permanent-codes', async (req, res) => {
  const { panelAddress, name, code, installerPhone } = req.body;
  if (!panelAddress || !name || !code) {
    return res.status(400).json({ success: false, error: 'panelAddress, name, code required' });
  }
  if (!/^\d{4}$/.test(code)) {
    return res.json({ success: false, error: 'קוד חייב להיות 4 ספרות' });
  }

  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) { console.log('perm-code panel login failed:', e.message); }
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    const listRes = await panelHttpGetWithHeaders(host, port, '/api/v1/access?page_num=1&page_size=500', authHeaders);
    const existingList = listRes?.data?.list || [];

    const permanentCodes = existingList.filter(i => (i.label || '').startsWith(PERM_CODE_PREFIX));
    if (permanentCodes.length >= 5) {
      return res.json({ success: false, error: 'מקסימום 5 קודים קבועים' });
    }

    const existingPasswords = new Set(existingList.map(i => i.content || i.password || ''));
    if (existingPasswords.has(code)) {
      return res.json({ success: false, error: 'קוד זה כבר קיים במערכת' });
    }

    const body = {
      label: PERM_CODE_PREFIX + name,
      password: code,
      effective_date: Date.now(),
      expired_date: 7258175999000,
      valid_weekdays: [0, 1, 2, 3, 4, 5, 6],
      valid_count: -1,
      valid_periods: JSON.stringify([{ begin: '00:00:00', end: '23:59:59' }]),
      valid_door: '1',
    };

    const createRes = await panelHttpPostWithHeaders(host, port, '/api/v1/access', body, authHeaders);
    if (createRes?.status === 'OK') {
      console.log(`✅ Permanent code created: ${name} CODE:${code}`);
      await logActivity({ phoneNumber: installerPhone || 'unknown', action: 'permanent_code_create', mac: panelAddress, details: { name }, success: true });
      return res.json({ success: true, name, code });
    }
    const errMsg = createRes?.error?.message || createRes?.error || createRes?.status || 'Unknown error';
    return res.json({ success: false, error: String(errMsg) });
  } catch (err) {
    console.error('Permanent code error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// LIST permanent codes
app.get('/api/installer/permanent-codes', async (req, res) => {
  const { panelAddress } = req.query;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    const listRes = await panelHttpGetWithHeaders(host, port, '/api/v1/access?page_num=1&page_size=500', authHeaders);
    const existingList = listRes?.data?.list || [];

    const codes = existingList
      .filter(i => (i.label || '').startsWith(PERM_CODE_PREFIX))
      .map(i => ({
        id: i.id,
        name: (i.label || '').slice(PERM_CODE_PREFIX.length),
        code: i.content || i.password || '',
      }));

    res.json({ success: true, codes, total: codes.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// UPDATE permanent code (delete old + create new)
app.put('/api/installer/permanent-codes/:codeId', async (req, res) => {
  const { panelAddress, name, code, installerPhone } = req.body;
  const { codeId } = req.params;
  if (!panelAddress || !name || !code) {
    return res.status(400).json({ success: false, error: 'panelAddress, name, code required' });
  }
  if (!/^\d{4}$/.test(code)) {
    return res.json({ success: false, error: 'קוד חייב להיות 4 ספרות' });
  }
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    if (!token) return res.json({ success: false, error: 'Panel login failed' });
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Delete old record via batchdelete (same as faces)
    await new Promise((resolve, reject) => {
      const fs = require('fs');
      const os = require('os');
      const tmpJson = require('path').join(os.tmpdir(), `permdel_${Date.now()}.json`);
      const _cid=Number(codeId); fs.writeFileSync(tmpJson, JSON.stringify({ list: [Number.isFinite(_cid)?_cid:codeId] }));
      const cmd = `curl -s --max-time 15 -X POST ` +
        `-H "Authorization: Bearer ${token}" ` +
        `-H "Content-Type: application/json;charset=UTF-8" ` +
        `--data @${tmpJson} ` +
        `"http://${host}:${port}/api/v1/access/batchdelete"`;
      exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        fs.unlink(tmpJson, () => {});
        if (err) reject(new Error('delete failed: ' + err.message));
        else resolve(stdout);
      });
    });

    // Create new record
    const body = {
      label: PERM_CODE_PREFIX + name,
      password: code,
      effective_date: Date.now(),
      expired_date: 7258175999000,
      valid_weekdays: [0, 1, 2, 3, 4, 5, 6],
      valid_count: -1,
      valid_periods: JSON.stringify([{ begin: '00:00:00', end: '23:59:59' }]),
      valid_door: '1',
    };
    const createRes = await panelHttpPostWithHeaders(host, port, '/api/v1/access', body, authHeaders);
    if (createRes?.status === 'OK') {
      console.log(`✅ Permanent code updated: ${name} CODE:${code}`);
      await logActivity({ phoneNumber: installerPhone || 'unknown', action: 'permanent_code_update', mac: panelAddress, details: { name }, success: true });
      return res.json({ success: true, name, code });
    }
    const errMsg = createRes?.error?.message || createRes?.error || createRes?.status || 'Unknown error';
    return res.json({ success: false, error: String(errMsg) });
  } catch (err) {
    console.error('Permanent code update error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE permanent code
app.delete('/api/installer/permanent-codes/:codeId', async (req, res) => {
  const { panelAddress, installerPhone } = req.query;
  const { codeId } = req.params;
  if (!panelAddress || !codeId) {
    return res.status(400).json({ success: false, error: 'panelAddress and codeId required' });
  }
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {}
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    await new Promise((resolve, reject) => {
      const fs = require('fs');
      const os = require('os');
      const tmpJson = require('path').join(os.tmpdir(), `permdel_${Date.now()}.json`);
      const _cid=Number(codeId); fs.writeFileSync(tmpJson, JSON.stringify({ list: [Number.isFinite(_cid)?_cid:codeId] }));
      const cmd = `curl -s --max-time 15 -X POST ` +
        `-H "Authorization: Bearer ${token}" ` +
        `-H "Content-Type: application/json;charset=UTF-8" ` +
        `--data @${tmpJson} ` +
        `"http://${host}:${port}/api/v1/access/batchdelete"`;
      exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        fs.unlink(tmpJson, () => {});
        if (err) reject(new Error('delete failed: ' + err.message));
        else resolve(stdout);
      });
    });

    console.log(`✅ Permanent code deleted: ${codeId}`);
    await logActivity({ phoneNumber: installerPhone || 'unknown', action: 'permanent_code_delete', mac: panelAddress, details: { codeId }, success: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Permanent code delete error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== TEMPORARY CODE ====================
app.post('/api/installer/temp-code', async (req, res) => {
  const { panelAddress, validWeekdays, validHourStart, validHourEnd } = req.body;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });
  if (!Array.isArray(validWeekdays) || validWeekdays.length === 0)
    return res.status(400).json({ success: false, error: 'validWeekdays required' });

  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    // Step 1: Login to panel
    let token = null;
    try {
      const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens',
        { username: 'admin', password: '123456' });
      token = loginRes?.data?.token || null;
    } catch(e) {
      console.log('Panel login failed:', e.message);
    }

    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    // Step 2: Get existing access list to find next Temporary code number
    const listRes = await panelHttpGetWithHeaders(host, port,
      '/api/v1/access?page_num=1&page_size=100', authHeaders);
    const existingList = listRes?.data?.list || [];

    // Find highest Temporary code number
    let maxNum = 0;
    for (const item of existingList) {
      const match = (item.label || '').match(/^Temporary code (\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    }
    const nextNum = maxNum + 1;
    const label = `Temporary code ${String(nextNum).padStart(2, '0')}`;

    // Collect existing passwords to avoid duplicates
    const existingPasswords = new Set(existingList.map(i => i.content || i.password || ''));

    // Step 3: Generate unique 4-digit PIN
    let pin = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = String(Math.floor(1000 + Math.random() * 9000));
      if (!existingPasswords.has(candidate)) { pin = candidate; break; }
    }
    if (!pin) return res.status(500).json({ success: false, error: 'Could not generate unique PIN after 20 attempts' });

    // Step 4: Create the temporary code
    const { expiryType, installerPhone } = req.body; // 'unlimited' | 'daily'

    // Calculate Israel timezone — find next occurrence of selected weekday(s)
    function getTargetDayTimestamps(weekdays) {
      const now = new Date();
      const year = now.getUTCFullYear();
      const marchEnd = new Date(Date.UTC(year, 2, 31));
      while (marchEnd.getUTCDay() !== 5) marchEnd.setUTCDate(marchEnd.getUTCDate() - 1);
      const octEnd = new Date(Date.UTC(year, 9, 31));
      while (octEnd.getUTCDay() !== 0) octEnd.setUTCDate(octEnd.getUTCDate() - 1);
      const offsetHours = (now >= marchEnd && now < octEnd) ? 3 : 2;

      const ilMs = now.getTime() + offsetHours * 3600000;
      const il = new Date(ilMs);
      const todayDOW = il.getUTCDay(); // 0=Sun

      // Find the nearest selected weekday from today (0 = today itself)
      let minOffset = 7;
      for (const targetDOW of weekdays) {
        const offset = (targetDOW - todayDOW + 7) % 7;
        minOffset = Math.min(minOffset, offset);
      }

      // Build start/end timestamps for that target date in Israel time
      const startMs = Date.UTC(il.getUTCFullYear(), il.getUTCMonth(), il.getUTCDate() + minOffset) - offsetHours * 3600000;
      const endMs = startMs + 86400000 - 1000; // 23:59:59

      const targetDate = new Date(startMs + offsetHours * 3600000);
      console.log(`📅 Daily target: +${minOffset} days → ${targetDate.toISOString().slice(0,10)}`);
      return { start: startMs, end: endMs };
    }

    const timestamps = getTargetDayTimestamps(validWeekdays);
    const effective_date = timestamps.start;
    const expired_date = expiryType === 'daily' ? timestamps.end : 7258175999000; // 2199-12-31

    const body = {
      label,
      password: pin,
      effective_date,
      expired_date,
      valid_weekdays: validWeekdays,
      valid_count: -1,
      valid_periods: JSON.stringify([{ begin: (validHourStart || '00:00') + ':00', end: (validHourEnd || '23:59') + ':59' }]),
      valid_door: '1',
    };

    const createRes = await panelHttpPostWithHeaders(host, port, '/api/v1/access', body, authHeaders);

    if (createRes?.status === 'OK') {
      console.log(`✅ Temp code created: ${label} PIN:${pin} days:${validWeekdays} expiry:${expiryType}`);
      await logActivity({ phoneNumber: req.body.installerPhone || 'unknown', action: 'temp_code', mac: panelAddress, details: { label, pin, validWeekdays, expiryType }, success: true });
      return res.json({ success: true, label, pin, validWeekdays, expiryType });
    } else {
      const errCode = createRes?.error?.code;
      const errMsg = createRes?.error?.message || createRes?.status || 'Unknown error';
      if (errCode === 409012) {
        return res.json({ success: false, error: 'קוד כבר קיים במערכת, נסה שוב' });
      }
      return res.json({ success: false, error: errMsg });
    }

  } catch (err) {
    console.error('Temp code error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: panelHttpGet with custom headers
function panelHttpGetWithHeaders(host, port, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host, port, path, method: 'GET',
      agent: new http.Agent({ keepAlive: false }),
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0',
        Connection: 'keep-alive',
        ...extraHeaders,
      },
    };
    const req = http.request(options, (panelRes) => {
      let data = '';
      panelRes.on('data', chunk => data += chunk);
      panelRes.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// Fetch ALL face access records from a panel, paging past the 500-per-page limit.
// Returns the full combined list (same shape as a single page's data.list).
async function getAllPanelFaces(host, port, token, pageSize = 500) {
  const all = [];
  let pageNum = 1;
  let total = Infinity;
  while (all.length < total) {
    const pageData = await panelHttpGetWithHeaders(
      host, port,
      `/api/v1/access?page_num=${pageNum}&page_size=${pageSize}&type=face&label=`,
      { Authorization: 'Bearer ' + token }
    );
    const list = pageData?.data?.list || [];
    total = pageData?.data?.total ?? list.length;
    if (!list.length) break; // safety: stop if panel returns an empty page
    all.push(...list);
    if (list.length < pageSize) break; // last page was partial — no more pages
    pageNum++;
    if (pageNum > 50) break; // safety cap (50 * 500 = 25,000 records)
  }
  return all;
}

// Helper: panelHttpPost with custom headers
function panelHttpPostWithHeaders(host, port, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    const options = {
      hostname: host, port, path, method: 'POST',
      agent: new http.Agent({ keepAlive: false }),
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': bodyBuf.length,
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0',
        Connection: 'keep-alive',
        ...extraHeaders,
      },
    };
    const req = http.request(options, (panelRes) => {
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

// ==================== ACTIVITY LOG ROUTES ====================

// GET all activity logs (manager only)
app.get('/api/manager/activity-logs', async (req, res) => {
  try {
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('activity_logs');
    const { phoneNumber, action, limit = 100 } = req.query;
    const filter = {};
    if (phoneNumber) filter.phoneNumber = phoneNumber;
    if (action) filter.action = action;
    const logs = await col
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .toArray();
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET activity logs for a specific installer
app.get('/api/manager/activity-logs/:phoneNumber', async (req, res) => {
  try {
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('activity_logs');
    const logs = await col
      .find({ phoneNumber: req.params.phoneNumber })
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== GENERIC ACTION LOG ====================
app.post('/api/installer/log-action', async (req, res) => {
  const { action, installerPhone, details = {} } = req.body;
  if (!action) return res.status(400).json({ success: false });
  await logActivity({ phoneNumber: installerPhone || 'unknown', action, mac: null, details, success: true });
  res.json({ success: true });
});

// ==================== ANNOUNCEMENTS ====================

// Manager: send announcement
app.post('/api/manager/announcements', async (req, res) => {
  try {
    const { text, audience, specificPhone, imageUrl } = req.body;
    if (!text && !imageUrl) return res.status(400).json({ success: false, error: 'Text or image required' });
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('announcements');
    const result = await col.insertOne({
      text: (text || '').trim(),
      audience: audience || 'all',
      specificPhone: specificPhone || null,
      imageUrl: imageUrl || null,
      createdAt: new Date(),
      readBy: [],
    });
    res.json({ success: true, id: result.insertedId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manager: get all announcements
app.get('/api/manager/announcements', async (req, res) => {
  try {
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('announcements');
    const announcements = await col.find({}).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ success: true, announcements });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manager: delete announcement
app.delete('/api/manager/announcements/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('announcements');
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Installer: get announcements for me
app.get('/api/installer/announcements', async (req, res) => {
  try {
    const { phoneNumber, accountType } = req.query;
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('announcements');
    const type = accountType || 'installer';
    const query = {
      $or: [
        { audience: { $in: ['all', type === 'committee' ? 'committees' : 'installers'] } },
        { audience: 'specific', specificPhone: phoneNumber }
      ]
    };
    const announcements = await col.find(query).sort({ createdAt: -1 }).limit(20).toArray();
    // Count unread
    const unread = announcements.filter(a => !a.readBy.includes(phoneNumber)).length;
    res.json({ success: true, announcements, unread });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Installer: mark announcements as read
app.post('/api/installer/announcements/read', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const db_module = require('./db');
    const database = await db_module.connectDB();
    const col = database.collection('announcements');
    await col.updateMany(
      { readBy: { $ne: phoneNumber } },
      { $addToSet: { readBy: phoneNumber } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== PANEL INFO ====================
app.post('/api/manager/panel-info', async (req, res) => {
  const { panelAddress } = req.body;
  if (!panelAddress) return res.status(400).json({ success: false, error: 'panelAddress required' });
  try {
    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    // Login
    const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
    const token = loginRes?.data?.token;
    if (!token) return res.status(500).json({ success: false, error: 'Panel login failed' });
    const auth = { Authorization: `Bearer ${token}` };

    // Fetch all 3 endpoints in parallel
    const [basic, network, sip2] = await Promise.all([
      panelHttpGetWithHeaders(host, port, '/api/v1/information/basic', auth),
      panelHttpGetWithHeaders(host, port, '/api/v1/configurations/networks', auth),
      panelHttpGetWithHeaders(host, port, '/api/v1/intercoms/sips/2', auth),
    ]);

    res.json({
      success: true,
      info: {
        softwareVersion: basic?.data?.software_version || '—',
        model:           basic?.data?.model || '—',
        mac:             basic?.data?.mac || '—',
        networkType:     network?.data?.type || '—',
        ip:              network?.data?.ip || '—',
        account2Name:    sip2?.data?.username || sip2?.data?.register || '—',
        account2Server:  sip2?.data?.server_endpoint || '—',
      }
    });
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

// Accepts ANY file type (for per-MAC reference files: PDF, Excel, etc.)
const anyFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
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


// ==================== MANAGER IMAGES (personal PNG/JPG reference storage) ====================
app.post('/api/manager/images/upload', anyFileUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });
    const isPdf = (req.file.mimetype === 'application/pdf') || /\.pdf$/i.test(req.file.originalname || '');
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: 'tador/manager-images',
          resource_type: isPdf ? 'raw' : 'image',
          public_id: `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });
    await db.addManagerImage({
      name: req.file.originalname,
      url: result.secure_url,
      publicId: result.public_id,
      size: req.file.size,
      isPdf: isPdf,
      uploadedAt: new Date(),
    });
    res.json({ success: true, image: { name: req.file.originalname, url: result.secure_url, publicId: result.public_id } });
  } catch (err) {
    console.error('Image upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/manager/images', async (req, res) => {
  try {
    const images = await db.getManagerImages();
    res.json({ success: true, images });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/manager/images/title', async (req, res) => {
  try {
    const { publicId, title } = req.body;
    if (!publicId) return res.status(400).json({ success: false, error: 'publicId required' });
    await db.updateManagerImageTitle(publicId, title);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/manager/images/:publicId(*)', async (req, res) => {
  try {
    const publicId = req.params.publicId;
    // Could be an image or a raw pdf — try both resource types
    try { await cloudinary.uploader.destroy(publicId, { resource_type: 'image' }); } catch(e) {}
    try { await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' }); } catch(e) {}
    await db.deleteManagerImage(publicId);
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
    // Order matters: MACs are de-duplicated globally below (first occurrence wins).
    // A MAC can legitimately sit on both an installer and a committee account —
    // the installer record holds the real data, so it must be processed first.
    const filtered = installers
      .filter(i => i.phoneNumber !== adminUser)
      .sort((a, b) => {
        const rank = x => ((x.accountType || 'installer') === 'installer' ? 0 : 1);
        return rank(a) - rank(b);
      });

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
          purchaseDate: m.purchaseDate || '',
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

    // Build monthly sales data from purchaseDate
    const salesByMonth = {};
    for (const inst of installerList) {
      for (const m of inst.macAddresses) {
        if (!m.purchaseDate) continue;
        let d = new Date(m.purchaseDate);
        // Handle DD/MM/YYYY format
        if (isNaN(d) && m.purchaseDate.includes('/')) {
          const parts = m.purchaseDate.split('/');
          if (parts.length === 3) d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        }
        if (isNaN(d)) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        salesByMonth[key] = (salesByMonth[key] || 0) + 1;
      }
    }
    // Sort by date
    const salesData = Object.entries(salesByMonth)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count }));
    console.log('salesData:', JSON.stringify(salesData));
    // Debug: sample purchaseDates
    const sampleDates = installerList.flatMap(i => i.macAddresses.map(m => m.purchaseDate)).filter(Boolean).slice(0,5);
    console.log('sample purchaseDates:', sampleDates);

    res.json({
      success: true,
      summary: { totalInstallers, totalMacs, totalLicensesPaid, genesis7Count, genesis5Count },
      installers: installerList,
      alerts: { oneYear: alerts1Year, twoYears: alerts2Years },
      salesData,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ==================== ADMIN NOTES ====================
app.get('/api/manager/notes', async (req, res) => {
  try {
    const notes = await db.getAdminNotes();
    res.json({ success: true, notes });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/manager/notes', async (req, res) => {
  try {
    const { notes } = req.body;
    await db.saveAdminNotes(notes);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Upload image for notes (paste from clipboard)
app.post('/api/manager/notes/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No image' });
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'tador/notes', resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto', width: 1600, crop: 'limit' }] },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(req.file.buffer);
    });
    res.json({ success: true, url: result.secure_url });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
// ==================== RESIDENTS SYSTEM ====================

function generateBuildingCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateBuildingPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pass = '';
  for (let i = 0; i < 6; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
}

// Manager: create building
app.post('/api/buildings/create', async (req, res) => {
  try {
    const { mac, address } = req.body;
    if (!mac || !address) return res.status(400).json({ success: false, error: 'mac and address required' });
    const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();
    const database = await require('./db').connectDB();
    const col = database.collection('buildings');
    // Check if MAC already exists
    const existing = await col.findOne({ mac: cleanMac });
    if (existing) return res.json({ success: false, error: 'Building with this MAC already exists' });
    const buildingCode = generateBuildingCode();
    const password = generateBuildingPassword();
    await col.insertOne({
      mac: cleanMac,
      address,
      buildingCode,
      password,
      createdAt: new Date(),
    });
    res.json({ success: true, buildingCode, password, mac: cleanMac, address });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manager: list all buildings
app.get('/api/buildings', async (req, res) => {
  try {
    const database = await require('./db').connectDB();
    const buildings = await database.collection('buildings').find({}).sort({ createdAt: -1 }).toArray();
    // Normalize: ensure panels array exists on all buildings
    buildings.forEach(b => { if (!b.panels) b.panels = [{ mac: b.mac, label: 'כניסה ראשית' }]; });
    res.json({ success: true, buildings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manager: delete building
app.delete('/api/buildings/:code', async (req, res) => {
  try {
    const database = await require('./db').connectDB();
    await database.collection('buildings').deleteOne({ buildingCode: req.params.code });
    await database.collection('residents').deleteMany({ buildingCode: req.params.code });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public: get building info by code (for registration page)
app.get('/api/buildings/info/:code', async (req, res) => {
  try {
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode: req.params.code });
    if (!building) return res.json({ success: false, error: 'Building not found' });
    res.json({ success: true, address: building.address, buildingCode: building.buildingCode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Resident: self-register (multipart with photo)
app.post('/api/residents/register', upload.single('photo'), async (req, res) => {
  try {
    const { buildingCode, phone, residentId } = req.body;
    if (!buildingCode || !phone) {
      return res.status(400).json({ success: false, error: 'buildingCode and phone required' });
    }
    const cleanPhone = phone.replace(/[\-\s]/g, '');
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode });
    if (!building) return res.json({ success: false, error: 'Building code not found' });

    // Find the approved resident by phone
    const { ObjectId } = require('mongodb');
    let resident;
    if (residentId) {
      resident = await database.collection('residents').findOne({ _id: new ObjectId(residentId), buildingCode });
    }
    if (!resident) {
      resident = await database.collection('residents').findOne({ buildingCode, phone: cleanPhone });
    }

    if (!resident) {
      // Open-registration: create a NEW resident as 'pending' (awaits committee approval; NOT on panel)
      if (building.openRegistration) {
        const { firstName, lastName, apartment } = req.body;
        let photoUrl = null;
        if (req.file) {
          const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              { folder: 'genesistracer-residents', resource_type: 'image' },
              (error, result) => error ? reject(error) : resolve(result)
            );
            stream.end(req.file.buffer);
          });
          photoUrl = result.secure_url;
        }
        await database.collection('residents').insertOne({
          buildingCode,
          mac: building.mac,
          firstName: (firstName || '').trim(),
          lastName: (lastName || '').trim(),
          phone: cleanPhone,
          apartment: (apartment || '').trim(),
          photoUrl,
          status: 'pending',          // committee must approve before panel
          uploadedToPanel: false,
          selfRegistered: true,
          createdAt: new Date(),
          registeredAt: new Date(),
        });
        return res.json({ success: true, pending: true });
      }
      return res.json({ success: false, error: 'not_found' });
    }
    if (resident.status === 'registered') return res.json({ success: false, error: 'already_registered' });

    // Upload photo to Cloudinary
    let photoUrl = null;
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'genesistracer-residents', resource_type: 'image' },
          (error, result) => error ? reject(error) : resolve(result)
        );
        stream.end(req.file.buffer);
      });
      photoUrl = result.secure_url;
    }

    // Update the approved record to registered
    await database.collection('residents').updateOne(
      { _id: resident._id },
      { $set: { status: 'registered', photoUrl, registeredAt: new Date() } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Committee: login + get residents
app.post('/api/committee/login', async (req, res) => {
  try {
    const { buildingCode, password } = req.body;
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.json({ success: false, error: 'Invalid building code or password' });
    res.json({ success: true, address: building.address, buildingCode: building.buildingCode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Toggle hiding the "פנים בפנל Genesis" section from the committee for a building
app.post('/api/buildings/:code/hide-panel-faces', async (req, res) => {
  try {
    const { username, password, hide } = req.body;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const database = await require('./db').connectDB();
    const r = await database.collection('buildings').updateOne(
      { buildingCode: req.params.code },
      { $set: { hidePanelFaces: !!hide } }
    );
    if (!r.matchedCount) return res.json({ success: false, error: 'Building not found' });
    res.json({ success: true, hidePanelFaces: !!hide });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Toggle open registration (committee-approval mode) for a building
app.post('/api/buildings/:code/open-registration', async (req, res) => {
  try {
    const { username, password, open } = req.body;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const database = await require('./db').connectDB();
    const r = await database.collection('buildings').updateOne(
      { buildingCode: req.params.code },
      { $set: { openRegistration: !!open } }
    );
    if (!r.matchedCount) return res.json({ success: false, error: 'Building not found' });
    res.json({ success: true, openRegistration: !!open });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Committee: manually mark a pending resident as approved (dismiss the pending badge)
app.post('/api/committee/approve-resident', async (req, res) => {
  try {
    const { buildingCode, password, residentId } = req.body;
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { ObjectId } = require('mongodb');
    await database.collection('residents').updateOne(
      { _id: new ObjectId(residentId), buildingCode },
      { $set: { status: 'approved', approvedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/committee/residents/:code', async (req, res) => {
  try {
    const { password, username, managerPass } = req.query;
    const database = await require('./db').connectDB();
    let building;
    // Manager bypass (from building-admin drawer)
    if (username && managerPass && username === process.env.ADMIN_USER && managerPass === process.env.ADMIN_PASS) {
      building = await database.collection('buildings').findOne({ buildingCode: req.params.code });
    } else {
      building = await database.collection('buildings').findOne({ buildingCode: req.params.code, password });
    }
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const residents = await database.collection('residents')
      .find({ buildingCode: req.params.code })
      .sort({ apartment: 1 })
      .toArray();
    res.json({ success: true, residents, address: building.address });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Committee: delete resident
app.delete('/api/committee/residents/:id', async (req, res) => {
  try {
    const { password, buildingCode, username } = req.query;
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    let building;
    if (username && username === process.env.ADMIN_USER) {
      building = await database.collection('buildings').findOne({ buildingCode });
    } else {
      building = await database.collection('buildings').findOne({ buildingCode, password });
    }
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });
    await database.collection('residents').deleteOne({ _id: new ObjectId(req.params.id), buildingCode });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// Committee: upload resident face(s) to the panel
// In-memory store for running committee face-upload jobs (progress polling)
const uploadFacesJobs = {};

app.post('/api/committee/upload-faces', async (req, res) => {
  try {
    const { buildingCode, password, residentIds } = req.body;
    console.log(`📤 [upload-faces] request: building=${buildingCode} residents=${(residentIds||[]).length} panelMac=${req.body.panelMac || '(building default)'}`);
    if (!buildingCode || !password || !Array.isArray(residentIds) || !residentIds.length) {
      console.log('📤 [upload-faces] ❌ missing required fields');
      return res.status(400).json({ success: false, error: 'buildingCode, password and residentIds required' });
    }
    const database = await require('./db').connectDB();

    // Verify committee credentials
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) {
      console.log(`📤 [upload-faces] ❌ unauthorized for building=${buildingCode}`);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const jobId = 'upl_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    uploadFacesJobs[jobId] = {
      status: 'starting',   // starting | running | done | error
      stage: 'מתחבר לפנל...',
      done: 0,
      total: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      currentName: null,
      results: [],
      error: null,
      startedAt: Date.now(),
    };
    res.json({ success: true, jobId });

    runUploadFacesJob(jobId, buildingCode, building, residentIds, req.body.panelMac).catch(e => {
      console.log(`📤 [upload-faces] ❌ UNHANDLED ERROR: ${e.message}\n${e.stack}`);
      if (uploadFacesJobs[jobId]) {
        uploadFacesJobs[jobId].status = 'error';
        uploadFacesJobs[jobId].error = e.message;
        uploadFacesJobs[jobId].finishedAt = Date.now();
      }
    });
  } catch (err) {
    console.log(`📤 [upload-faces] ❌ UNHANDLED ERROR: ${err.message}\n${err.stack}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Poll upload-faces job progress
app.get('/api/committee/upload-faces/status/:jobId', (req, res) => {
  const job = uploadFacesJobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, job });
  if ((job.status === 'done' || job.status === 'error') && Date.now() - (job.finishedAt || 0) > 5 * 60 * 1000) {
    delete uploadFacesJobs[req.params.jobId];
  }
});

async function runUploadFacesJob(jobId, buildingCode, building, residentIds, panelMac) {
  const job = uploadFacesJobs[jobId];
  job.status = 'running';
  const { ObjectId } = require('mongodb');
  const database = await require('./db').connectDB();

  // Resolve panel address via NexHome lookup (same flow as /api/lookup)
  // Use selected panel MAC if provided, otherwise fall back to building's primary MAC
  const rawMac = panelMac || building.mac;
  const cleanMac = rawMac.replace(/[:\-\s]/g, '').toUpperCase();
  console.log(`📤 [upload-faces] resolving panel mac=${cleanMac}`);
  job.stage = 'מאתר את הפנל...';
  let panelAddress;
  try {
    panelAddress = await resolvePanelAddress(cleanMac);
  } catch (e) {
    console.log(`📤 [upload-faces] ❌ resolvePanelAddress threw: ${e.message}`);
    job.status = 'error'; job.error = 'Could not reach panel: ' + e.message; job.finishedAt = Date.now();
    return;
  }
  if (!panelAddress) {
    console.log(`📤 [upload-faces] ❌ panel not found/offline mac=${cleanMac}`);
    job.status = 'error'; job.error = 'Panel not found / offline'; job.finishedAt = Date.now();
    return;
  }
  console.log(`📤 [upload-faces] panel resolved → ${panelAddress}`);

  const [host, portStr] = panelAddress.split(':');
  const port = parseInt(portStr) || 80;

  // Login to panel
  job.stage = 'מתחבר לפנל...';
  const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
  const token = loginRes?.data?.token;
  if (!token) {
    console.log(`📤 [upload-faces] ❌ panel login failed at ${host}:${port} — response: ${JSON.stringify(loginRes).slice(0,200)}`);
    job.status = 'error'; job.error = 'Panel login failed'; job.finishedAt = Date.now();
    return;
  }
  console.log(`📤 [upload-faces] ✅ panel login OK at ${host}:${port}`);

  // Get existing faces on panel to prevent duplicates (paged — panel may have 500+ faces)
  job.stage = 'בודק פנים קיימים בפנל...';
  const existingFaces = await getAllPanelFaces(host, port, token);
  const existingNames = new Set(existingFaces.map(p => (p.label || '').trim().toLowerCase()));
  console.log(`📤 [upload-faces] existing faces on panel: ${existingFaces.length}`);

  // Fetch the residents
  job.stage = 'שולף דיירים מהמערכת...';
  const residents = await database.collection('residents')
    .find({ _id: { $in: residentIds.map(id => new ObjectId(id)) }, buildingCode })
    .toArray();
  console.log(`📤 [upload-faces] matched ${residents.length}/${residentIds.length} residents in DB`);

  job.total = residents.length;
  job.stage = 'מעלה פנים...';

  for (const r of residents) {
    const name = (r.firstName + ' ' + r.lastName).trim();
    job.currentName = name;
    try {
      if (!r.photoUrl) {
        console.log(`📤 [upload-faces]   ⏭️ ${name}: no photoUrl`);
        job.results.push({ id: r._id, name, success: false, error: 'No photo' });
        job.failed++; job.done++;
        continue;
      }
      // Skip if name already exists on panel
      if (existingNames.has(name.toLowerCase())) {
        console.log(`📤 [upload-faces]   ⏭️ ${name}: already on panel`);
        job.results.push({ id: r._id, name, success: false, error: 'Already on panel' });
        job.skipped++; job.done++;
        // Still mark as uploaded since they're already there
        await database.collection('residents').updateOne({ _id: r._id }, { $set: { uploadedToPanel: true, uploadedAt: new Date(), status: 'approved' } });
        continue;
      }
      await uploadFaceToPanel(host, port, token, name, r.photoUrl);
      console.log(`📤 [upload-faces]   ✅ ${name}: uploaded`);
      // Mark as uploaded in DB
      await database.collection('residents').updateOne({ _id: r._id }, { $set: { uploadedToPanel: true, uploadedAt: new Date(), status: 'approved' } });
      job.results.push({ id: r._id, name, success: true });
      job.uploaded++;
    } catch (e) {
      console.log(`📤 [upload-faces]   ❌ ${name}: ${e.message}`);
      job.results.push({ id: r._id, name, success: false, error: e.message });
      job.failed++;
    }
    job.done++;
  }

  console.log(`📤 [upload-faces] done: uploaded=${job.uploaded} skipped=${job.skipped} failed=${job.failed} total=${job.results.length}`);
  job.currentName = null;
  job.stage = 'הושלם';
  job.status = 'done';
  job.finishedAt = Date.now();
}

// Resolve a MAC to panel host:port via NexHome (reuses lookup logic)
async function resolvePanelAddress(cleanMac) {
  const auth = await getAuthToken('face-upload');
  const macData = await searchMac(auth, cleanMac);
  const macEntry = (macData?.result?.elements || macData?.result?.list || [])[0];
  if (!macEntry) return null;
  const communityId = macEntry.usedCommunityId || macEntry.communityId;
  const deviceData = await getDeviceByMac(auth, cleanMac, communityId);
  const deviceEntry = (deviceData?.result?.elements || deviceData?.result?.list || [])[0];
  if (!deviceEntry) return null;
  const reverseLoginData = await getReverseLoginInfo(auth, deviceEntry.id, communityId);
  const ip = reverseLoginData?.result?.targetHost || null;
  const port = reverseLoginData?.result?.targetPort || null;
  return ip && port ? `${ip}:${port}` : null;
}

// Upload a single face: download from Cloudinary, then panel 2-step (image + access record) via curl
function uploadFaceToPanel(host, port, token, name, photoUrl) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpImg = path.join(os.tmpdir(), `face_${Date.now()}.jpg`);

    // Step A: download image from Cloudinary to temp file
    axios.get(photoUrl, { responseType: 'arraybuffer', timeout: 20000 })
      .then(imgRes => {
        fs.writeFileSync(tmpImg, Buffer.from(imgRes.data));

        // Step B: upload image to panel (multipart) via curl
        const uploadCmd = `curl -s --max-time 20 -X POST ` +
          `-H "Authorization: Bearer ${token}" ` +
          `-F "file=@${tmpImg};type=image/jpeg" ` +
          `"http://${host}:${port}/api/v1/access/image/jpg"`;

        exec(uploadCmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
          console.log('📤 Image upload response:', (stdout || '').slice(0, 300));
          if (err) { fs.unlink(tmpImg, () => {}); return reject(new Error('image upload failed: ' + err.message)); }
          let serverFile;
          try {
            const parsed = JSON.parse(stdout);
            serverFile = parsed?.data?.name || parsed?.data?.filename || parsed?.name || parsed?.data?.face_picture_name || parsed?.data;
          } catch(e) {
            fs.unlink(tmpImg, () => {});
            return reject(new Error('bad image response: ' + (stdout || '').slice(0,100)));
          }
          if (!serverFile) { fs.unlink(tmpImg, () => {}); return reject(new Error('no filename in: ' + (stdout || '').slice(0,100))); }
          console.log('📁 Server filename:', serverFile);

          // Step C: create the access record with the face (exact body from panel HAR)
          const accessBody = JSON.stringify({
            label: name,
            effective_date: Date.now(),
            expired_date: 7258175999000,
            valid_weekdays: [0, 1, 2, 3, 4, 5, 6],
            valid_count: -1,
            facePictureName: serverFile,
            content: serverFile,
            valid_periods: JSON.stringify([{ begin: '00:00:00', end: '23:59:59' }]),
            valid_door: '1',
          });
          const tmpJson = path.join(os.tmpdir(), `access_${Date.now()}.json`);
          fs.writeFileSync(tmpJson, accessBody);

          const accessCmd = `curl -s --max-time 15 -X POST ` +
            `-H "Authorization: Bearer ${token}" ` +
            `-H "Content-Type: application/json;charset=UTF-8" ` +
            `--data @${tmpJson} ` +
            `"http://${host}:${port}/api/v1/access"`;

          exec(accessCmd, { maxBuffer: 1024 * 1024 }, (err2, stdout2) => {
            console.log('📥 Access record response:', (stdout2 || '').slice(0, 300));
            fs.unlink(tmpImg, () => {});
            fs.unlink(tmpJson, () => {});
            if (err2) return reject(new Error('access record failed: ' + err2.message));
            try {
              const parsed2 = JSON.parse(stdout2);
              if (parsed2?.status && parsed2.status !== 'OK' && parsed2.status !== 0 && parsed2.status !== '0') {
                return reject(new Error('panel: ' + (parsed2.error || parsed2.status || JSON.stringify(parsed2).slice(0,80))));
              }
              if (parsed2?.error) {
                return reject(new Error('panel: ' + parsed2.error));
              }
            } catch(e) { /* non-JSON, assume ok */ }
            resolve(true);
          });
        });
      })
      .catch(e => reject(new Error('photo download failed')));
  });
}



// Committee: delete resident face(s) from the panel
app.post('/api/committee/delete-faces', async (req, res) => {
  try {
    const { buildingCode, password, residentIds } = req.body;
    if (!buildingCode || !password || !Array.isArray(residentIds) || !residentIds.length) {
      return res.status(400).json({ success: false, error: 'buildingCode, password and residentIds required' });
    }
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();

    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // Use selected panel MAC if provided, otherwise fall back to building's primary MAC
    const rawMac = req.body.panelMac || building.mac;
    const cleanMac = rawMac.replace(/[:\-\s]/g, '').toUpperCase();
    let panelAddress;
    try {
      panelAddress = await resolvePanelAddress(cleanMac);
    } catch (e) {
      return res.json({ success: false, error: 'Could not reach panel: ' + e.message });
    }
    if (!panelAddress) return res.json({ success: false, error: 'Panel not found / offline' });

    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
    const token = loginRes?.data?.token;
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    // Get the full access list from the panel (to map name → id) — paged
    const panelList = await getAllPanelFaces(host, port, token);

    const residents = await database.collection('residents')
      .find({ _id: { $in: residentIds.map(id => new ObjectId(id)) }, buildingCode })
      .toArray();

    const results = [];
    for (const r of residents) {
      const name = (r.firstName + ' ' + r.lastName).trim();
      try {
        // Find matching access record(s) by label
        const matches = panelList.filter(p => (p.label || '').trim() === name);
        if (!matches.length) {
          results.push({ id: r._id, name, success: false, error: 'Not found on panel' });
          continue;
        }
        // Delete all matching records (in case of duplicates)
        for (const m of matches) {
          await deleteFaceFromPanel(host, port, token, m.id);
        }
        results.push({ id: r._id, name, success: true, deleted: matches.length });
      } catch (e) {
        results.push({ id: r._id, name, success: false, error: e.message });
      }
    }

    const ok = results.filter(x => x.success).length;
    const fail = results.length - ok;
    res.json({ success: true, deleted: ok, failed: fail, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete access record(s) from the panel via batchdelete (via curl)
function deleteFaceFromPanel(host, port, token, accessId) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    // The panel returns ids as NUMBERS and only matches numbers in batchdelete.
    // A string id ("49") is silently ignored — it returns OK but deletes nothing.
    const numId = Number(accessId);
    const idForDelete = Number.isFinite(numId) ? numId : accessId;
    const tmpJson = path.join(os.tmpdir(), `del_${Date.now()}.json`);
    fs.writeFileSync(tmpJson, JSON.stringify({ list: [idForDelete] }));

    const cmd = `curl -s --max-time 15 -X POST ` +
      `-H "Authorization: Bearer ${token}" ` +
      `-H "Content-Type: application/json;charset=UTF-8" ` +
      `--data @${tmpJson} ` +
      `"http://${host}:${port}/api/v1/access/batchdelete"`;
    console.log(`🗑 Deleting face id=${accessId} from ${host}:${port}`);
    exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      fs.unlink(tmpJson, () => {});
      console.log('Delete response:', (stdout || '').slice(0, 200));
      if (err) return reject(new Error('delete failed: ' + err.message));
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.status && parsed.status !== 'OK' && parsed?.error) {
          return reject(new Error(parsed.error.message || parsed.error));
        }
      } catch(e) { /* assume ok */ }
      resolve(true);
    });
  });
}



// Committee: list all faces currently on the panel
app.post('/api/committee/panel-faces', async (req, res) => {
  try {
    const { buildingCode, password } = req.body;
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // Use selected panel MAC if provided, otherwise fall back to building's primary MAC
    const rawMac = req.body.panelMac || building.mac;
    const cleanMac = rawMac.replace(/[:\-\s]/g, '').toUpperCase();
    let panelAddress;
    try {
      panelAddress = await resolvePanelAddress(cleanMac);
    } catch (e) {
      return res.json({ success: false, error: 'Could not reach panel: ' + e.message });
    }
    if (!panelAddress) return res.json({ success: false, error: 'Panel not found / offline' });

    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
    const token = loginRes?.data?.token;
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    const rawList = await getAllPanelFaces(host, port, token);

    // Fetch each face image as base64 (panel serves them at /api/v1/access/image/{file})
    const list = [];
    for (const p of rawList) {
      let photoBase64 = null;
      try {
        // Image URL uses the record id (e.g. 31.jpg) with ?id= query — no auth header needed
        const imgUrl = `http://${host}:${port}/api/v1/access/image/${p.id}.jpg?id=${p.id}`;
        const imgRes = await axios.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: { 'Referer': `http://${host}:${port}/`, 'Accept': 'application/json, text/plain, */*' },
        });
        const buf = Buffer.from(imgRes.data);
        if (buf.length > 100) {
          photoBase64 = 'data:image/jpeg;base64,' + buf.toString('base64');
        }
        console.log(`📷 Face ${p.id} (${p.label}): ${buf.length} bytes`);
      } catch (e) {
        console.log(`📷 Face ${p.id} image failed: ${e.message}`);
      }
      list.push({
        id: p.id,
        name: p.label,
        type: p.type,
        validFloor: p.valid_floor,
        createdTime: p.created_time,
        photo: photoBase64,
      });
    }

    res.json({ success: true, faces: list, total: list.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Committee: delete a face from the panel by its panel ID directly
app.post('/api/committee/delete-panel-id', async (req, res) => {
  try {
    const { buildingCode, password, panelId, panelMac } = req.body;
    if (!buildingCode || !password || panelId === undefined) {
      return res.status(400).json({ success: false, error: 'buildingCode, password, panelId required' });
    }
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const rawMac = panelMac || building.mac;
    const cleanMac = rawMac.replace(/[:\-\s]/g, '').toUpperCase();
    console.log(`🗑 delete-panel-id: id=${panelId} mac=${cleanMac} (requested panelMac=${panelMac||'none'})`);
    const panelAddress = await resolvePanelAddress(cleanMac);
    if (!panelAddress) return res.json({ success: false, error: 'Panel not found / offline' });

    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;
    const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
    const token = loginRes?.data?.token;
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    await deleteFaceFromPanel(host, port, token, panelId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Committee: import panel faces into residents collection (save permanently)
app.post('/api/committee/import-faces', async (req, res) => {
  try {
    const { buildingCode, password, panelMac } = req.body;
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const rawMac = panelMac || building.mac;
    const cleanMac = rawMac.replace(/[:\-\s]/g, '').toUpperCase();
    console.log(`💾 import-faces: mac=${cleanMac}`);
    const panelAddress = await resolvePanelAddress(cleanMac);
    if (!panelAddress) return res.json({ success: false, error: 'Panel not found / offline' });

    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;
    const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
    const token = loginRes?.data?.token;
    if (!token) return res.json({ success: false, error: 'Panel login failed' });

    const rawList = await getAllPanelFaces(host, port, token);

    // Existing residents for this building (avoid duplicates by name)
    const existing = await database.collection('residents').find({ buildingCode }).toArray();
    const existingNames = new Set(existing.map(r => (r.firstName + ' ' + r.lastName).trim()));

    let imported = 0, skipped = 0, failed = 0;
    for (const p of rawList) {
      const fullName = (p.label || '').trim();
      if (!fullName) { failed++; continue; }
      if (existingNames.has(fullName)) { skipped++; continue; }

      // Download face image from panel
      let photoUrl = null;
      try {
        const imgUrl = `http://${host}:${port}/api/v1/access/image/${p.id}.jpg?id=${p.id}`;
        const imgRes = await axios.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: { 'Referer': `http://${host}:${port}/`, 'Accept': 'application/json, text/plain, */*' },
        });
        const buf = Buffer.from(imgRes.data);
        if (buf.length > 100) {
          // Upload to Cloudinary so it persists
          const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              { folder: 'genesistracer-residents', resource_type: 'image' },
              (error, result) => error ? reject(error) : resolve(result)
            );
            stream.end(buf);
          });
          photoUrl = uploadResult.secure_url;
        }
      } catch (e) { /* no photo */ }

      // Split name into first + last (first word = first name, rest = last)
      const parts = fullName.split(/\s+/);
      const firstName = parts[0] || fullName;
      const lastName = parts.slice(1).join(' ') || '';

      await database.collection('residents').insertOne({
        buildingCode,
        mac: building.mac,
        firstName,
        lastName,
        phone: '',
        apartment: '',
        photoUrl,
        importedFromPanel: true,
        panelFaceId: p.id,
        createdAt: new Date(),
      });
      imported++;
    }

    res.json({ success: true, imported, skipped, failed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Committee: edit a resident's apartment / phone / name
app.post('/api/committee/edit-resident', async (req, res) => {
  try {
    const { buildingCode, password, residentId, firstName, lastName, apartment, phone, notes } = req.body;
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const update = {};
    if (firstName !== undefined) update.firstName = firstName.trim();
    if (lastName !== undefined) update.lastName = lastName.trim();
    if (apartment !== undefined) update.apartment = apartment.trim();
    if (phone !== undefined) update.phone = phone.trim();
    if (notes !== undefined) update.notes = notes.trim();

    await database.collection('residents').updateOne(
      { _id: new ObjectId(residentId), buildingCode },
      { $set: update }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ==================== APPROVED RESIDENTS (Excel/CSV whitelist) ====================

// Manager: upload CSV of approved residents for a building
// Expects: name, phone, apartment (Hebrew or English headers)
app.post('/api/buildings/:code/upload-residents', upload.single('file'), async (req, res) => {
  try {
    const { code } = req.params;
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode: code });
    if (!building) return res.json({ success: false, error: 'Building not found' });

    if (!req.file) return res.json({ success: false, error: 'No file uploaded' });

    // Parse CSV (handles both comma and tab separated, UTF-8 + BOM)
    let text = req.file.buffer.toString('utf8');
    // Remove BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return res.json({ success: false, error: 'File must have header + at least 1 row' });

    // Detect separator (comma or tab)
    const sep = lines[0].includes('\t') ? '\t' : ',';
    const header = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, '').trim().toLowerCase());

    // Map Hebrew/English headers to fields
    const nameIdx = header.findIndex(h => h === 'name' || h === 'שם' || h === 'שם מלא' || h === 'שם פרטי');
    const phoneIdx = header.findIndex(h => h === 'phone' || h === 'טלפון' || h === 'מספר טלפון' || h === 'נייד');
    const aptIdx = header.findIndex(h => h === 'apartment' || h === 'דירה' || h === 'מספר דירה' || h === 'apt');

    if (nameIdx === -1 || phoneIdx === -1) {
      return res.json({ success: false, error: 'Headers must include name/שם and phone/טלפון. Found: ' + header.join(', ') });
    }

    const col = database.collection('residents');
    let added = 0, skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g, '').trim());
      const fullName = cols[nameIdx] || '';
      const phone = cols[phoneIdx] || '';
      const apartment = aptIdx !== -1 ? (cols[aptIdx] || '') : '';

      if (!fullName || !phone) continue;

      // Clean phone — remove dashes, spaces
      const cleanPhone = phone.replace(/[\-\s]/g, '');

      // Check if already exists
      const existing = await col.findOne({ buildingCode: code, phone: cleanPhone });
      if (existing) { skipped++; continue; }

      const parts = fullName.split(/\s+/);
      const firstName = parts[0] || fullName;
      const lastName = parts.slice(1).join(' ') || '';

      await col.insertOne({
        buildingCode: code,
        mac: building.mac,
        firstName,
        lastName,
        phone: cleanPhone,
        apartment,
        photoUrl: null,
        status: 'approved',
        createdAt: new Date(),
      });
      added++;
    }

    res.json({ success: true, added, skipped, total: added + skipped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public: verify phone for registration
app.post('/api/residents/verify-phone', async (req, res) => {
  try {
    const { buildingCode, phone } = req.body;
    if (!buildingCode || !phone) return res.json({ success: false, error: 'Missing fields' });

    const cleanPhone = phone.replace(/[\-\s]/g, '');
    const database = await require('./db').connectDB();

    const resident = await database.collection('residents').findOne({ buildingCode, phone: cleanPhone });
    if (!resident) {
      // Open-registration buildings let unknown phones self-register (name/apt typed by resident)
      const building = await database.collection('buildings').findOne({ buildingCode });
      if (building && building.openRegistration) {
        return res.json({ success: true, openMode: true, firstName: '', lastName: '', apartment: '', residentId: null });
      }
      return res.json({ success: false, error: 'not_found' });
    }
    if (resident.status === 'registered') return res.json({ success: false, error: 'already_registered' });

    res.json({
      success: true,
      firstName: resident.firstName,
      lastName: resident.lastName,
      apartment: resident.apartment,
      residentId: resident._id,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Manager: add a single resident directly (from building-admin drawer)
app.post('/api/residents/add', async (req, res) => {
  try {
    const { buildingCode, firstName, lastName, phone, apartment, username, password } = req.body;
    if (!buildingCode || !firstName || !phone) {
      return res.status(400).json({ success: false, error: 'buildingCode, firstName and phone required' });
    }
    // Verify manager credentials
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode });
    if (!building) return res.json({ success: false, error: 'Building not found' });

    const cleanPhone = (phone || '').replace(/[\-\s]/g, '');

    // Check duplicate phone
    const existing = await database.collection('residents').findOne({ buildingCode, phone: cleanPhone });
    if (existing) return res.json({ success: false, error: 'duplicate_phone' });

    await database.collection('residents').insertOne({
      buildingCode,
      mac: building.mac,
      firstName: firstName.trim(),
      lastName: (lastName || '').trim(),
      phone: cleanPhone,
      apartment: (apartment || '').trim(),
      photoUrl: null,
      status: 'approved',
      createdAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Manager: add a panel (entrance) to an existing building
app.post('/api/buildings/:code/add-panel', async (req, res) => {
  try {
    const { mac, label, username, password } = req.body;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!mac) return res.json({ success: false, error: 'MAC required' });
    const database = await require('./db').connectDB();
    const cleanMac = mac.replace(/[:\-\s]/g,'').toUpperCase();
    const building = await database.collection('buildings').findOne({ buildingCode: req.params.code });
    if (!building) return res.json({ success: false, error: 'Building not found' });
    // Check duplicate MAC
    const panels = building.panels || [{ mac: building.mac, label: 'כניסה ראשית' }];
    if (panels.find(p => p.mac === cleanMac)) return res.json({ success: false, error: 'MAC already exists' });
    panels.push({ mac: cleanMac, label: label || ('כניסה ' + (panels.length + 1)) });
    await database.collection('buildings').updateOne(
      { buildingCode: req.params.code },
      { $set: { panels } }
    );
    res.json({ success: true, panels });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manager: remove a panel from a building
app.delete('/api/buildings/:code/panel/:mac', async (req, res) => {
  try {
    const { username, password } = req.query;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode: req.params.code });
    if (!building) return res.json({ success: false, error: 'Building not found' });
    const panels = (building.panels || [{ mac: building.mac, label: 'כניסה ראשית' }])
      .filter(p => p.mac !== req.params.mac.toUpperCase());
    if (!panels.length) return res.json({ success: false, error: 'חייב להיות לפחות פנל אחד' });
    await database.collection('buildings').updateOne(
      { buildingCode: req.params.code },
      { $set: { panels } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Committee: get panels for a building
app.get('/api/committee/building-panels/:code', async (req, res) => {
  try {
    const { password } = req.query;
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode: req.params.code, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const panels = building.panels || [{ mac: building.mac, label: 'כניסה ראשית' }];
    res.json({ success: true, panels, hidePanelFaces: !!building.hidePanelFaces });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Manager: upload an arbitrary reference file (PDF/Excel/any) for a specific MAC
app.post('/api/manager/mac-file', anyFileUpload.single('file'), async (req, res) => {
  try {
    const { phoneNumber, mac } = req.body;
    if (!req.file || !phoneNumber || !mac) {
      return res.status(400).json({ success: false, error: 'file, phoneNumber, mac required' });
    }
    const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();
    // Upload as raw so any file type (pdf, xlsx, docx...) is stored/served intact
    const safeName = (req.file.originalname || 'file').replace(/[^\w.\-]/g, '_');
    const uploadRes = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'genesistracer-macfiles', resource_type: 'raw', public_id: `${cleanMac}_${Date.now()}_${safeName}`, use_filename: true, unique_filename: false },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    // Save fileUrl + fileName on the matching MAC entry (match by normalized mac)
    const database = await require('./db').connectDB();
    const installer = await database.collection('installers').findOne({ phoneNumber });
    if (!installer) return res.json({ success: false, error: 'Installer not found' });
    const macs = (installer.macAddresses || []).map(m => {
      const mNorm = (m.mac || '').replace(/[:\-\s]/g, '').toUpperCase();
      if (mNorm === cleanMac) {
        return { ...m, fileUrl: uploadRes.secure_url, fileName: req.file.originalname };
      }
      return m;
    });
    await database.collection('installers').updateOne(
      { phoneNumber }, { $set: { macAddresses: macs } }
    );
    res.json({ success: true, fileUrl: uploadRes.secure_url, fileName: req.file.originalname });
  } catch (err) {
    console.error('mac-file upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manager: rename a panel label
app.post('/api/buildings/:code/rename-panel', async (req, res) => {
  try {
    const { mac, label, username, password } = req.body;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!mac || !label) return res.json({ success: false, error: 'mac and label required' });
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode: req.params.code });
    if (!building) return res.json({ success: false, error: 'Building not found' });
    const cleanMac = mac.replace(/[:\-\s]/g,'').toUpperCase();
    const panels = (building.panels || [{ mac: building.mac, label: 'כניסה ראשית' }])
      .map(p => p.mac === cleanMac ? { ...p, label: label.trim() } : p);
    await database.collection('buildings').updateOne(
      { buildingCode: req.params.code },
      { $set: { panels } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Committee: delete multiple faces from panel in ONE connection (resolve + login once)
app.post('/api/committee/delete-panel-ids', async (req, res) => {
  try {
    const { buildingCode, password, panelIds, panelMac } = req.body;
    if (!buildingCode || !password || !Array.isArray(panelIds) || !panelIds.length) {
      return res.status(400).json({ success: false, error: 'buildingCode, password, panelIds[] required' });
    }
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // Resolve panel address ONCE
    const rawMac = panelMac || building.mac;
    const cleanMac = rawMac.replace(/[:\-\s]/g,'').toUpperCase();
    console.log(`🗑 batch-delete: ${panelIds.length} faces, mac=${cleanMac}`);

    const panelAddress = await resolvePanelAddress(cleanMac);
    if (!panelAddress) return res.json({ success: false, error: 'פנל לא נמצא / לא מקוון' });

    const [host, portStr] = panelAddress.split(':');
    const port = parseInt(portStr) || 80;

    // Login ONCE
    const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
    const token = loginRes?.data?.token;
    if (!token) return res.json({ success: false, error: 'התחברות לפנל נכשלה' });

    console.log(`✅ batch-delete: logged into ${host}:${port}, deleting ${panelIds.length} faces`);

    // Delete all faces using the SAME connection
    const results = [];
    for (const id of panelIds) {
      try {
        await deleteFaceFromPanel(host, port, token, id);
        results.push({ id, success: true });
      } catch(e) {
        console.log(`❌ batch-delete: id=${id} failed: ${e.message}`);
        results.push({ id, success: false, error: e.message });
      }
    }

    const ok = results.filter(r => r.success).length;
    const fail = results.length - ok;
    console.log(`✅ batch-delete: done — ${ok} ok, ${fail} failed`);
    res.json({ success: true, deleted: ok, failed: fail, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Delete a resident's face from ALL panels of the building (used when resident leaves)
app.post('/api/committee/delete-resident-all-panels', async (req, res) => {
  try {
    const { buildingCode, password, residentIds } = req.body;
    if (!buildingCode || !password || !Array.isArray(residentIds) || !residentIds.length) {
      return res.status(400).json({ success: false, error: 'buildingCode, password, residentIds required' });
    }
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const panels = building.panels || [{ mac: building.mac, label: 'כניסה ראשית' }];

    // Get resident names to delete
    const residents = await database.collection('residents')
      .find({ _id: { $in: residentIds.map(id => new ObjectId(id)) }, buildingCode })
      .toArray();
    const namesToDelete = residents.map(r => (r.firstName + ' ' + r.lastName).trim().toLowerCase());

    const panelResults = [];

    // Loop through every panel in the building
    for (const panel of panels) {
      const cleanMac = panel.mac.replace(/[:\-\s]/g, '').toUpperCase();
      try {
        const panelAddress = await resolvePanelAddress(cleanMac);
        if (!panelAddress) {
          panelResults.push({ panel: panel.label, mac: cleanMac, success: false, error: 'not found/offline' });
          continue;
        }
        const [host, portStr] = panelAddress.split(':');
        const port = parseInt(portStr) || 80;

        const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
        const token = loginRes?.data?.token;
        if (!token) {
          panelResults.push({ panel: panel.label, mac: cleanMac, success: false, error: 'login failed' });
          continue;
        }

        // Get face list from this panel
        const faceList = await getAllPanelFaces(host, port, token);

        // Find matching faces by name
        const toDelete = faceList.filter(f => namesToDelete.includes((f.label || '').trim().toLowerCase()));
        let deleted = 0;
        for (const face of toDelete) {
          try {
            await deleteFaceFromPanel(host, port, token, face.id);
            deleted++;
          } catch(e) { /* continue */ }
        }
        console.log(`🗑 delete-all-panels: panel=${panel.label} mac=${cleanMac} deleted=${deleted}/${toDelete.length}`);
        panelResults.push({ panel: panel.label, mac: cleanMac, success: true, deleted, notFound: toDelete.length === 0 });
      } catch(e) {
        panelResults.push({ panel: panel.label, mac: cleanMac, success: false, error: e.message });
      }
    }

    const totalDeleted = panelResults.reduce((sum, p) => sum + (p.deleted || 0), 0);
    res.json({ success: true, panelResults, totalDeleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Committee: save a single panel face to the residents collection
app.post('/api/committee/save-panel-face', async (req, res) => {
  try {
    const { buildingCode, password, name, photoBase64, panelFaceId } = req.body;
    if (!buildingCode || !password || !name) {
      return res.status(400).json({ success: false, error: 'buildingCode, password, name required' });
    }
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode, password });
    if (!building) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // Check duplicate by name
    const parts = name.trim().split(/\s+/);
    const firstName = parts[0] || name;
    const lastName = parts.slice(1).join(' ') || '';
    const existing = await database.collection('residents').findOne({
      buildingCode,
      firstName: firstName.trim(),
      lastName: lastName.trim()
    });
    if (existing) return res.json({ success: false, error: 'already_exists', residentId: existing._id });

    // Upload base64 photo to Cloudinary
    let photoUrl = null;
    if (photoBase64) {
      try {
        const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64Data, 'base64');
        const uploadResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'genesistracer-residents', resource_type: 'image' },
            (error, result) => error ? reject(error) : resolve(result)
          );
          stream.end(buf);
        });
        photoUrl = uploadResult.secure_url;
      } catch(e) { console.log('Cloudinary upload failed:', e.message); }
    }

    const result = await database.collection('residents').insertOne({
      buildingCode,
      mac: building.mac,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: '',
      apartment: '',
      photoUrl,
      importedFromPanel: true,
      panelFaceId: panelFaceId || null,
      createdAt: new Date(),
    });

    res.json({ success: true, residentId: result.insertedId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Manager: get face count for each panel in a building
app.post('/api/buildings/:code/panel-stats', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode: req.params.code });
    if (!building) return res.json({ success: false, error: 'Building not found' });

    const panels = building.panels || [{ mac: building.mac, label: 'כניסה ראשית' }];
    const stats = [];

    for (const panel of panels) {
      const cleanMac = panel.mac.replace(/[:\-\s]/g, '').toUpperCase();
      try {
        const panelAddress = await resolvePanelAddress(cleanMac);
        if (!panelAddress) {
          stats.push({ mac: cleanMac, label: panel.label, faceCount: null, error: 'offline' });
          continue;
        }
        const [host, portStr] = panelAddress.split(':');
        const port = parseInt(portStr) || 80;
        const loginRes = await panelHttpPost(host, port, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
        const token = loginRes?.data?.token;
        if (!token) { stats.push({ mac: cleanMac, label: panel.label, faceCount: null, error: 'login failed' }); continue; }
        const listData = await panelHttpGetWithHeaders(host, port, '/api/v1/access?page_num=1&page_size=500&type=face&label=', { Authorization: 'Bearer ' + token });
        const count = listData?.data?.total ?? (listData?.data?.list || []).length;
        stats.push({ mac: cleanMac, label: panel.label, faceCount: count });
      } catch(e) {
        stats.push({ mac: cleanMac, label: panel.label, faceCount: null, error: e.message });
      }
    }
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// In-memory store for running face-transfer jobs (progress polling)
const faceTransferJobs = {};

// Start a face transfer job — returns jobId immediately, runs in background
app.post('/api/buildings/:code/transfer-faces', async (req, res) => {
  try {
    const { username, password, sourceMac, targetMac } = req.body;
    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!sourceMac || !targetMac) {
      return res.status(400).json({ success: false, error: 'sourceMac and targetMac required' });
    }
    const cleanSource = sourceMac.replace(/[:\-\s]/g, '').toUpperCase();
    const cleanTarget = targetMac.replace(/[:\-\s]/g, '').toUpperCase();
    if (cleanSource === cleanTarget) {
      return res.json({ success: false, error: 'Source and target panels are the same' });
    }

    const database = await require('./db').connectDB();
    const building = await database.collection('buildings').findOne({ buildingCode: req.params.code });
    if (!building) return res.json({ success: false, error: 'Building not found' });

    const jobId = 'xfer_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    faceTransferJobs[jobId] = {
      status: 'starting',   // starting | running | done | error
      stage: 'מתחבר לפנלים...',
      done: 0,
      total: 0,
      transferred: 0,
      skipped: 0,
      failed: 0,
      currentName: null,
      results: [],
      error: null,
      startedAt: Date.now(),
    };
    res.json({ success: true, jobId });

    // Run the actual transfer in the background (not awaited by the response above)
    runFaceTransferJob(jobId, cleanSource, cleanTarget).catch(e => {
      if (faceTransferJobs[jobId]) {
        faceTransferJobs[jobId].status = 'error';
        faceTransferJobs[jobId].error = e.message;
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Poll job progress
app.get('/api/buildings/:code/transfer-faces/status/:jobId', (req, res) => {
  const job = faceTransferJobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, job });
  // Clean up finished jobs after they've been read a while after completion
  if ((job.status === 'done' || job.status === 'error') && Date.now() - (job.finishedAt || 0) > 5 * 60 * 1000) {
    delete faceTransferJobs[req.params.jobId];
  }
});

async function runFaceTransferJob(jobId, cleanSource, cleanTarget) {
  const job = faceTransferJobs[jobId];
  job.status = 'running';

  job.stage = 'מאתר את הפנל המקור...';
  const sourceAddr = await resolvePanelAddress(cleanSource);
  if (!sourceAddr) { job.status = 'error'; job.error = 'Source panel not found / offline'; job.finishedAt = Date.now(); return; }

  job.stage = 'מאתר את פנל היעד...';
  const targetAddr = await resolvePanelAddress(cleanTarget);
  if (!targetAddr) { job.status = 'error'; job.error = 'Target panel not found / offline'; job.finishedAt = Date.now(); return; }

  const [srcHost, srcPortStr] = sourceAddr.split(':');
  const srcPort = parseInt(srcPortStr) || 80;
  const [tgtHost, tgtPortStr] = targetAddr.split(':');
  const tgtPort = parseInt(tgtPortStr) || 80;

  job.stage = 'מתחבר לפנל המקור...';
  const srcLogin = await panelHttpPost(srcHost, srcPort, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
  const srcToken = srcLogin?.data?.token;
  if (!srcToken) { job.status = 'error'; job.error = 'Source panel login failed'; job.finishedAt = Date.now(); return; }

  job.stage = 'מתחבר לפנל היעד...';
  const tgtLogin = await panelHttpPost(tgtHost, tgtPort, '/api/v1/accounts/tokens', { username: 'admin', password: '123456' });
  const tgtToken = tgtLogin?.data?.token;
  if (!tgtToken) { job.status = 'error'; job.error = 'Target panel login failed'; job.finishedAt = Date.now(); return; }

  job.stage = 'שולף רשימת פנים מהמקור...';
  const srcFaces = await getAllPanelFaces(srcHost, srcPort, srcToken);

  job.stage = 'שולף רשימת פנים מהיעד...';
  const tgtFaces = await getAllPanelFaces(tgtHost, tgtPort, tgtToken);
  const existingTargetNames = new Set(tgtFaces.map(p => (p.label || '').trim().toLowerCase()));

  job.total = srcFaces.length;
  job.stage = 'מעביר פנים...';

  for (const f of srcFaces) {
    const name = (f.label || '').trim();
    job.currentName = name || '(ללא שם)';
    if (!name) {
      job.results.push({ name: '(ללא שם)', success: false, error: 'No label' });
      job.failed++; job.done++;
      continue;
    }
    if (existingTargetNames.has(name.toLowerCase())) {
      job.results.push({ name, success: false, error: 'Already on target' });
      job.skipped++; job.done++;
      continue;
    }
    try {
      const imgUrl = `http://${srcHost}:${srcPort}/api/v1/access/image/${f.id}.jpg?id=${f.id}`;
      const imgRes = await axios.get(imgUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'Referer': `http://${srcHost}:${srcPort}/`, 'Accept': 'application/json, text/plain, */*' },
      });
      const buf = Buffer.from(imgRes.data);
      if (buf.length < 100) throw new Error('empty image from source');

      await uploadFaceBufferToPanel(tgtHost, tgtPort, tgtToken, name, buf);
      job.results.push({ name, success: true });
      job.transferred++;
    } catch (e) {
      job.results.push({ name, success: false, error: e.message });
      job.failed++;
    }
    job.done++;
  }

  job.currentName = null;
  job.stage = 'הושלם';
  job.status = 'done';
  job.finishedAt = Date.now();
}

// Upload a face to a panel from an in-memory image buffer (used for panel-to-panel transfer)
function uploadFaceBufferToPanel(host, port, token, name, imgBuffer) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpImg = path.join(os.tmpdir(), `xferface_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    fs.writeFileSync(tmpImg, imgBuffer);

    const uploadCmd = `curl -s --max-time 20 -X POST ` +
      `-H "Authorization: Bearer ${token}" ` +
      `-F "file=@${tmpImg};type=image/jpeg" ` +
      `"http://${host}:${port}/api/v1/access/image/jpg"`;

    exec(uploadCmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) { fs.unlink(tmpImg, () => {}); return reject(new Error('image upload failed: ' + err.message)); }
      let serverFile;
      try {
        const parsed = JSON.parse(stdout);
        serverFile = parsed?.data?.name || parsed?.data?.filename || parsed?.name || parsed?.data?.face_picture_name || parsed?.data;
      } catch(e) {
        fs.unlink(tmpImg, () => {});
        return reject(new Error('bad image response: ' + (stdout || '').slice(0,100)));
      }
      if (!serverFile) { fs.unlink(tmpImg, () => {}); return reject(new Error('no filename in: ' + (stdout || '').slice(0,100))); }

      const accessBody = JSON.stringify({
        label: name,
        effective_date: Date.now(),
        expired_date: 7258175999000,
        valid_weekdays: [0, 1, 2, 3, 4, 5, 6],
        valid_count: -1,
        facePictureName: serverFile,
        content: serverFile,
        valid_periods: JSON.stringify([{ begin: '00:00:00', end: '23:59:59' }]),
        valid_door: '1',
      });
      const tmpJson = path.join(os.tmpdir(), `xferaccess_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(tmpJson, accessBody);

      const accessCmd = `curl -s --max-time 15 -X POST ` +
        `-H "Authorization: Bearer ${token}" ` +
        `-H "Content-Type: application/json;charset=UTF-8" ` +
        `--data @${tmpJson} ` +
        `"http://${host}:${port}/api/v1/access"`;

      exec(accessCmd, { maxBuffer: 1024 * 1024 }, (err2, stdout2) => {
        fs.unlink(tmpImg, () => {});
        fs.unlink(tmpJson, () => {});
        if (err2) return reject(new Error('access record failed: ' + err2.message));
        try {
          const parsed2 = JSON.parse(stdout2);
          if (parsed2?.status && parsed2.status !== 'OK' && parsed2.status !== 0 && parsed2.status !== '0') {
            return reject(new Error('panel: ' + (parsed2.error || parsed2.status || JSON.stringify(parsed2).slice(0,80))));
          }
          if (parsed2?.error) {
            return reject(new Error('panel: ' + parsed2.error));
          }
        } catch(e) { /* non-JSON, assume ok */ }
        resolve(true);
      });
    });
  });
}


// ==================== RFID CARD MANAGEMENT ====================

// RFID: Login to panel directly (by IP — NOT via NexHome tunnel)
app.post('/api/rfid/login', async (req, res) => {
  try {
    const { panelIp, username, password } = req.body;
    if (!panelIp || !username || !password)
      return res.status(400).json({ success: false, error: 'panelIp, username, password required' });
    const resp = await axios.post(`http://${panelIp}/api/v1/accounts/tokens`,
      { username, password },
      { headers: { 'Content-Type': 'application/json;charset=UTF-8' }, timeout: 8000 }
    );
    if (resp.data?.status !== 'OK') return res.json({ success: false, error: resp.data?.error || 'Login failed' });
    res.json({ success: true, token: resp.data.data.token });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Poll unlock records for new card swipes since a timestamp
app.post('/api/rfid/poll', async (req, res) => {
  try {
    const { panelIp, token, sinceMs } = req.body;
    const resp = await axios.get(
      `http://${panelIp}/api/v1/records/unlock?page_num=1&page_size=50&type=card&label=`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 6000 }
    );
    const records = resp.data?.data?.list || [];
    const newCards = records.filter(r =>
      r.access_type?.toLowerCase() === 'card' && r.unlock_time >= sinceMs
    );
    res.json({ success: true, records: newCards });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Get all saved cards from MongoDB
app.get('/api/rfid/cards', async (req, res) => {
  try {
    const database = await require('./db').connectDB();
    const cards = await database.collection('rfid_cards').find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, cards });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Save a card to MongoDB
app.post('/api/rfid/cards', async (req, res) => {
  try {
    const { cardNumber, firstName, lastName } = req.body;
    if (!cardNumber) return res.status(400).json({ success: false, error: 'cardNumber required' });
    const database = await require('./db').connectDB();
    const existing = await database.collection('rfid_cards').findOne({ cardNumber: cardNumber.toUpperCase() });
    if (existing) return res.json({ success: false, error: 'duplicate', card: existing });
    const result = await database.collection('rfid_cards').insertOne({
      cardNumber: cardNumber.toUpperCase(),
      firstName: (firstName || '').trim(),
      lastName: (lastName || '').trim(),
      createdAt: new Date()
    });
    res.json({ success: true, id: result.insertedId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Update card name
app.patch('/api/rfid/cards/:id', async (req, res) => {
  try {
    const { firstName, lastName } = req.body;
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    await database.collection('rfid_cards').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { firstName: firstName || '', lastName: lastName || '' } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Delete card from MongoDB
app.delete('/api/rfid/cards/:id', async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const database = await require('./db').connectDB();
    await database.collection('rfid_cards').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Upload single card to panel
app.post('/api/rfid/upload-card', async (req, res) => {
  try {
    const { panelIp, token, cardNumber, firstName, lastName } = req.body;
    const label = `${firstName || ''} ${lastName || ''}`.trim() || cardNumber;
    const now = Date.now();
    const body = {
      label,
      effective_date: now,
      expired_date: 7258175999000,
      valid_weekdays: [0,1,2,3,4,5,6],
      valid_count: -1,
      cardNum: cardNumber.toUpperCase(),
      valid_periods: JSON.stringify([{ begin: '00:00:00', end: '23:59:59' }]),
      valid_door: '',      // empty for cards (not '1' — that's for face/relay)
    };
    const resp = await axios.post(`http://${panelIp}/api/v1/access`, body,
      { headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${token}` }, timeout: 8000 }
    );
    if (resp.data?.status !== 'OK') return res.json({ success: false, error: resp.data?.error || 'Upload failed' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Upload all cards from DB to panel
app.post('/api/rfid/upload-all', async (req, res) => {
  try {
    const { panelIp, token } = req.body;
    const database = await require('./db').connectDB();
    const cards = await database.collection('rfid_cards').find({}).toArray();
    let ok = 0, fail = 0, skipped = 0;

    // Get existing cards on panel to skip duplicates
    const listResp = await axios.get(
      `http://${panelIp}/api/v1/access?page_num=1&page_size=500&type=card&label=`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    const existingNums = new Set((listResp.data?.data?.list || []).map(r => (r.card_number || r.content || '').toUpperCase()));

    for (const card of cards) {
      if (existingNums.has(card.cardNumber)) { skipped++; continue; }
      const label = `${card.firstName || ''} ${card.lastName || ''}`.trim() || card.cardNumber;
      try {
        const body = {
          label,
          effective_date: Date.now(),
          expired_date: 7258175999000,
          valid_weekdays: [0,1,2,3,4,5,6],
          valid_count: -1,
          cardNum: card.cardNumber,
          valid_periods: JSON.stringify([{ begin: '00:00:00', end: '23:59:59' }]),
          valid_door: '',
        };
        const resp = await axios.post(`http://${panelIp}/api/v1/access`, body,
          { headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${token}` }, timeout: 8000 }
        );
        if (resp.data?.status === 'OK') ok++; else fail++;
      } catch(e) { fail++; }
    }
    res.json({ success: true, ok, fail, skipped, total: cards.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: Search panel access list and delete cards by name
app.post('/api/rfid/delete-panel-card', async (req, res) => {
  try {
    const { panelIp, token, query } = req.body;
    // Get full access list
    const listResp = await axios.get(
      `http://${panelIp}/api/v1/access?page_num=1&page_size=500&type=card&label=`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    const list = listResp.data?.data?.list || [];
    const matches = list.filter(r => (r.label || '').toLowerCase().includes((query || '').toLowerCase()));
    let deleted = 0, failed = 0;
    for (const m of matches) {
      try {
        await axios.delete(`http://${panelIp}/api/v1/access/${m.id}`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
        );
        deleted++;
      } catch(e) { failed++; }
    }
    res.json({ success: true, found: matches.length, deleted, failed });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RFID: List all cards on the panel
app.post('/api/rfid/panel-cards', async (req, res) => {
  try {
    const { panelIp, token } = req.body;
    const resp = await axios.get(
      `http://${panelIp}/api/v1/access?page_num=1&page_size=500&type=card&label=`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    const list = resp.data?.data?.list || [];
    res.json({ success: true, cards: list, total: list.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// PRICELIST ROUTES
// ============================================================

const plUpload = multer({ storage: multer.memoryStorage() });

function requireManagerAuth(req, res, next) {
  const username = req.body?.username || req.headers['x-manager-user'];
  const password = req.body?.password || req.headers['x-manager-pass'];
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// GET /api/pricelist — ציבורי
app.get('/api/pricelist', async (req, res) => {
  try {
    const database = await require('./db').connectDB();
    const doc = await database.collection('pricelist').findOne({ _id: 'active' });
    res.json(doc || { meta: {}, categories: [], notes: [], logoUrl: null, cols: 4 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pricelist/verify — בדיקת credentials בלבד
app.post('/api/pricelist/verify', requireManagerAuth, async (req, res) => {
  res.json({ ok: true });
});

// POST /api/pricelist/meta
app.post('/api/pricelist/meta', requireManagerAuth, async (req, res) => {
  try {
    const database = await require('./db').connectDB();
    const { meta, notes, cols, categories } = req.body;
    await database.collection('pricelist').updateOne(
      { _id: 'active' },
      { $set: { meta, notes, cols, categories, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pricelist/logo
app.post('/api/pricelist/logo', plUpload.single('logo'), async (req, res) => {
  if(req.body?.username !== process.env.ADMIN_USER || req.body?.password !== process.env.ADMIN_PASS) return res.status(401).json({error:'Unauthorized'});
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { Readable } = require('stream');
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'tador/pricelist', public_id: 'logo', overwrite: true, resource_type: 'image', transformation: [{width:400, crop:'limit', quality:'auto:good', fetch_format:'auto'}] },
        (err, r) => err ? reject(err) : resolve(r)
      );
      Readable.from(req.file.buffer).pipe(stream);
    });
    const database = await require('./db').connectDB();
    await database.collection('pricelist').updateOne(
      { _id: 'active' },
      { $set: { logoUrl: result.secure_url, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ logoUrl: result.secure_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/pricelist/logo
app.delete('/api/pricelist/logo', requireManagerAuth, async (req, res) => {
  try {
    await cloudinary.uploader.destroy('tador/pricelist/logo');
    const database = await require('./db').connectDB();
    await database.collection('pricelist').updateOne({ _id: 'active' }, { $set: { logoUrl: null } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pricelist/product-image/:productId
app.post('/api/pricelist/product-image/:productId', plUpload.single('image'), async (req, res) => {
  if(req.body?.username !== process.env.ADMIN_USER || req.body?.password !== process.env.ADMIN_PASS) return res.status(401).json({error:'Unauthorized'});
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { productId } = req.params;
    const { Readable } = require('stream');
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'tador/pricelist/products', public_id: `product_${productId}`, overwrite: true, resource_type: 'image', transformation: [{width:800, height:800, crop:'limit', quality:'auto:good', fetch_format:'auto'}] },
        (err, r) => err ? reject(err) : resolve(r)
      );
      Readable.from(req.file.buffer).pipe(stream);
    });
    const database = await require('./db').connectDB();
    const doc = await database.collection('pricelist').findOne({ _id: 'active' });
    if (doc && doc.categories) {
      doc.categories.forEach(cat => {
        const p = (cat.products || []).find(p => p.id === productId);
        if (p) p.imgUrl = result.secure_url;
      });
      await database.collection('pricelist').updateOne({ _id: 'active' }, { $set: { categories: doc.categories } });
    }
    res.json({ imgUrl: result.secure_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/pricelist/product-image/:productId
app.delete('/api/pricelist/product-image/:productId', requireManagerAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    await cloudinary.uploader.destroy(`tador/pricelist/products/product_${productId}`);
    const database = await require('./db').connectDB();
    const doc = await database.collection('pricelist').findOne({ _id: 'active' });
    if (doc && doc.categories) {
      doc.categories.forEach(cat => {
        const p = (cat.products || []).find(p => p.id === productId);
        if (p) p.imgUrl = null;
      });
      await database.collection('pricelist').updateOne({ _id: 'active' }, { $set: { categories: doc.categories } });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pricelist/product-gallery/:productId — add an EXTRA image (unique id, appended to images[])
app.post('/api/pricelist/product-gallery/:productId', plUpload.single('image'), async (req, res) => {
  if(req.body?.username !== process.env.ADMIN_USER || req.body?.password !== process.env.ADMIN_PASS) return res.status(401).json({error:'Unauthorized'});
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { productId } = req.params;
    const { Readable } = require('stream');
    const uid = `${productId}_${Date.now()}`;
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'tador/pricelist/gallery', public_id: uid, overwrite: true, resource_type: 'image', transformation: [{width:800, height:800, crop:'limit', quality:'auto:good', fetch_format:'auto'}] },
        (err, r) => err ? reject(err) : resolve(r)
      );
      Readable.from(req.file.buffer).pipe(stream);
    });
    const database = await require('./db').connectDB();
    const doc = await database.collection('pricelist').findOne({ _id: 'active' });
    if (doc && doc.categories) {
      doc.categories.forEach(cat => {
        const p = (cat.products || []).find(p => p.id === productId);
        if (p) { p.images = p.images || []; p.images.push({ url: result.secure_url, pid: `tador/pricelist/gallery/${uid}` }); }
      });
      await database.collection('pricelist').updateOne({ _id: 'active' }, { $set: { categories: doc.categories } });
    }
    res.json({ url: result.secure_url, pid: `tador/pricelist/gallery/${uid}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/pricelist/product-gallery/:productId — remove one extra image by pid
app.delete('/api/pricelist/product-gallery/:productId', requireManagerAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    const { pid } = req.body;
    if (pid) { try { await cloudinary.uploader.destroy(pid); } catch(e) {} }
    const database = await require('./db').connectDB();
    const doc = await database.collection('pricelist').findOne({ _id: 'active' });
    if (doc && doc.categories) {
      doc.categories.forEach(cat => {
        const p = (cat.products || []).find(p => p.id === productId);
        if (p && p.images) p.images = p.images.filter(im => im.pid !== pid);
      });
      await database.collection('pricelist').updateOne({ _id: 'active' }, { $set: { categories: doc.categories } });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================

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
  initNexHomeAccounts();

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
