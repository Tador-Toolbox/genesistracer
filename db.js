const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("❌ Missing MONGODB_URI env var (set it in Render Environment Variables)");
}

const client = new MongoClient(uri, { family: 4 });
let db;

async function connectDB() {
  if (db) return db;

  try {
    await client.connect();
    db = client.db(process.env.MONGODB_DB_NAME || "genesistracer");
    console.log("✅ MongoDB Connected");
    await initDatabase();
    return db;
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err.message);
    throw err;
  }
}

async function initDatabase() {
  try {
    const installersCollection = db.collection("installers");

    await installersCollection.createIndex({ phoneNumber: 1 }, { unique: true });

    const adminUser = process.env.ADMIN_USER || "admin";
    const adminPass = process.env.ADMIN_PASS || "admin123";

    const adminExists = await installersCollection.findOne({ phoneNumber: adminUser });

    if (!adminExists) {
      const adminPasswordHash = crypto.createHash("md5").update(adminPass).digest("hex");
      await installersCollection.insertOne({
        phoneNumber: adminUser,
        password: adminPasswordHash,
        plainPassword: adminPass,
        macAddresses: [],
        createdAt: new Date(),
        lastLogin: null,
      });
      console.log("✅ Admin user created");
    }

    console.log("✅ Database initialized");
  } catch (err) {
    console.error("❌ Database init error:", err.message);
  }
}

async function createInstaller(phoneNumber, macAddresses = [], panelType = "genesis7") {
  await connectDB();

  const password = Math.random().toString(36).slice(-8);
  const hashedPassword = crypto.createHash("md5").update(password).digest("hex");

  const macDocs = macAddresses.map((mac) => {
    const macData = typeof mac === "string" ? { mac } : mac;
    return {
      mac: macData.mac,
      address: macData.address || "",
      notes: macData.notes || "",
      purchaseDate: macData.purchaseDate || "",
      startDate: macData.startDate || "",
      technicianName: macData.technicianName || "",
      technicianPhone: macData.technicianPhone || "",
      supplierName: macData.supplierName || "",
      committeeName: macData.committeeName || "",
      committeePhone: macData.committeePhone || "",
      description: macData.description || "",
      licensesPurchased: macData.licensesPurchased || "",
    };
  });

  await db.collection("installers").insertOne({
    phoneNumber,
    password: hashedPassword,
    plainPassword: password,
    macAddresses: macDocs,
    panelType: panelType || "genesis7",
    createdAt: new Date(),
    lastLogin: null,
  });

  return password;
}

async function assignMacToInstaller(
  phoneNumber,
  macAddress,
  address = "",
  city = "",
  notes = "",
  purchaseDate = "",
  startDate = "",
  technicianName = "",
  technicianPhone = "",
  supplierName = "",
  committeeName = "",
  committeePhone = "",
  description = "",
  annualFee = "",
  licensesPurchased = "",
  licensePaid = false,
  panelType = "genesis7",
  voipbellAccount = ""
) {
  await connectDB();

  const installer = await db.collection("installers").findOne({ phoneNumber });
  if (!installer) throw new Error("Installer not found");

  const existingMacIndex = (installer.macAddresses || []).findIndex((m) => m.mac === macAddress);

  const updatedMac = { mac: macAddress, address, city, notes, purchaseDate, startDate, technicianName, technicianPhone, supplierName, committeeName, committeePhone, description, annualFee, licensesPurchased, licensePaid, panelType, voipbellAccount };

  if (existingMacIndex >= 0) installer.macAddresses[existingMacIndex] = updatedMac;
  else installer.macAddresses = [...(installer.macAddresses || []), updatedMac];

  await db.collection("installers").updateOne({ phoneNumber }, { $set: { macAddresses: installer.macAddresses } });
}

async function updateMacField(phoneNumber, macAddress, field, value) {
  await connectDB();
  const allowedFields = ['description', 'notes', 'address', 'city', 'purchaseDate',
    'startDate', 'annualFee', 'licensesPurchased', 'licensePaid', 'panelType', 'voipbellAccount',
    'technicianName', 'technicianPhone', 'supplierName', 'committeeName', 'committeePhone'];
  if (!allowedFields.includes(field)) throw new Error('Field not allowed: ' + field);

  await db.collection('installers').updateOne(
    { phoneNumber, 'macAddresses.mac': macAddress },
    { $set: { [`macAddresses.$.${field}`]: value } }
  );
}


