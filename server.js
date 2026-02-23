const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const NEXHOME_BASE = 'https://nexsmart-us.nexhome.ai';
const USERNAME = 'ort_tadorcom';
const PASSWORD = '5uWRg8sR';
const APP_ID = 'INTERNATIONAL_COMMUNITY_MANAGER_WEB';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function getAuthToken() {
  const hashedPassword = md5(PASSWORD);
  console.log('Logging in...');

  const res = await axios.post(`${NEXHOME_BASE}/api/employees/account/login`, {
    loginName: USERNAME,
    password: hashedPassword
  }, {
    headers: {
      'Content-Type': 'application/json',
      'AppId': APP_ID,
      'Referer': NEXHOME_BASE + '/login',
      'Origin': NEXHOME_BASE,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
    },
    timeout: 10000
  });

  const data = res.data;
  console.log('Login response:', JSON.stringify(data).substring(0, 400));

  const token = data?.result?.tokenInfo?.token;
  const employeeAccountId = data?.result?.employeeInfo?.accountId;
  const customerId = data?.result?.employeeInfo?.customerId;
  const engineeringId = data?.result?.employeeInfo?.engineeringId;

  if (!token) throw new Error('Login failed: ' + JSON.stringify(data));

  console.log('✅ Login success!');
  console.log('   Token:', token.substring(0, 20) + '...');
  console.log('   EmployeeAccountId:', employeeAccountId);
  console.log('   CustomerId:', customerId);
  console.log('   EngineeringId:', engineeringId);

  return { token, employeeAccountId, customerId, engineeringId };
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
    NEXHOME_BASE + '/api/device/mac/list',
  ];

  for (const url of endpoints) {
    try {
      const fullUrl = url.includes('?') ? url + '&mac=' + mac : url;
      const params = url.includes('?') ? {} : { mac, pageNum: 1, pageSize: 10 };
      const res = await axios.get(fullUrl, { params, headers, timeout: 10000 });
      console.log('MAC (' + url.split('?')[0] + '):', JSON.stringify(res.data).substring(0, 500));
      if (res.data?.code === '0' || (res.data?.code !== 'SYS_1' && res.data?.code !== 'SYS_0050')) return res.data;
    } catch (err) {
      console.log('MAC error:', err.message);
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
    console.log('Getting device details from:', url);
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
      timeout: 10000 
    });
    console.log('Device response:', JSON.stringify(res.data).substring(0, 600));
    return res.data;
  } catch (err) {
    console.log('Device error:', err.message);
    console.log('Status:', err.response?.status);
    console.log('Response:', JSON.stringify(err.response?.data).substring(0, 300));
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
    console.log('Getting reverse login info from:', url);
    console.log('Using Community-Id:', communityId);
    const res = await axios.post(url, { type: 'WEB' }, { headers, timeout: 10000 });
    console.log('Reverse login response:', JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.log('Reverse login error:', err.message);
    console.log('Status:', err.response?.status);
    console.log('Response:', JSON.stringify(err.response?.data).substring(0, 300));
    return null;
  }
}

