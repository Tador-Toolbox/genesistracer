# Generates public/manager-v2.html (new sidebar layout) from public/manager.html.
# Run after every change to manager.html so both versions keep the same features:
#   python3 tools/build-manager-v2.py public/manager.html public/manager-v2.html
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
def rep(old, new, n=1):
    global s
    c = s.count(old)
    assert c == n, (old[:90], c)
    s = s.replace(old, new)

s = s.replace('<title>', '<title>V2 · ', 1)

# The old page's "try the new design" button makes no sense inside v2
rep("""          <a href="/manager-v2.html" class="quick-btn qb-navy">
            <span class="qb-icon">🧪</span>
            <span class="qb-label">עיצוב חדש (בבדיקה)</span>
          </a>
""", "")

# ---------- 1. CSS for the new shell ----------
rep("""  </style>
</head>""", """
    /* ================= V2 LAYOUT ================= */
    #managerPanel.v2 { padding: 0; }
    body.v2-body { padding: 0; }
    .v2-shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
    .v2-side {
      position: sticky; top: 0; height: 100vh; overflow-y: auto;
      background: var(--surface); border-left: 1px solid var(--border);
      padding: 18px 12px; display: flex; flex-direction: column; gap: 4px;
    }
    .v2-brand { font-weight: 900; font-size: 20px; letter-spacing: 1px; padding: 4px 10px 16px; color: var(--text); }
    .v2-brand small { display: block; font-size: 11px; font-weight: 600; color: var(--text-dim); letter-spacing: 0; margin-top: 2px; }
    .v2-nav {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 10px 12px; border-radius: 8px; border: none; background: none;
      color: var(--text); font-family: inherit; font-size: 14px; font-weight: 600;
      cursor: pointer; text-align: right; position: relative;
    }
    .v2-nav:hover { background: var(--surface2); }
    .v2-nav.active { background: var(--accent); color: #fff; }
    .v2-nav .ic { font-size: 17px; width: 22px; text-align: center; }
    .v2-nav .bdg { margin-inline-start: auto; background: #ef4444; color: #fff; border-radius: 10px; font-size: 11px; font-weight: 800; padding: 1px 7px; display: none; }
    .v2-side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 16px; border-top: 1px solid var(--border); }
    .v2-side-foot a { font-size: 12px; color: var(--text-dim); text-decoration: none; padding: 4px 12px; }
    .v2-side-foot a:hover { color: var(--accent); }
    .v2-main { padding: 24px 28px 60px; min-width: 0; }
    .v2-main .container { max-width: 1500px; }
    .v2-main .header { margin-bottom: 20px; }
    .v2-main .header h1 { font-size: 26px; }
    #managerPanel.v2 > .logout-btn { display: none; }
    .v2-screen-hidden { display: none !important; }
    .v2-beta { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; border-radius: 8px; padding: 8px 14px; font-size: 13px; margin-bottom: 16px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .v2-beta a { color: #92400e; font-weight: 700; }

    /* Home tiles */
    .v2-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .v2-tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; cursor: pointer; text-align: right; font-family: inherit; color: var(--text); }
    .v2-tile:hover { border-color: var(--accent); }
    .v2-tile .num { font-size: 30px; font-weight: 900; line-height: 1.1; }
    .v2-tile .lbl { font-size: 13px; color: var(--text-dim); margin-top: 4px; }

    /* Installers: compact MAC rows */
    .v2-table-wrap { overflow-x: auto; }
    .v2-main #installersTable th, .v2-main #installersTable td { padding: 10px 8px; }
    .v2-main #installersTable th { min-width: 0 !important; }
    .v2-main .mac-detail { padding: 10px 12px; margin-bottom: 8px; min-width: 340px; }
    .v2-main .mac-detail-header { flex-wrap: wrap; gap: 6px; }
    .v2-main .mac-actions { flex-wrap: wrap; }
    .v2-main .mac-actions .small { padding: 5px 9px; font-size: 11.5px; }
    .mac-detail.v2-collapsed .v2-mac-body { display: none; }
    .v2-mac-summary { font-size: 12px; color: var(--text-dim); margin: 2px 0 0; cursor: pointer; }
    .v2-mac-toggle { background: none !important; border: 1px solid var(--border) !important; color: var(--text) !important; padding: 2px 8px !important; font-size: 11px !important; border-radius: 6px !important; cursor: pointer; }
    .v2-toolbar { display: flex; gap: 8px; margin: -4px 0 12px; flex-wrap: wrap; }
    .v2-toolbar button { padding: 6px 12px; font-size: 12px; background: var(--surface2); color: var(--text); border: 1px solid var(--border); }

    /* Mobile: side menu becomes a bottom bar */
    @media (max-width: 860px) {
      .v2-shell { grid-template-columns: 1fr; }
      .v2-side {
        position: fixed; bottom: 0; top: auto; left: 0; right: 0; height: auto; z-index: 500;
        flex-direction: row; overflow-x: auto; padding: 6px; border-left: none; border-top: 1px solid var(--border);
      }
      .v2-brand, .v2-side-foot { display: none; }
      .v2-nav { flex-direction: column; gap: 2px; font-size: 10.5px; padding: 6px 8px; min-width: 64px; text-align: center; }
      .v2-nav .bdg { position: absolute; top: 2px; left: 6px; margin: 0; }
      .v2-main { padding: 14px 12px 90px; }
    }
  </style>
</head>""")