async function removeMacFromInstaller(phoneNumber, macAddress) {
  await connectDB();
  await db.collection("installers").updateOne({ phoneNumber }, { $pull: { macAddresses: { mac: macAddress } } });
}

async function loginInstaller(phoneNumber, password) {
  await connectDB();

  const installer = await db.collection("installers").findOne({ phoneNumber });
  if (!installer) return { success: false, error: "Installer not found" };

  const hashedPassword = crypto.createHash("md5").update(password).digest("hex");
  if (installer.password !== hashedPassword) return { success: false, error: "Invalid password" };

  await db.collection("installers").updateOne({ phoneNumber }, { $set: { lastLogin: new Date() } });

  await db.collection("loginLogs").insertOne({
    phoneNumber,
    timestamp: new Date(),
    ip: null,
  });

  return {
    success: true,
    data: {
      phoneNumber: installer.phoneNumber,
      macAddresses: installer.macAddresses || [],
    },
  };
}

async function loginManager(username, password) {
  const adminUser = process.env.ADMIN_USER || "admin";
  if (username !== adminUser) return { success: false, error: "Invalid credentials" };

  await connectDB();
  const admin = await db.collection("installers").findOne({ phoneNumber: adminUser });
  if (!admin) return { success: false, error: "Admin not found" };

  const hashedPassword = crypto.createHash("md5").update(password).digest("hex");
  return admin.password === hashedPassword ? { success: true } : { success: false, error: "Invalid credentials" };
}

async function getInstallers() {
  await connectDB();

  const adminUser = process.env.ADMIN_USER || "admin";

  const installers = await db
    .collection("installers")
    .find({ phoneNumber: { $ne: adminUser } })
    .sort({ createdAt: -1 })
    .toArray();

  return installers.map((inst) => ({
    phoneNumber: inst.phoneNumber,
    macCount: (inst.macAddresses || []).length,
    createdAt: inst.createdAt,
    lastLogin: inst.lastLogin,
    installerName: inst.installerName || '',
    accountType: inst.accountType || 'installer',
  }));
}

async function getInstallerDetails(phoneNumber) {
  await connectDB();

  const installer = await db.collection("installers").findOne({ phoneNumber });
  if (!installer) return null;

  return {
    phoneNumber: installer.phoneNumber,
    password: installer.plainPassword,
    macAddresses: installer.macAddresses || [],
    createdAt: installer.createdAt,
    lastLogin: installer.lastLogin,
    managerNote: installer.managerNote || '',
  };
}

async function getLoginLogs() {
  await connectDB();

  const logs = await db.collection("loginLogs").find().sort({ timestamp: -1 }).limit(100).toArray();

  return logs.map((log) => ({
    phoneNumber: log.phoneNumber,
    timestamp: log.timestamp,
    ip: log.ip,
  }));
}

async function deleteInstaller(phoneNumber) {
  await connectDB();
  await db.collection("installers").deleteOne({ phoneNumber });
}

async function resetPassword(phoneNumber) {
  await connectDB();

  const newPassword = Math.random().toString(36).slice(-8);
  const hashedPassword = crypto.createHash("md5").update(newPassword).digest("hex");

  await db.collection("installers").updateOne(
    { phoneNumber },
    { $set: { password: hashedPassword, plainPassword: newPassword } }
  );

  return newPassword;
}

// ==================== DATABASE BACKUP FUNCTION ====================
async function getFullDatabaseBackup() {
  await connectDB();

  const installers = await db.collection("installers").find({}).toArray();
  const loginLogs = await db.collection("loginLogs").find({}).sort({ timestamp: -1 }).limit(1000).toArray();

  return {
    exportDate: new Date().toISOString(),
    version: "2.0",
    database: "genesistracer",
    collections: {
      installers,
      loginLogs
    },
    stats: {
      totalInstallers: installers.length,
      totalLogs: loginLogs.length
    }
  };
}


async function changeInstallerPhone(oldPhoneNumber, newPhoneNumber) {
  await connectDB();

  // Check if new phone number already exists
  const existing = await db.collection("installers").findOne({ phoneNumber: newPhoneNumber });
  if (existing) {
    throw new Error("Phone number already exists");
  }

  // Get the installer
  const installer = await db.collection("installers").findOne({ phoneNumber: oldPhoneNumber });
  if (!installer) {
    throw new Error("Installer not found");
  }

  // Update phone number
  await db.collection("installers").updateOne(
    { phoneNumber: oldPhoneNumber },
    { $set: { phoneNumber: newPhoneNumber } }
  );

  return newPhoneNumber;
}

