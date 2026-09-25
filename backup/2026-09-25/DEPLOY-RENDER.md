# 🚀 Deploy GenesisTracer to Render.com

Step-by-step guide to deploy your GenesisTracer app online for free.

---

## **Step 1: Create Render Account**

1. Go to: **https://render.com**
2. Click **"Get Started for Free"**
3. Sign up with Email, GitHub, or Google

---

## **Step 2: Create GitHub Repository (Recommended)**

### **A. Create GitHub Account**
1. Go to https://github.com
2. Sign up (free)

### **B. Create Repository**
1. Click **"+"** → **"New repository"**
2. Name: **`genesistracer`**
3. Public or Private
4. Click **"Create repository"**

### **C. Upload Files**
1. Click **"uploading an existing file"**
2. Drag and drop ALL files:
   - server.js
   - db.js
   - package.json
   - README.md
   - DEPLOY-RENDER.md
   - **public/** folder (with index.html, manager.html, installer.html)
3. Click **"Commit changes"**

---

## **Step 3: Connect to Render**

1. Go to **Render.com** dashboard
2. Click **"New +"** → **"Web Service"**
3. Click **"Connect GitHub"** (authorize if needed)
4. Select your **`genesistracer`** repository

---

## **Step 4: Configure Service**

Fill in these settings:

| Field | Value |
|-------|-------|
| **Name** | `genesistracer` |
| **Region** | Oregon (US West) or Frankfurt (Europe) |
| **Branch** | `main` |
| **Root Directory** | *(leave empty)* |
| **Runtime** | **Node** |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Plan** | **Free** |

---

## **Step 5: Deploy!**

1. Click **"Create Web Service"**
2. Wait 2-5 minutes while Render:
   - Installs dependencies
   - Starts your server
   - Generates your URL

---

## **Step 6: Access Your App**

Your app will be live at:
- **Main**: `https://genesistracer.onrender.com`
- **Manager**: `https://genesistracer.onrender.com/manager.html`
- **Installer**: `https://genesistracer.onrender.com/installer.html`

*(Your actual URL might be `genesistracer-xyz.onrender.com` if the name is taken)*

---

## **Step 7: Test Everything**

1. Open your URL
2. Try device lookup with a test MAC
3. Login to manager: `admin` / `admin123`
4. Create a test installer account

---

## ⚠️ **Important: Data Persistence**

**Problem**: Free tier deletes `data.json` on restart!

**Solutions**:
1. **Accept it** (for testing/demo only)
2. **Add PostgreSQL** (free, recommended):
   - Render → "New +" → "PostgreSQL"
   - Connect to your web service
   - I can help migrate from JSON to PostgreSQL

---

## 🎯 **Custom Domain (Optional)**

1. Buy domain (e.g., `genesistracer.com`)
2. Render → Your service → "Settings" → "Custom Domain"
3. Add your domain
4. Update DNS records as shown

---

## 🔧 **Updating Your App**

1. Make changes to your files locally
2. Upload to GitHub (commit & push)
3. Render auto-deploys! ✅

---

## 📊 **Monitor Your App**

- **Logs**: Render dashboard → Your service → "Logs"
- **Metrics**: See usage, uptime
- **Restart**: Manual restart button if needed

---

🎉 **GenesisTracer is now LIVE!** 🎉

Share your URL with installers and managers worldwide!

## Prerequisites
✅ All project files ready
✅ Email address for signup

---

## **Step 1: Create Render Account**

1. Go to: **https://render.com**
2. Click **"Get Started for Free"**
3. Sign up with:
   - Email
   - OR GitHub (recommended if you have it)
   - OR Google

---

## **Step 2: Create a New Web Service**

1. After login, click **"New +"** (top right)
2. Select **"Web Service"**

---

## **Step 3: Choose Deployment Method**

You have 2 options:

### **Option A: Upload Files Directly (Easier)**

1. Select **"Public Git repository"** 
2. Enter any public repo (we'll change this)
3. OR choose **"Deploy from GitHub"** if you have a GitHub account

### **Option B: Use GitHub (Recommended for updates)**

1. Click **"Connect GitHub"**
2. Create a new repository
3. Upload all your files to GitHub
4. Select that repository in Render

**For now, let's do Option A (direct upload):**

---

## **Step 4: Configure Your Service**

Fill in these settings:

| Field | Value |
|-------|-------|
| **Name** | `nexhome-lookup` (or any name you want) |
| **Region** | Choose closest to you (e.g., Oregon, Frankfurt) |
| **Branch** | `main` (default) |
| **Root Directory** | Leave empty |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Plan** | **Free** |

---

## **Step 5: Environment Variables (Optional)**

Click **"Advanced"** → **"Add Environment Variable"**

You can add (optional):
- `NODE_ENV` = `production`

---

## **Step 6: Deploy!**

1. Click **"Create Web Service"**
2. Render will:
   - Install dependencies (`npm install`)
   - Start your server (`node server.js`)
   - Give you a URL like: `https://nexhome-lookup.onrender.com`

**⏱️ First deploy takes 2-5 minutes**

---

## **Step 7: Access Your App**

Once deployed, you'll get:
- **Main URL**: `https://your-app-name.onrender.com`
- **Manager**: `https://your-app-name.onrender.com/manager.html`
- **Installer**: `https://your-app-name.onrender.com/installer.html`

---

## **Step 8: Upload Your Files (If not using GitHub)**

If you didn't use GitHub:

1. Install Render CLI:
   ```bash
   npm install -g render-cli
   ```

2. Login:
   ```bash
   render login
   ```

3. Deploy:
   ```bash
   render deploy
   ```

**OR** use GitHub (easier for updates):

---

## 📁 **GitHub Upload Method (Recommended)**

### **A. Create GitHub Account**
1. Go to https://github.com
2. Sign up (free)

### **B. Create Repository**
1. Click **"New repository"**
2. Name: `nexhome-lookup`
3. Public or Private (your choice)
4. Click **"Create repository"**

### **C. Upload Files**
1. Click **"uploading an existing file"**
2. Drag all your files:
   - server.js
   - db.js
   - package.json
   - public/ folder (with all 3 HTML files)
3. Click **"Commit changes"**

### **D. Connect to Render**
1. In Render, click **"New +" → "Web Service"**
2. Click **"Connect GitHub"**
3. Select your `nexhome-lookup` repository
4. Follow Step 4 settings above
5. Deploy!

---

## 🎯 **After Deployment**

### **Check Logs**
- In Render dashboard → Your service → **"Logs"** tab
- See if server started successfully

### **Test Your App**
1. Click the URL Render gives you
2. Try the device lookup
3. Login to manager panel (`admin` / `admin123`)

### **Custom Domain (Optional)**
1. Buy domain (Namecheap, GoDaddy, etc.)
2. In Render → Your service → **"Settings"** → **"Custom Domain"**
3. Add your domain (e.g., `nexhome.tador.com`)
4. Update DNS records as shown

---

## ⚠️ **Important Notes**

### **Free Plan Limitations**
- ✅ App is live and accessible worldwide
- ⚠️ Sleeps after 15 minutes of inactivity
- ⏱️ Takes ~30 seconds to wake up when accessed
- 📊 750 hours/month total

### **Data Persistence**
- ❌ `data.json` will be DELETED on every deploy!
- 🔄 Use a database instead for production:
  - PostgreSQL (free on Render)
  - MongoDB Atlas (free)
  - Or backup/restore data.json manually

### **To Add Database (PostgreSQL - Free)**
1. Render dashboard → **"New +" → "PostgreSQL"**
2. Name it, choose Free plan
3. In your web service → Environment Variables:
   - `DATABASE_URL` = (connection string from PostgreSQL service)
4. Update `db.js` to use PostgreSQL instead of JSON file

---

## 🔧 **Troubleshooting**

**Build failed?**
- Check logs in Render
- Make sure `package.json` is uploaded
- Verify `node server.js` works locally first

**App shows error?**
- Check logs
- Environment variables set correctly?
- Port is dynamic (we changed it to `process.env.PORT`)

**Can't access?**
- Wait 30 seconds (might be sleeping)
- Check URL is correct
- Check logs for errors

---

## 📞 **Need Help?**

- Render Docs: https://render.com/docs
- Support: support@render.com
- Community: https://community.render.com

---

🎉 **Congratulations! Your app is now online!** 🎉
