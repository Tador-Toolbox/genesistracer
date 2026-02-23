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
    const { phoneNumber, macAddresses } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    const password = await db.createInstaller(phoneNumber, macAddresses || []);
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
      notes = '',
      purchaseDate = '',
      startDate = '',
      technicianName = '',
      description = '',
    } = req.body;

    const cleanMac = (macAddress || '').replace(/[:\s-]/g, '').toUpperCase();
    if (!cleanMac) return res.status(400).json({ success: false, error: 'macAddress required' });

    await db.assignMacToInstaller(
      req.params.phoneNumber,
      cleanMac,
      address,
      notes,
      purchaseDate,
      startDate,
      technicianName,
      description
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

// Installer saves description
app.post('/api/installer/description', async (req, res) => {
  try {
    const { phoneNumber, mac, description } = req.body;
    const details = await db.getInstallerDetails(phoneNumber);
    if (!details) return res.status(404).json({ success: false, error: 'Installer not found' });

    const cleanMac = (mac || '').replace(/[:\s-]/g, '').toUpperCase();
    const existing = (details.macAddresses || []).find(m => m.mac === cleanMac);

    if (!existing) return res.status(404).json({ success: false, error: 'MAC not found' });

    await db.assignMacToInstaller(
      phoneNumber,
      cleanMac,
      existing.address || '',
      existing.notes || '',
      existing.purchaseDate || '',
      existing.startDate || '',
      existing.technicianName || '',
      description || ''
    );

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
});
