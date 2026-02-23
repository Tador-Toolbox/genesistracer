const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

// Load data from file or start fresh
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      console.log('✅ Data loaded from data.json');
      return parsed;
    }
  } catch (err) {
    console.log('⚠️ Could not load data.json, starting fresh:', err.message);
  }
  return {
    mainManager: {
      username: 'admin',
      password: crypto.createHash('md5').update('admin123').digest('hex'),
    },
    installers: {},
    loginLogs: [],
  };
}

// Save data to file
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.log('⚠️ Could not save data.json:', err.message);
  }
}

const db = loadData();

// Make sure mainManager always exists (for fresh installs)
if (!db.mainManager) {
  db.mainManager = {
    username: 'admin',
    password: crypto.createHash('md5').update('admin123').digest('hex'),
  };
}
if (!db.installers) db.installers = {};
if (!db.loginLogs) db.loginLogs = [];

function createInstaller(phoneNumber, macAddresses = []) {
  const password = Math.random().toString(36).slice(-8);
  db.installers[phoneNumber] = {
    password: crypto.createHash('md5').update(password).digest('hex'),
    plainPassword: password,
    macAddresses: macAddresses.map(mac => ({
      mac: typeof mac === 'string' ? mac : mac.mac,
      address: typeof mac === 'object' ? mac.address || '' : '',
      notes: typeof mac === 'object' ? mac.notes || '' : '',
      purchaseDate: typeof mac === 'object' ? mac.purchaseDate || '' : '',
      startDate: typeof mac === 'object' ? mac.startDate || '' : '',
      technicianName: typeof mac === 'object' ? mac.technicianName || '' : '',
      description: typeof mac === 'object' ? mac.description || '' : '',
    })),
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };
  saveData();
  return password;
}

function assignMacToInstaller(phoneNumber, macAddress, address = '', notes = '', purchaseDate = '', startDate = '', technicianName = '', description = '') {
  if (!db.installers[phoneNumber]) throw new Error('Installer not found');
  const existingIndex = db.installers[phoneNumber].macAddresses.findIndex(m => m.mac === macAddress);
  const entry = { mac: macAddress, address, notes, purchaseDate, startDate, technicianName, description };
  if (existingIndex === -1) {
    db.installers[phoneNumber].macAddresses.push(entry);
  } else {
    db.installers[phoneNumber].macAddresses[existingIndex] = entry;
  }
  saveData();
}

function removeMacFromInstaller(phoneNumber, macAddress) {
  if (!db.installers[phoneNumber]) throw new Error('Installer not found');
  db.installers[phoneNumber].macAddresses =
    db.installers[phoneNumber].macAddresses.filter(m => m.mac !== macAddress);
  saveData();
}

function loginInstaller(phoneNumber, password) {
  const installer = db.installers[phoneNumber];
  if (!installer) return { success: false, error: 'Installer not found' };

  const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
  if (installer.password !== hashedPassword) return { success: false, error: 'Invalid password' };

  installer.lastLogin = new Date().toISOString();
  db.loginLogs.push({
    phoneNumber,
    timestamp: new Date().toISOString(),
    ip: null,
  });
  saveData();

  return {
    success: true,
    data: {
      phoneNumber,
      macAddresses: installer.macAddresses,
    },
  };
}

function loginManager(username, password) {
  const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
  if (username === db.mainManager.username && hashedPassword === db.mainManager.password) {
    return { success: true };
  }
  return { success: false, error: 'Invalid credentials' };
}

function getInstallers() {
  return Object.entries(db.installers).map(([phoneNumber, data]) => ({
    phoneNumber,
    macCount: data.macAddresses.length,
    createdAt: data.createdAt,
    lastLogin: data.lastLogin,
  }));
}

function getInstallerDetails(phoneNumber) {
  const installer = db.installers[phoneNumber];
  if (!installer) return null;
  return {
    phoneNumber,
    password: installer.plainPassword,
    macAddresses: installer.macAddresses,
    createdAt: installer.createdAt,
    lastLogin: installer.lastLogin,
  };
}

function getLoginLogs() {
  return db.loginLogs.slice().reverse();
}

function deleteInstaller(phoneNumber) {
  delete db.installers[phoneNumber];
  saveData();
}

function resetPassword(phoneNumber) {
  const installer = db.installers[phoneNumber];
  if (!installer) throw new Error('Installer not found');
  const newPassword = Math.random().toString(36).slice(-8);
  installer.password = crypto.createHash('md5').update(newPassword).digest('hex');
  installer.plainPassword = newPassword;
  saveData();
  return newPassword;
}

module.exports = {
  createInstaller,
  assignMacToInstaller,
  removeMacFromInstaller,
  loginInstaller,
  loginManager,
  getInstallers,
  getInstallerDetails,
  getLoginLogs,
  deleteInstaller,
  resetPassword,
};
