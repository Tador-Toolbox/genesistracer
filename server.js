const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==================== NEXHOME CONFIG ====================
const NEXHOME_BASE = 'https://nexsmart-us.nexhome.ai';
const USERNAME = 'ort_tadorcom';

// ✅ TEMP PASSWORD (you said you'll change later)
const PASSWORD = '8vbdQamDznnTkxhk';

const APP_ID = 'INTERNATIONAL_COMMUNITY_MANAGER_WEB';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// In-memory auth cache (speeds up a LOT)
let authCache = {
  value: null,
  expiresAt: 0
};

function isAuthValid() {
  return authCache.value && Date.now() < authCache.expiresAt;
}

async function loginToNexhome(useMd5) {
  const passToSend = useMd5 ? md5(PASSWORD) : PASSWORD;

  const res = await axios.post(
    `${NEXHOME_BASE}/api/employees/account/login`,
    {
      loginName: USERNAME,
      password: passToSend
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'AppId': APP_ID,
        'Referer': NEXHOME_BASE + '/login',
        'Origin': NEXHOME_BASE,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: 15000
    }
  );

  const data = res.data;
  const token = data?.result?.tokenInfo?.token;
  const employeeAccountId = data?.result?.employeeInfo?.accountId;
  const customerId = data?.result?.employeeInfo?.customerId;
  const engineeringId = data?.result?.employeeInfo?.engineeringId;

  if (!token) {
    // Provide better error message for UI/logs
    const msg =
      data?.message ||
      data?.msg ||
      data?.code ||
      'Login failed (no token returned)';
    throw new Error(`NexHome login failed: ${msg}`);
  }

  return { token, employeeAccountId, customerId, engineeringId };
}

async function getAuthToken() {
  // Use cache
  if (isAuthValid()) return authCache.value;

  console.log('Logging in to NexHome...');

  // Try MD5 first, if fails -> try plain password
  try {
    const auth = await loginToNexhome(true);
    authCache.value = auth;
    authCache.expiresAt = Date.now() + 20 * 60 * 1000; // 20 minutes
    console.log('✅ NexHome login success (MD5).');
    return auth;
  } catch (e1) {
    console.log('⚠️ NexHome login (MD5) failed, trying plain password...');
    const auth = await loginToNexhome(false);
    authCache.value = auth;
    authCache.expiresAt = Date.now() + 20 * 60 * 1000;
    console.log('✅ NexHome login success (PLAIN).');
    return auth;
  }
}