function pick(obj, ...keys) {
  if (!obj) return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

app.post('/api/lookup', async (req, res) => {
  const { mac } = req.body;
  if (!mac || !mac.trim()) return res.status(400).json({ success: false, error: 'MAC address is required' });

  const cleanMac = mac.replace(/[:\-\s]/g, '').toUpperCase();
  console.log('\n=== Lookup:', cleanMac, '===');

  try {
    const auth = await getAuthToken();
    const macData = await searchMac(auth, cleanMac);
    
    // Extract communityId from MAC library response
    const macList = macData?.result?.elements || macData?.result?.list || [];
    const macEntry = macList[0] || null;
    
    if (!macEntry) {
      return res.json({ success: false, error: 'No device found with this MAC address in MAC library' });
    }

    const communityId = macEntry.usedCommunityId || macEntry.communityId;
    console.log('Community ID:', communityId);
    
    // Get device details to retrieve device ID
    const deviceData = await getDeviceByMac(auth, cleanMac, communityId);
    const deviceList = deviceData?.result?.elements || deviceData?.result?.list || [];
    const deviceEntry = deviceList[0] || null;
    
    if (!deviceEntry) {
      return res.json({ success: false, error: 'No device found in device list' });
    }
    
    const deviceId = deviceEntry.id;
    console.log('Device ID:', deviceId);
    
    // Get IP and port from reverse login endpoint
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
      sn: macEntry.sn || deviceEntry.mac,
      project: macEntry.communityName || deviceEntry.communityName,
      deviceName: deviceEntry.name || macEntry.communityName,
      deviceType: deviceEntry.type || 'Door Phone',
      deviceModel: deviceEntry.model || 'T98',
      status: deviceEntry.onlineStatus || macEntry.status,
      building: deviceEntry.buildingName || null,
      apartment: deviceEntry.roomNumber || null,
      _raw: { macEntry, deviceEntry, reverseLoginData }
    });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/debug/:mac', async (req, res) => {
  try {
    const auth = await getAuthToken();
    const macData = await searchMac(auth, req.params.mac.toUpperCase());
    const macList = macData?.result?.elements || macData?.result?.list || [];
    const communityId = macList[0]?.usedCommunityId || macList[0]?.communityId;
    const deviceData = communityId ? await getDeviceByMac(auth, req.params.mac.toUpperCase(), communityId) : null;
    const deviceList = deviceData?.result?.elements || deviceData?.result?.list || [];
    const deviceId = deviceList[0]?.id;
    const reverseLoginData = (deviceId && communityId) ? await getReverseLoginInfo(auth, deviceId, communityId) : null;
    res.json({ success: true, macData, deviceData, reverseLoginData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== MANAGEMENT ENDPOINTS ====================

// Manager login
app.post('/api/manager/login', (req, res) => {
  const { username, password } = req.body;
  const result = db.loginManager(username, password);
  res.json(result);
});

// Create installer account
app.post('/api/manager/installers', (req, res) => {
  try {
    const { phoneNumber, macAddresses } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    const password = db.createInstaller(phoneNumber, macAddresses || []);
    res.json({ success: true, phoneNumber, password });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all installers
app.get('/api/manager/installers', (req, res) => {
  const installers = db.getInstallers();
  res.json({ success: true, installers });
});

// Get installer details
app.get('/api/manager/installers/:phoneNumber', (req, res) => {
  const installer = db.getInstallerDetails(req.params.phoneNumber);
  if (!installer) {
    return res.status(404).json({ success: false, error: 'Installer not found' });
  }
  res.json({ success: true, installer });
});

// Assign MAC to installer
app.post('/api/manager/installers/:phoneNumber/macs', (req, res) => {
  try {
    const { macAddress, address, notes, purchaseDate, startDate, technicianName } = req.body;
    const cleanMac = macAddress.replace(/[:\s-]/g, '').toUpperCase();
    db.assignMacToInstaller(req.params.phoneNumber, cleanMac, address, notes, purchaseDate, startDate, technicianName);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Remove MAC from installer
app.delete('/api/manager/installers/:phoneNumber/macs/:macAddress', (req, res) => {
  try {
    db.removeMacFromInstaller(req.params.phoneNumber, req.params.macAddress);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete installer
app.delete('/api/manager/installers/:phoneNumber', (req, res) => {
  db.deleteInstaller(req.params.phoneNumber);
  res.json({ success: true });
});

// Reset installer password
app.post('/api/manager/installers/:phoneNumber/reset-password', (req, res) => {
  try {
    const newPassword = db.resetPassword(req.params.phoneNumber);
    res.json({ success: true, password: newPassword });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get login logs
app.get('/api/manager/logs', (req, res) => {
  const logs = db.getLoginLogs();
  res.json({ success: true, logs });
});

// Installer saves description for a MAC
app.post('/api/installer/description', (req, res) => {
  try {
    const { phoneNumber, mac, description } = req.body;
    const details = db.getInstallerDetails(phoneNumber);
    if (!details) return res.status(404).json({ success: false, error: 'Installer not found' });
    const existing = details.macAddresses.find(m => m.mac === mac);
    if (!existing) return res.status(404).json({ success: false, error: 'MAC not found' });
    db.assignMacToInstaller(
      phoneNumber, mac,
      existing.address || '', existing.notes || '',
      existing.purchaseDate || '', existing.startDate || '',
      existing.technicianName || '', description
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Installer login
app.post('/api/installer/login', (req, res) => {
  const { phoneNumber, password } = req.body;
  const result = db.loginInstaller(phoneNumber, password);
  if (result.success) {
    result.data.ip = req.ip;
  }
  res.json(result);
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