# ---------- 2. Shell: sidebar + main ----------
rep("""  <div id="managerPanel">
    <button class="logout-btn danger" onclick="logout()" data-i18n="logout">Logout</button>

    <div class="container">""", """  <div id="managerPanel" class="v2">
    <button class="logout-btn danger" onclick="logout()" data-i18n="logout">Logout</button>
    <div class="v2-shell">
    <nav class="v2-side">
      <div class="v2-brand">TADOR<small>פאנל מנהל · גרסה חדשה</small></div>
      <button class="v2-nav" data-go="home"><span class="ic">🏠</span>בית</button>
      <button class="v2-nav" data-go="installers"><span class="ic">👥</span>מתקינים</button>
      <button class="v2-nav" onclick="openMessagesPage()"><span class="ic">💬</span>הודעות<span class="bdg" id="v2MsgBadge"></span></button>
      <button class="v2-nav" data-go="announce"><span class="ic">📢</span>הודעות תפוצה</button>
      <button class="v2-nav" data-go="content"><span class="ic">📚</span>תוכן למתקינים</button>
      <button class="v2-nav" data-go="files"><span class="ic">🗂️</span>קבצים</button>
      <button class="v2-nav" data-go="activity"><span class="ic">📜</span>יומן פעילות</button>
      <div class="v2-side-foot">
        <a href="/manager.html">↩ לעיצוב הקודם</a>
        <button class="v2-nav" onclick="logout()" style="color:#ef4444;"><span class="ic">⏻</span>התנתק</button>
      </div>
    </nav>
    <main class="v2-main">
    <div class="container">
      <div class="v2-beta"><span>🧪 זו גרסה חדשה של פאנל המנהל, בבדיקה. כל הפעולות עובדות על אותם נתונים.</span><a href="/manager.html">מעבר לעיצוב הקודם ←</a></div>""")

# close main + shell before the managerPanel closing. Anchor: end of activity log card.
rep("""            <tbody id="activityLogBody">
              <tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-dim);">טוען...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>""", """            <tbody id="activityLogBody">
              <tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-dim);">טוען...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </main>
    </div>
  </div>""")

# ---------- 3. Tag each card with its screen ----------
def tag(marker, screen):
    rep(marker, marker.replace('<div class="card"', f'<div class="card" data-screen="{screen}"', 1))
tag("""      <!-- Quick Link -->
      <div class="card">""", "home")
tag("""      <!-- Create Installer -->
      <div class="card">""", "installers")
rep("""      <div class="card">
        <h2>📄 קטלוג מוצרים</h2>""", """      <div class="card" data-screen="content">
        <h2>📄 קטלוג מוצרים</h2>""")
rep("""      <div class="card">
        <h2>📋 רשימת דיירים לועד</h2>""", """      <div class="card" data-screen="files">
        <h2>📋 רשימת דיירים לועד</h2>""")