async function getAutoRebootSchedules() {
  await connectDB();
  const doc = await db.collection("settings").findOne({ key: "autoRebootSchedules" });
  return doc ? doc.value : {};
}

async function saveAutoRebootSchedules(schedules) {
  await connectDB();
  await db.collection("settings").updateOne(
    { key: "autoRebootSchedules" },
    { $set: { key: "autoRebootSchedules", value: schedules, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function updateInstallerPanelType(phoneNumber, panelType) {
  await connectDB();
  await db.collection('installers').updateOne({ phoneNumber }, { $set: { panelType } });
}

// ==================== CATALOG ====================
async function updateInstallerInfo(phoneNumber, fields) {
  await connectDB();
  const allowed = ['installerName', 'voipbellAccount'];
  const update = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) update[key] = fields[key];
  }
  if (Object.keys(update).length === 0) return;
  await db.collection('installers').updateOne({ phoneNumber }, { $set: update });
}


async function updateAccountType(phoneNumber, accountType) {
  await connectDB();
  await db.collection('installers').updateOne(
    { phoneNumber },
    { $set: { accountType } }
  );
}


async function getCatalogUrl() {
  await connectDB();
  const doc = await db.collection("settings").findOne({ key: "catalogUrl" });
  return doc ? doc.value : null;
}

async function setCatalogUrl(url) {
  await connectDB();
  await db.collection("settings").updateOne(
    { key: "catalogUrl" },
    { $set: { key: "catalogUrl", value: url, updatedAt: new Date() } },
    { upsert: true }
  );
}

// ==================== MAILING LIST ====================
async function subscribeToMailingList(name, email) {
  await connectDB();
  const existing = await db.collection("mailingList").findOne({ email });
  if (existing) return { success: false, error: "כבר רשום" };
  await db.collection("mailingList").insertOne({ name, email, subscribedAt: new Date() });
  return { success: true };
}

async function getMailingList() {
  await connectDB();
  return await db.collection("mailingList").find().sort({ subscribedAt: -1 }).toArray();
}

async function removeFromMailingList(email) {
  await connectDB();
  await db.collection("mailingList").deleteOne({ email });
}

// ==================== CHAT ====================
async function getChatMessages(phoneNumber) {
  await connectDB();
  return await db.collection('chat')
    .find({ phoneNumber })
    .sort({ timestamp: 1 })
    .limit(100)
    .toArray();
}

async function sendChatMessage(phoneNumber, from, text) {
  await connectDB();
  const msg = { phoneNumber, from, text: text.trim(), timestamp: new Date(), read: false };
  await db.collection('chat').insertOne(msg);
  return msg;
}

async function markMessagesRead(phoneNumber, from) {
  await connectDB();
  // mark messages NOT from this sender as read
  await db.collection('chat').updateMany(
    { phoneNumber, from: { $ne: from }, read: false },
    { $set: { read: true } }
  );
}

async function getUnreadCount(phoneNumber, from) {
  await connectDB();
  return await db.collection('chat').countDocuments({ phoneNumber, from: { $ne: from }, read: false });
}

async function getAllUnreadCounts() {
  await connectDB();
  const adminUser = process.env.ADMIN_USER || 'admin';
  // count unread messages FROM installer (not read by manager)
  const pipeline = [
    { $match: { from: 'installer', read: false } },
    { $group: { _id: '$phoneNumber', count: { $sum: 1 } } }
  ];
  const results = await db.collection('chat').aggregate(pipeline).toArray();
  const map = {};
  results.forEach(r => { map[r._id] = r.count; });
  return map;
}

async function getAllInstallersWithMacs() {
  await connectDB();
  const adminUser = process.env.ADMIN_USER || 'admin';
  return await db.collection('installers').find({ phoneNumber: { $ne: adminUser } }).sort({ createdAt: -1 }).toArray();
}

async function setManagerNote(phoneNumber, note) {
  await connectDB();
  await db.collection('installers').updateOne({ phoneNumber }, { $set: { managerNote: note } });
}

async function getManagerNote(phoneNumber) {
  await connectDB();
  const inst = await db.collection('installers').findOne({ phoneNumber });
  return inst ? (inst.managerNote || '') : '';
}


// ==================== TUTORIALS ====================
async function getTutorials() {
  await connectDB();
  const doc = await db.collection("settings").findOne({ key: "tutorials" });
  return doc ? (doc.value || []) : [];
}

async function saveTutorials(tutorials) {
  await connectDB();
  await db.collection("settings").updateOne(
    { key: "tutorials" },
    { $set: { key: "tutorials", value: tutorials, updatedAt: new Date() } },
    { upsert: true }
  );
}


// ==================== PORTFOLIO ====================
async function addPortfolioImage(phoneNumber, imageUrl, publicId, description) {
  await connectDB();
  const image = {
    id: crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID(),
    imageUrl,
    publicId,
    description: description || '',
    createdAt: new Date(),
  };
  await db.collection('installers').updateOne(
    { phoneNumber },
    { $push: { portfolio: image } }
  );
  return image;
}

async function getPortfolio(phoneNumber) {
  await connectDB();
  const installer = await db.collection('installers').findOne({ phoneNumber });
  return installer?.portfolio || [];
}

async function deletePortfolioImage(phoneNumber, imageId) {
  await connectDB();
  await db.collection('installers').updateOne(
    { phoneNumber },
    { $pull: { portfolio: { id: imageId } } }
  );
}


// ==================== MANAGER FILE STORAGE ====================
async function addManagerFile(fileObj) {
  await connectDB();
  await db.collection("managerFiles").insertOne(fileObj);
}

async function getManagerFiles() {
  await connectDB();
  return await db.collection("managerFiles").find({}).sort({ uploadedAt: -1 }).toArray();
}

async function updateManagerFileTitle(publicId, title) {
  await connectDB();
  await db.collection("managerFiles").updateOne({ publicId }, { $set: { title } });
}


async function deleteManagerFile(publicId) {
  await connectDB();
  await db.collection("managerFiles").deleteOne({ publicId });
}


// ==================== MERGE ACCOUNTS ====================
async function mergeInstallers(primaryPhone, secondaryPhone) {
  await connectDB();

  const primary   = await db.collection('installers').findOne({ phoneNumber: primaryPhone });
  const secondary = await db.collection('installers').findOne({ phoneNumber: secondaryPhone });

  if (!primary)   throw new Error('Primary account not found');
  if (!secondary) throw new Error('Secondary account not found');

  const primaryMacs   = primary.macAddresses   || [];
  const secondaryMacs = secondary.macAddresses || [];

  // Merge MACs — skip duplicates
  const existingMacSet = new Set(primaryMacs.map(m => m.mac));
  const newMacs = secondaryMacs.filter(m => !existingMacSet.has(m.mac));
  const mergedMacs = [...primaryMacs, ...newMacs];

  // Update primary with merged MACs
  await db.collection('installers').updateOne(
    { phoneNumber: primaryPhone },
    { $set: { macAddresses: mergedMacs } }
  );

  // Transfer chat messages
  await db.collection('chat').updateMany(
    { phoneNumber: secondaryPhone },
    { $set: { phoneNumber: primaryPhone } }
  );

  // Transfer login logs
  await db.collection('loginLogs').updateMany(
    { phoneNumber: secondaryPhone },
    { $set: { phoneNumber: primaryPhone } }
  );

  // Delete secondary account
  await db.collection('installers').deleteOne({ phoneNumber: secondaryPhone });

  return { mergedMacs: newMacs.length, total: mergedMacs.length };
}

module.exports = {
  connectDB,
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
  getFullDatabaseBackup,
  changeInstallerPhone,
  updateMacField,
  mergeInstallers,
  getAutoRebootSchedules,
  saveAutoRebootSchedules,
  updateInstallerPanelType,
  updateInstallerInfo,
  updateAccountType,
  getCatalogUrl,
  setCatalogUrl,
  getTutorials,
  addPortfolioImage,
  getPortfolio,
  deletePortfolioImage,
  saveTutorials,
  addManagerFile,
  getManagerFiles,
  deleteManagerFile,
  updateManagerFileTitle,
  subscribeToMailingList,
  getMailingList,
  removeFromMailingList,
  getAllInstallersWithMacs,
  setManagerNote,
  getManagerNote,
  getChatMessages,
  sendChatMessage,
  markMessagesRead,
  getUnreadCount,
  getAllUnreadCounts,
};
