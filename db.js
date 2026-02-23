const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb+srv://ort_db_user:1FWfAYSHuW4XqXoh@genesistracer.dezqrol.mongodb.net/?retryWrites=true&w=majority&appName=genesistracer';
const client = new MongoClient(uri);

let db;

async function connectDB() {
  if (db) return db;
  try {
    await client.connect();
    db = client.db('genesistracer');
    console.log('✅ MongoDB Connected');
    await initDatabase();
    return db;
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    throw err;
  }
}

async function initDatabase() {
  try {
    const installersCollection = db.collection('installers');
    
    // Create indexes
    await installersCollection.createIndex({ phoneNumber: 1 }, { unique: true });
    
    // Create admin user if doesn't exist
    const adminExists = await installersCollection.findOne({ phoneNumber: 'admin' });
    if (!adminExists) {
      const adminPassword = crypto.createHash('md5').update('admin123').digest('hex');
      await installersCollection.insertOne({
        phoneNumber: 'admin',
        password: adminPassword,
        plainPassword: 'admin123',
        macAddresses: [],
        createdAt: new Date(),
        lastLogin: null
      });
      console.log('✅ Admin user created');
    }
    
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
}

async function createInstaller(phoneNumber, macAddresses = []) {
  await connectDB();
  const password = Math.random().toString(36).slice(-8);
  const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
  
  const macDocs = macAddresses.map(mac => {
    const macData = typeof mac === 'string' ? { mac } : mac;
    return {
      mac: macData.mac,
      address: macData.address || '',
      notes: macData.notes || '',
      purchaseDate: macData.purchaseDate || '',
      startDate: macData.startDate || '',
      technicianName: macData.technicianName || '',
      description: macData.description || ''
    };
  });
  
  await db.collection('installers').insertOne({
    phoneNumber,
    password: hashedPassword,
    plainPassword: password,
    macAddresses: macDocs,
    createdAt: new Date(),
    lastLogin: null
  });
  
  return password;
}

async function assignMacToInstaller(phoneNumber, macAddress, address = '', notes = '', purchaseDate = '', startDate = '', technicianName = '', description = '') {
  await connectDB();
  
  const installer = await db.collection('installers').findOne({ phoneNumber });
  if (!installer) throw new Error('Installer not found');
  
  const existingMacIndex = installer.macAddresses.findIndex(m => m.mac === macAddress);
  
  if (existingMacIndex >= 0) {
    installer.macAddresses[existingMacIndex] = {
      mac: macAddress,
      address,
      notes,
      purchaseDate,
      startDate,
      technicianName,
      description
    };
  } else {
    installer.macAddresses.push({
      mac: macAddress,
      address,
      notes,
      purchaseDate,
      startDate,
      technicianName,
      description
    });
  }
  
  await db.collection('installers').updateOne(
    { phoneNumber },
    { $set: { macAddresses: installer.macAddresses } }
  );
}

async function removeMacFromInstaller(phoneNumber, macAddress) {
  await connectDB();
  
  await db.collection('installers').updateOne(
    { phoneNumber },
    { $pull: { macAddresses: { mac: macAddress } } }
  );
}

async function loginInstaller(phoneNumber, password) {
  await connectDB();
  
  const installer = await db.collection('installers').findOne({ phoneNumber });
  if (!installer) {
    return { success: false, error: 'Installer not found' };
  }
  
  const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
  if (installer.password !== hashedPassword) {
    return { success: false, error: 'Invalid password' };
  }
  
  await db.collection('installers').updateOne(
    { phoneNumber },
    { $set: { lastLogin: new Date() } }
  );
  
  await db.collection('loginLogs').insertOne({
    phoneNumber,
    timestamp: new Date(),
    ip: null
  });
  
  return {
    success: true,
    data: {
      phoneNumber: installer.phoneNumber,
      macAddresses: installer.macAddresses || []
    }
  };
}

async function loginManager(username, password) {
  if (username !== 'admin') {
    return { success: false, error: 'Invalid credentials' };
  }
  
  await connectDB();
  const admin = await db.collection('installers').findOne({ phoneNumber: 'admin' });
  
  if (!admin) {
    return { success: false, error: 'Admin not found' };
  }
  
  const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
  if (admin.password === hashedPassword) {
    return { success: true };
  }
  
  return { success: false, error: 'Invalid credentials' };
}

async function getInstallers() {
  await connectDB();
  
  const installers = await db.collection('installers')
    .find({ phoneNumber: { $ne: 'admin' } })
    .sort({ createdAt: -1 })
    .toArray();
  
  return installers.map(inst => ({
    phoneNumber: inst.phoneNumber,
    macCount: (inst.macAddresses || []).length,
    createdAt: inst.createdAt,
    lastLogin: inst.lastLogin
  }));
}

async function getInstallerDetails(phoneNumber) {
  await connectDB();
  
  const installer = await db.collection('installers').findOne({ phoneNumber });
  if (!installer) return null;
  
  return {
    phoneNumber: installer.phoneNumber,
    password: installer.plainPassword,
    macAddresses: installer.macAddresses || [],
    createdAt: installer.createdAt,
    lastLogin: installer.lastLogin
  };
}

async function getLoginLogs() {
  await connectDB();
  
  const logs = await db.collection('loginLogs')
    .find()
    .sort({ timestamp: -1 })
    .limit(100)
    .toArray();
  
  return logs.map(log => ({
    phoneNumber: log.phoneNumber,
    timestamp: log.timestamp,
    ip: log.ip
  }));
}

async function deleteInstaller(phoneNumber) {
  await connectDB();
  await db.collection('installers').deleteOne({ phoneNumber });
}

async function resetPassword(phoneNumber) {
  await connectDB();
  
  const newPassword = Math.random().toString(36).slice(-8);
  const hashedPassword = crypto.createHash('md5').update(newPassword).digest('hex');
  
  await db.collection('installers').updateOne(
    { phoneNumber },
    { 
      $set: { 
        password: hashedPassword, 
        plainPassword: newPassword 
      } 
    }
  );
  
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
