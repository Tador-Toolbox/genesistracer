const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("❌ Missing MONGODB_URI env var (set it in Render Environment Variables)");
}

const client = new MongoClient(uri);
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

async function createInstaller(phoneNumber, macAddresses = []) {
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
      supplierName: macData.supplierName || "",
      description: macData.description || "",
    };
  });

  await db.collection("installers").insertOne({
    phoneNumber,
    password: hashedPassword,
    plainPassword: password,
    macAddresses: macDocs,
    createdAt: new Date(),
    lastLogin: null,
  });

  return password;
}

async function assignMacToInstaller(
  phoneNumber,
  macAddress,
  address = "",
  notes = "",
  purchaseDate = "",
  startDate = "",
  technicianName = "",
  supplierName = "",
  description = "",
  annualFee = "",
  licensePaid = false
) {
  await connectDB();

  const installer = await db.collection("installers").findOne({ phoneNumber });
  if (!installer) throw new Error("Installer not found");

  const existingMacIndex = (installer.macAddresses || []).findIndex((m) => m.mac === macAddress);

  const updatedMac = { mac: macAddress, address, notes, purchaseDate, startDate, technicianName, supplierName, description, annualFee, licensePaid };

  if (existingMacIndex >= 0) installer.macAddresses[existingMacIndex] = updatedMac;
  else installer.macAddresses = [...(installer.macAddresses || []), updatedMac];

  await db.collection("installers").updateOne({ phoneNumber }, { $set: { macAddresses: installer.macAddresses } });
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
};