rep("""      <div class="card">
        <h2>🖼️ תמונות וקבצים</h2>""", """      <div class="card" data-screen="files">
        <h2>🖼️ תמונות וקבצים</h2>""")
tag("""      <!-- Tutorials -->
      <div class="card">""", "content")
tag("""      <!-- Install Docs -->
      <div class="card">""", "content")
tag("""      <!-- Mailing List -->
      <div class="card">""", "content")
tag("""      <!-- Installers List -->
      <div class="card">""", "installers")
tag("""      <!-- Announcements -->
      <div class="card">""", "announce")
tag("""      <!-- Activity Log -->
      <div class="card">""", "activity")

# Home summary tiles before quick access
rep("""      <!-- Quick Link -->
      <div class="card" data-screen="home">""", """      <div class="v2-tiles" data-screen="home">
        <button class="v2-tile" onclick="openMessagesPage()"><div class="num" id="v2TileMsgs">—</div><div class="lbl">💬 הודעות שלא נקראו</div></button>
        <button class="v2-tile" data-go="installers"><div class="num" id="v2TileInstallers">—</div><div class="lbl">👥 חשבונות</div></button>
        <button class="v2-tile" data-go="installers"><div class="num" id="v2TileMacs">—</div><div class="lbl">🖥️ פנלים (MAC)</div></button>
        <button class="v2-tile" onclick="window.open('/building-admin.html','_blank')"><div class="num" id="v2TileBuildings">—</div><div class="lbl">🏢 בניינים במערכת הדיירים</div></button>
      </div>

      <!-- Quick Link -->
      <div class="card" data-screen="home">""")

# Installers table: horizontal scroll wrapper + expand/collapse toolbar
rep("""        <table id="installersTable">""", """        <div class="v2-toolbar">
          <button onclick="v2SetAllMacs(false)">⊞ פתח את כל ה-MAC</button>
          <button onclick="v2SetAllMacs(true)">⊟ סגור את כל ה-MAC</button>
        </div>
        <div class="v2-table-wrap">
        <table id="installersTable">""")
rep("""          <tbody id="installersBody"></tbody>
        </table>""", """          <tbody id="installersBody"></tbody>
        </table>
        </div>""")

# ---------- 4. Compact MAC card: summary line + collapsible body ----------
rep("""                <div class="mac-detail">
                  <div class="mac-detail-header">
                    <span class="mac-detail-mac">${macObj.mac}</span>""", """                <div class="mac-detail v2-collapsed">
                  <div class="mac-detail-header">
                    <span class="mac-detail-mac" onclick="v2ToggleMac(this)" style="cursor:pointer;">${macObj.mac}</span>""")
rep("""                      <button class="small danger" onclick="removeMac('${installer.phoneNumber}', '${macObj.mac}')">×</button>
                    </div>
                  </div>
""", """                      <button class="small danger" onclick="removeMac('${installer.phoneNumber}', '${macObj.mac}')">×</button>
                      <button class="small v2-mac-toggle" onclick="v2ToggleMac(this)" title="פרטים">▾</button>
                    </div>
                  </div>
                  <div class="v2-mac-summary" onclick="v2ToggleMac(this)">${[(macObj.panelType||'genesis7')==='genesis5'?'Genesis 5':'Genesis 7', [macObj.address, macObj.city].filter(Boolean).join(', '), macObj.descriptionInstaller || macObj.description].filter(Boolean).join(' · ')}</div>
                  <div class="v2-mac-body">
""")
# close the body right before the end of mac-detail (after the file row)
rep("""                    <button class="small" onclick="window.open('${macObj.fileUrl || ''}','_blank')" ${macObj.fileUrl ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>⬇ הורד${macObj.fileName ? ' · ' + macObj.fileName : ''}</button>
                  </div>
                </div>""", """                    <button class="small" onclick="window.open('${macObj.fileUrl || ''}','_blank')" ${macObj.fileUrl ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>⬇ הורד${macObj.fileName ? ' · ' + macObj.fileName : ''}</button>
                  </div>
                  </div>
                </div>""")

