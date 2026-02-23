const crypto = require('crypto');
const mysql = require('mysql2/promise');

// MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'sql123.biz.nf',
  user: process.env.DB_USER || '1236412_ort',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || '1236412_genesistracer',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database tables
async function initDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS installers (
        phone_number VARCHAR(50) PRIMARY KEY,
        password VARCHAR(255) NOT NULL,
        plain_password VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS mac_addresses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone_number VARCHAR(50),
        mac VARCHAR(50) NOT NULL,
        address TEXT,
        notes TEXT,
        purchase_date VARCHAR(50),
        start_date VARCHAR(50),
        technician_name VARCHAR(255),
        description TEXT,
        UNIQUE KEY unique_mac (phone_number, mac),
        FOREIGN KEY (phone_number) REFERENCES installers(phone_number) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone_number VARCHAR(50),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip VARCHAR(50)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Create admin user if doesn't exist
    const [adminCheck] = await connection.query(
      'SELECT * FROM installers WHERE phone_number = ?',
      ['admin']
    );
    
    if (adminCheck.length === 0) {
      const adminPassword = crypto.createHash('md5').update('admin123').digest('hex');
      await connection.query(
        'INSERT INTO installers (phone_number, password, plain_password) VALUES (?, ?, ?)',
        ['admin', adminPassword, 'admin123']
      );
      console.log('✅ Admin user created');
    }

    console.log('✅ MySQL Database initialized');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  } finally {
    connection.release();
  }
}

initDatabase();

async function createInstaller(phoneNumber, macAddresses = []) {
  const password = Math.random().toString(36).slice(-8);
  const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
  
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    await connection.query(
      'INSERT INTO installers (phone_number, password, plain_password, created_at) VALUES (?, ?, ?, NOW())',
      [phoneNumber, hashedPassword, password]
    );

    for (const mac of macAddresses) {
      const macData = typeof mac === 'string' ? { mac } : mac;
      await connection.query(
        `INSERT INTO mac_addresses (phone_number, mac, address, notes, purchase_date, start_date, technician_name, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          phoneNumber,
          macData.mac,
          macData.address || '',
          macData.notes || '',
          macData.purchaseDate || '',
          macData.startDate || '',
          macData.technicianName || '',
          macData.description || ''
        ]
      );
    }

    await connection.commit();
    return password;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function assignMacToInstaller(phoneNumber, macAddress, address = '', notes = '', purchaseDate = '', startDate = '', technicianName = '', description = '') {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      `INSERT INTO mac_addresses (phone_number, mac, address, notes, purchase_date, start_date, technician_name, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         address = VALUES(address),
         notes = VALUES(notes),
         purchase_date = VALUES(purchase_date),
         start_date = VALUES(start_date),
         technician_name = VALUES(technician_name),
         description = VALUES(description)`,
      [phoneNumber, macAddress, address, notes, purchaseDate, startDate, technicianName, description]
    );
  } finally {
    connection.release();
  }
}

async function removeMacFromInstaller(phoneNumber, macAddress) {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      'DELETE FROM mac_addresses WHERE phone_number = ? AND mac = ?',
      [phoneNumber, macAddress]
    );
  } finally {
    connection.release();
  }
}

async function loginInstaller(phoneNumber, password) {
  const connection = await pool.getConnection();
  try {
    const [installers] = await connection.query(
      'SELECT * FROM installers WHERE phone_number = ?',
      [phoneNumber]
    );

    if (installers.length === 0) {
      return { success: false, error: 'Installer not found' };
    }

    const installer = installers[0];
    const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
    
    if (installer.password !== hashedPassword) {
      return { success: false, error: 'Invalid password' };
    }

    await connection.query(
      'UPDATE installers SET last_login = NOW() WHERE phone_number = ?',
      [phoneNumber]
    );

    await connection.query(
      'INSERT INTO login_logs (phone_number, timestamp) VALUES (?, NOW())',
      [phoneNumber]
    );

    const [macs] = await connection.query(
      'SELECT * FROM mac_addresses WHERE phone_number = ?',
      [phoneNumber]
    );

    return {
      success: true,
      data: {
        phoneNumber,
        macAddresses: macs.map(row => ({
          mac: row.mac,
          address: row.address,
          notes: row.notes,
          purchaseDate: row.purchase_date,
          startDate: row.start_date,
          technicianName: row.technician_name,
          description: row.description,
        }))
      }
    };
  } finally {
    connection.release();
  }
}

async function loginManager(username, password) {
  if (username !== 'admin') {
    return { success: false, error: 'Invalid credentials' };
  }

  const connection = await pool.getConnection();
  try {
    const [admins] = await connection.query(
      'SELECT * FROM installers WHERE phone_number = ?',
      ['admin']
    );

    if (admins.length === 0) {
      return { success: false, error: 'Admin not found' };
    }

    const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
    if (admins[0].password === hashedPassword) {
      return { success: true };
    }
    return { success: false, error: 'Invalid credentials' };
  } finally {
    connection.release();
  }
}

async function getInstallers() {
  const connection = await pool.getConnection();
  try {
    const [installers] = await connection.query(`
      SELECT 
        i.phone_number,
        i.created_at,
        i.last_login,
        COUNT(m.id) as mac_count
      FROM installers i
      LEFT JOIN mac_addresses m ON i.phone_number = m.phone_number
      WHERE i.phone_number != 'admin'
      GROUP BY i.phone_number, i.created_at, i.last_login
      ORDER BY i.created_at DESC
    `);

    return installers.map(row => ({
      phoneNumber: row.phone_number,
      macCount: parseInt(row.mac_count),
      createdAt: row.created_at,
      lastLogin: row.last_login,
    }));
  } finally {
    connection.release();
  }
}

async function getInstallerDetails(phoneNumber) {
  const connection = await pool.getConnection();
  try {
    const [installers] = await connection.query(
      'SELECT * FROM installers WHERE phone_number = ?',
      [phoneNumber]
    );

    if (installers.length === 0) {
      return null;
    }

    const [macs] = await connection.query(
      'SELECT * FROM mac_addresses WHERE phone_number = ?',
      [phoneNumber]
    );

    const installer = installers[0];
    return {
      phoneNumber: installer.phone_number,
      password: installer.plain_password,
      macAddresses: macs.map(row => ({
        mac: row.mac,
        address: row.address,
        notes: row.notes,
        purchaseDate: row.purchase_date,
        startDate: row.start_date,
        technicianName: row.technician_name,
        description: row.description,
      })),
      createdAt: installer.created_at,
      lastLogin: installer.last_login,
    };
  } finally {
    connection.release();
  }
}

async function getLoginLogs() {
  const connection = await pool.getConnection();
  try {
    const [logs] = await connection.query(
      'SELECT * FROM login_logs ORDER BY timestamp DESC LIMIT 100'
    );

    return logs.map(row => ({
      phoneNumber: row.phone_number,
      timestamp: row.timestamp,
      ip: row.ip,
    }));
  } finally {
    connection.release();
  }
}

async function deleteInstaller(phoneNumber) {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      'DELETE FROM installers WHERE phone_number = ?',
      [phoneNumber]
    );
  } finally {
    connection.release();
  }
}

async function resetPassword(phoneNumber) {
  const newPassword = Math.random().toString(36).slice(-8);
  const hashedPassword = crypto.createHash('md5').update(newPassword).digest('hex');
  
  const connection = await pool.getConnection();
  try {
    await connection.query(
      'UPDATE installers SET password = ?, plain_password = ? WHERE phone_number = ?',
      [hashedPassword, newPassword, phoneNumber]
    );

    return newPassword;
  } finally {
    connection.release();
  }
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