async function searchMac(auth, mac) {
  const headers = {
    'Authorization': auth.token,
    'AppId': APP_ID,
    'Version': '1.0.0',
    'ApiVersion': '1.0',
    'Language': 'en',
    'EmployeeAccountId': auth.employeeAccountId,
    'Customer-Id': auth.customerId,
    'RequestId': crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json, text/plain, */*'
  };

  const endpoints = [
    NEXHOME_BASE + '/api/employees/publics/devicelibraries?page=0&size=10&engineeringId=' + auth.engineeringId,
    NEXHOME_BASE + '/api/employees/device/mac/list',
    NEXHOME_BASE + '/api/device/mac/list'
  ];

  for (const url of endpoints) {
    try {
      const fullUrl = url.includes('?') ? url + '&mac=' + mac : url;
      const params = url.includes('?') ? {} : { mac, pageNum: 1, pageSize: 10 };
      const res = await axios.get(fullUrl, { params, headers, timeout: 15000 });

      // if response seems valid, return it
      if (res.data?.code === '0' || (res.data?.code && res.data?.code !== 'SYS_1' && res.data?.code !== 'SYS_0050')) {
        return res.data;
      }
    } catch (err) {
      console.log('MAC endpoint error:', url, err.message);
    }
  }

  return null;
}

async function getDeviceByMac(auth, mac, communityId) {
  const headers = {
    'Authorization': auth.token,
    'AppId': APP_ID,
    'Version': '1.0',
    'Apiversion': '1.0',
    'Language': 'en',
    'Community-Id': communityId,
    'Customer-Id': auth.customerId,
    'EmployeeAccountId': auth.employeeAccountId,
    'RequestId': crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json'
  };

  const url = `${NEXHOME_BASE}/api/employees/publics/devices`;

  try {
    const res = await axios.get(url, {
      params: {
        type: '2,3,7,8,9',
        size: 10,
        page: 0,
        isReload: true,
        mac: mac,
        isCloudEnabled: true
      },
      headers,
      timeout: 15000
    });
    return res.data;
  } catch (err) {
    console.log('Device error:', err.message);
    return null;
  }
}

async function getReverseLoginInfo(auth, deviceId, communityId) {
  const headers = {
    'Authorization': auth.token,
    'AppId': APP_ID,
    'Version': '1.0',
    'Apiversion': '1.0',
    'Language': 'en',
    'Community-Id': communityId,
    'Customer-Id': auth.customerId,
    'EmployeeAccountId': auth.employeeAccountId,
    'RequestId': crypto.randomUUID(),
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
    'Content-Type': 'application/json; charset=UTF-8'
  };

  const url = `${NEXHOME_BASE}/api/employees/publics/devices/${deviceId}:reverseLogin`;

  try {
    const res = await axios.post(url, { type: 'WEB' }, { headers, timeout: 15000 });
    return res.data;
  } catch (err) {
    console.log('Reverse login error:', err.message);
    return null;
  }
}

// ==================== LOOKUP API ====================

app.post('/api/lookup', async (req, res) => {
  const { mac } = req.body;
  if (!mac || !mac.trim()) return res.status(400).json({ success: false, error: 'MAC address is required' });

  const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();
  console.log('\n=== Lookup:', cleanMac, '===');

  try {
    const auth = await getAuthToken();

    const macData = await searchMac(auth, cleanMac);
    if (!macData) {
      return res.json({ success: false, error: 'MAC search failed (no response)' });
    }

    const macList = macData?.result?.elements || macData?.result?.list || [];
    const macEntry = macList[0] || null;

    if (!macEntry) {
      return res.json({ success: false, error: 'No device found with this MAC in MAC library' });
    }

    const communityId = macEntry.usedCommunityId || macEntry.communityId;
    if (!communityId) {
      return res.json({ success: false, error: 'Community ID not found for this MAC' });
    }

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
    const fullAddress = ip && port ? `${ip}:${port}` : ip;

    return res.json({
      success: true,
      mac: cleanMac,
      ip: ip || 'Not found',
      port: port || null,
      fullAddress: fullAddress || 'Not available',
      sn: macEntry.sn || deviceEntry.mac || 'N/A',
      project: macEntry.communityName || deviceEntry.communityName || 'N/A',
      deviceName: deviceEntry.name || macEntry.communityName || 'N/A',
      deviceType: deviceEntry.type || 'Door Phone',
      deviceModel: deviceEntry.model || 'T98',
      status: deviceEntry.onlineStatus || macEntry.status || 'N/A',
      building: deviceEntry.buildingName || null,
      apartment: deviceEntry.roomNumber || null
    });

  } catch (err) {
    console.error('Lookup Error:', err.message);

    // If token might be expired or bad, clear cache so next try relogs
    if (String(err.message || '').toLowerCase().includes('login') || String(err.message || '').toLowerCase().includes('token')) {
      authCache.value = null;
      authCache.expiresAt = 0;
    }

    return res.status(500).json({ success: false, error: err.message });
  }
});

// Debug endpoint (works on: /api/debug/<MAC>)
app.get('/api/debug/:mac', async (req, res) => {
  try {
    const auth = await getAuthToken();
    const mac = req.params.mac.replace(/[:\-\s]/g, '').toUpperCase();

    const macData = await searchMac(auth, mac);
    const macList = macData?.result?.elements || macData?.result?.list || [];
    const communityId = macList[0]?.usedCommunityId || macList[0]?.communityId;

    const deviceData = communityId ? await getDeviceByMac(auth, mac, communityId) : null;
    const deviceList = deviceData?.result?.elements || deviceData?.result?.list || [];
    const deviceId = deviceList[0]?.id;

    const reverseLoginData = (deviceId && communityId) ? await getReverseLoginInfo(auth, deviceId, communityId) : null;

    res.json({ success: true, mac, communityId, macData, deviceData, reverseLoginData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== MANAGEMENT ENDPOINTS ====================

// Manager login
app.post('/api/manager/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await db.loginManager(username, password);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create installer account  ✅ FIXED: await db.createInstaller
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

// Get all installers ✅ FIXED: await
app.get('/api/manager/installers', async (req, res) => {
  try {
    const installers = await db.getInstallers();
    res.json({ success: true, installers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get installer details ✅ FIXED: await
app.get('/api/manager/installers/:phoneNumber', async (req, res) => {
  try {
    const installer = await db.getInstallerDetails(req.params.phoneNumber);
    if (!installer) return res.status(404).json({ success: false, error: 'Installer not found' });
    res.json({ success: true, installer });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Assign MAC to installer ✅ FIXED: await
app.post('/api/manager/installers/:phoneNumber/macs', async (req, res) => {
  try {
    const { macAddress, address, notes, purchaseDate, startDate, technicianName, description } = req.body;
    if (!macAddress) return res.status(400).json({ success: false, error: 'macAddress required' });

    const cleanMac = macAddress.replace(/[:\s-]/g, '').toUpperCase();

    await db.assignMacToInstaller(
      req.params.phoneNumber,
      cleanMac,
      address || '',
      notes || '',
      purchaseDate || '',
      startDate || '',
      technicianName || '',
      description || ''
    );

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Remove MAC ✅ FIXED: await
app.delete('/api/manager/installers/:phoneNumber/macs/:macAddress', async (req, res) => {
  try {
    const cleanMac = req.params.macAddress.replace(/[:\s-]/g, '').toUpperCase();
    await db.removeMacFromInstaller(req.params.phoneNumber, cleanMac);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete installer ✅ FIXED: await
app.delete('/api/manager/installers/:phoneNumber', async (req, res) => {
  try {
    await db.deleteInstaller(req.params.phoneNumber);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset installer password ✅ FIXED: await
app.post('/api/manager/installers/:phoneNumber/reset-password', async (req, res) => {
  try {
    const newPassword = await db.resetPassword(req.params.phoneNumber);
    res.json({ success: true, password: newPassword });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get login logs ✅ FIXED: await
app.get('/api/manager/logs', async (req, res) => {
  try {
    const logs = await db.getLoginLogs();
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Installer saves description for a MAC ✅ FIXED: await
app.post('/api/installer/description', async (req, res) => {
  try {
    const { phoneNumber, mac, description } = req.body;
    const details = await db.getInstallerDetails(phoneNumber);
    if (!details) return res.status(404).json({ success: false, error: 'Installer not found' });

    const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();
    const existing = (details.macAddresses || []).find(m => (m.mac || '').toUpperCase() === cleanMac);
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

// Installer login ✅ FIXED: await
app.post('/api/installer/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;
    const result = await db.loginInstaller(phoneNumber, password);
    if (result.success) result.data.ip = req.ip;
    res.json(result);
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
  console.log('Powered by Tador Technologies LTD');
});
