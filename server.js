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

/* ===================== NEXHOME LOGIN ===================== */

async function getAuthToken() {
  const hashedPassword = md5(PASSWORD);

  const res = await axios.post(`${NEXHOME_BASE}/api/employees/account/login`, {
    loginName: USERNAME,
    password: hashedPassword
  }, {
    headers: {
      'Content-Type': 'application/json',
      'AppId': APP_ID,
      'Referer': NEXHOME_BASE + '/login',
      'Origin': NEXHOME_BASE,
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
    },
    timeout: 10000
  });

  const data = res.data;
  const token = data?.result?.tokenInfo?.token;
  const employeeAccountId = data?.result?.employeeInfo?.accountId;
  const customerId = data?.result?.employeeInfo?.customerId;
  const engineeringId = data?.result?.employeeInfo?.engineeringId;

  if (!token) throw new Error('Login failed');

  return { token, employeeAccountId, customerId, engineeringId };
}

/* ===================== LOOKUP ===================== */

app.post('/api/lookup', async (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ success: false });

  try {
    const auth = await getAuthToken();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ==================== MANAGEMENT ENDPOINTS ==================== */

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
  try {
    const installers = await db.getInstallers();
    res.json({ success: true, installers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get installer details
app.get('/api/manager/installers/:phoneNumber', async (req, res) => {
  try {
    const installer = await db.getInstallerDetails(req.params.phoneNumber);
    if (!installer) {
      return res.status(404).json({ success: false, error: 'Installer not found' });
    }
    res.json({ success: true, installer });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Assign MAC to installer
app.post('/api/manager/installers/:phoneNumber/macs', async (req, res) => {
  try {
    const { macAddress, address, notes, purchaseDate, startDate, technicianName, description } = req.body;
    const cleanMac = macAddress.replace(/[:\s-]/g, '').toUpperCase();

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
    await db.removeMacFromInstaller(req.params.phoneNumber, req.params.macAddress);
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

// Reset password
app.post('/api/manager/installers/:phoneNumber/reset-password', async (req, res) => {
  try {
    const newPassword = await db.resetPassword(req.params.phoneNumber);
    res.json({ success: true, password: newPassword });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Login logs
app.get('/api/manager/logs', async (req, res) => {
  const logs = await db.getLoginLogs();
  res.json({ success: true, logs });
});

// Installer login
app.post('/api/installer/login', async (req, res) => {
  const { phoneNumber, password } = req.body;
  const result = await db.loginInstaller(phoneNumber, password);

  if (result.success) {
    result.data.ip = req.ip;
  }

  res.json(result);
});

/* ==================== SERVER ==================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('✅ GenesisTracer Server Running');
  console.log(`🌐 Main: http://localhost:${PORT}`);
  console.log(`👨‍💼 Manager: http://localhost:${PORT}/manager.html`);
  console.log(`🔧 Installer: http://localhost:${PORT}/installer.html`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Powered by Tador Technologies LTD');
});