# Search: open MAC cards that contain the query, close them when search is cleared
rep("""      rows.forEach(row => {
        if (!q) { row.style.display = ''; return; }
        const hay = row.dataset.search || '';
        const match = hay.includes(q);
        row.style.display = match ? '' : 'none';
        if (match) shown++;
      });""", """      rows.forEach(row => {
        row.querySelectorAll('.mac-detail').forEach(md =>
          md.classList.toggle('v2-collapsed', !q || !md.textContent.toLowerCase().includes(q)));
        if (!q) { row.style.display = ''; return; }
        const hay = row.dataset.search || '';
        const match = hay.includes(q);
        row.style.display = match ? '' : 'none';
        if (match) shown++;
      });""")

# Quick-access "send announcement" goes to the announcements screen
rep("""    function scrollToAnnouncements() {
      var el = document.getElementById('newAnnouncementForm');""", """    function scrollToAnnouncements() {
      v2Show('announce');
      setTimeout(function() { var t = document.getElementById('announcementText'); if (t) t.focus(); }, 50);
      return;
      var el = document.getElementById('newAnnouncementForm');""")

# ---------- 5. V2 script (screens, tiles, badges) ----------
v2js = r"""
  <script>
    // ================= V2: screens =================
    const V2_SCREENS = ['home', 'installers', 'announce', 'content', 'files', 'activity'];
    function v2Show(screen) {
      if (!V2_SCREENS.includes(screen)) screen = 'home';
      document.querySelectorAll('[data-screen]').forEach(el =>
        el.classList.toggle('v2-screen-hidden', el.dataset.screen !== screen));
      document.querySelectorAll('.v2-nav[data-go]').forEach(b => b.classList.toggle('active', b.dataset.go === screen));
      if (location.hash !== '#' + screen) history.replaceState(null, '', '#' + screen);
      window.scrollTo(0, 0);
    }
    document.addEventListener('click', e => {
      const go = e.target.closest('[data-go]');
      if (go) { e.preventDefault(); v2Show(go.dataset.go); }
    });
    document.body.classList.add('v2-body');
    v2Show((location.hash || '#home').slice(1));

    function v2ToggleMac(el) {
      el.closest('.mac-detail').classList.toggle('v2-collapsed');
    }
    function v2SetAllMacs(collapsed) {
      document.querySelectorAll('#installersBody .mac-detail').forEach(md => md.classList.toggle('v2-collapsed', collapsed));
    }

    // Home tiles + sidebar badge, refreshed periodically
    async function v2RefreshTiles() {
      if (document.getElementById('managerPanel').style.display !== 'block') return;
      try {
        const u = await fetch('/api/chat/unread/all').then(r => r.json());
        const unread = Object.values(u.counts || {}).reduce((a, n) => a + (Number(n) || 0), 0);
        document.getElementById('v2TileMsgs').textContent = unread;
        const bdg = document.getElementById('v2MsgBadge');
        bdg.textContent = unread; bdg.style.display = unread ? 'inline-block' : 'none';
      } catch(e) {}
      try {
        const macs = window._installerMacs || {};
        const phones = Object.keys(macs);
        if (phones.length) {
          document.getElementById('v2TileInstallers').textContent = phones.length;
          document.getElementById('v2TileMacs').textContent = phones.reduce((a, p) => a + (macs[p] || []).length, 0);
        }
        if (typeof buildingsCache !== 'undefined' && buildingsCache.length)
          document.getElementById('v2TileBuildings').textContent = buildingsCache.length;
      } catch(e) {}
    }
    setInterval(v2RefreshTiles, 5000);
    // refresh the tiles as soon as the installers list has loaded
    const _v2LoadData = loadData;
    loadData = async function() { const r = await _v2LoadData.apply(this, arguments); v2RefreshTiles(); return r; };
  </script>
</body>"""
idx = s.rindex('</body>')
s = s[:idx] + v2js.lstrip('\n  ').replace('<script>', '<script>', 1) + s[idx+len('</body>'):]
s = s.replace('\n<script>\n    // ================= V2', '\n  <script>\n    // ================= V2', 1)
open(dst, 'w').write(s)
print('ok')
