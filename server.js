const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ================== NEXHOME CONFIG ==================
const NEXHOME_BASE = 'https://nexsmart-us.nexhome.ai';
const USERNAME = 'ort_tadorcom';
const PASSWORD = '8vbdQamDznnTkxhk';
const APP_ID = 'INTERNATIONAL_COMMUNITY_MANAGER_WEB';

// ================== HELPERS ==================
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function cleanMac(mac) {
  return String(mac || '').replace(/[:\-\s]/g, '').toUpperCase();
}

// ================== AUTH CACHE ==================
let cachedAuth = null;
let cachedAt = 0;
const AUTH_TTL = 50 * 60 * 1000;

async function getAuth() {
  const now = Date.now();
  if (cachedAuth && (now - cachedAt) < AUTH_TTL) return cachedAuth;

  const res = await axios.post(
    `${NEXHOME_BASE}/api/employees/account/login`,
    {
      loginName: USERNAME,
      password: md5(PASSWORD)
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'AppId': APP_ID,
        'Referer': NEXHOME_BASE + '/login',
        'Origin': NEXHOME_BASE
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
    throw new Error('NexHome login failed');
  }

  cachedAuth = { token, employeeAccountId, customerId, engineeringId };
  cachedAt = now;

  console.log('✅ NexHome Login OK');
  return cachedAuth;
}

function headers(auth, extra = {}) {
  return {
    'Authorization': auth.token,
    'AppId': APP_ID,
    'EmployeeAccountId': auth.employeeAccountId,
    'Customer-Id': auth.customerId,
    'Language': 'en',
    ...extra
  };
}

// ================== LOOKUP ==================
app.post('/api/lookup', async (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ success: false });

  const clean = cleanMac(mac);

  try {
    const auth = await getAuth();

    // 1️⃣ Search MAC
    const macRes = await axios.get(
      `${NEXHOME_BASE}/api/employees/publics/devicelibraries`,
      {
        headers: headers(auth),
        params: {
          page: 0,
          size: 10,
          engineeringId: auth.engineeringId,
          mac: clean
        }
      }
    );

    const macList = macRes.data?.result?.elements || [];
    const macEntry = macList[0];

    if (!macEntry) {
      return res.json({ success: false, error: 'MAC not found' });
    }

    const communityId = macEntry.usedCommunityId || macEntry.communityId;

    // 2️⃣ Get Device Details
    const deviceRes = await axios.get(
      `${NEXHOME_BASE}/api/employees/publics/devices`,
      {
        headers: headers(auth, { 'Community-Id': communityId }),
        params: {
          mac: clean,
          page: 0,
          size: 10
        }
      }
    );

    const deviceList = deviceRes.data?.result?.elements || [];
    const device = deviceList[0];

    if (!device) {
      return res.json({ success: false, error: 'Device not found' });
    }

    // 3️⃣ Reverse Login (IP + Port)
    const reverseRes = await axios.post(
      `${NEXHOME_BASE}/api/employees/publics/devices/${device.id}:reverseLogin`,
      { type: 'WEB' },
      { headers: headers(auth, { 'Community-Id': communityId }) }
    );

    const ip = reverseRes.data?.result?.targetHost || null;
    const port = reverseRes.data?.result?.targetPort || null;

    res.json({
      success: true,
      mac: clean,
      ip: ip || 'Not found',
      port,
      fullAddress: ip && port ? `${ip}:${port}` : 'Not available',
      sn: macEntry.sn || 'N/A',
      project: macEntry.communityName || 'N/A',
      deviceName: device.name || 'N/A',
      deviceType: device.type || 'Door Phone',
      deviceModel: device.model || 'N/A',
      status: device.onlineStatus ?? 'N/A'
    });

  } catch (err) {
    console.log('Lookup error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================== MANAGER FIX ==================
app.post('/api/manager/installers', async (req, res) => {
  try {
    const { phoneNumber, macAddresses } = req.body;
    const password = await db.createInstaller(phoneNumber, macAddresses || []);
    res.json({ success: true, phoneNumber, password });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================== SERVER ==================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log('🚀 GenesisTracer Running');
});
