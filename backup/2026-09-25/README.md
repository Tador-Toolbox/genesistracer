# GenesisTracer

**NEXhome Device Lookup & Management System**

Complete bilingual (English/Hebrew) web application for NEXhome device management.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ (Download: https://nodejs.org)

### Installation

```bash
# 1. Extract files to a folder
# 2. Open terminal in that folder
# 3. Install dependencies
npm install

# 4. Start server
node server.js
```

### Access
- **Main**: http://localhost:3000
- **Manager**: http://localhost:3000/manager.html
- **Installer**: http://localhost:3000/installer.html

---

## 🔐 Default Login

**Manager Panel:**
- Username: `admin`
- Password: `admin123`

⚠️ Change this in production!

---

## 🌟 Features

### 🔍 Public Device Lookup
- Search by MAC address
- Get IP and port instantly
- English / עברית
- Dark/Light theme

### 👨‍💼 Manager Panel
- Create installer accounts
- Assign MACs with details:
  - Installation address
  - Purchase date
  - Start working date
  - Technician name
  - Additional notes
- View installer descriptions
- Monitor login activity
- Reset passwords
- Full bilingual support

### 🔧 Installer Panel
- Login with phone + password
- View assigned MAC cards
- Add custom descriptions
- Quick device lookup
- Direct device access

---

## 💾 Data Storage

Data saved automatically to `data.json`
- Persists across restarts
- Backup by copying the file
- Portable between computers

---

## 🌐 Deploy Online

### Render.com (Free)
```bash
# See DEPLOY-RENDER.md for full guide
```

Your URL: `https://genesistracer.onrender.com`

### Requirements
- Build: `npm install`
- Start: `node server.js`

---

## 📁 Structure

```
genesistracer/
├── server.js          # Main server
├── db.js              # Database (JSON file)
├── package.json       # Dependencies
├── data.json          # Your data (auto-created)
├── README.md
└── public/
    ├── index.html     # Public lookup
    ├── manager.html   # Manager panel
    └── installer.html # Installer panel
```

---

## 🎨 Customization

### Change Theme
Click ☀️/🌙 button (preference saved)

### Change Language
Click English / עברית (updates instantly)

### Change Manager Password
Edit `db.js` - search for `admin123`

---

## 🔒 Security Notes

**Before going online:**
1. Change default password
2. Use HTTPS (automatic on Render)
3. Backup `data.json` regularly
4. Consider PostgreSQL for production

---

## 📞 Support

**Created by Tador Technologies LTD**
תדאור טכנולוגיות בע"מ

---

## 📄 License

ISC License - Copyright © 2024 Tador Technologies LTD

---

**GenesisTracer** - Track every device, trace every connection 🌐
