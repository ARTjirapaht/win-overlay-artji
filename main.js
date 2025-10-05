// main.js — WIN Overlay (Realtime + TikFinity + Auto-Update + Logs)

const { app, BrowserWindow, globalShortcut, shell, Tray, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');        // <- ใช้ electron-updater
const log = require('electron-log');

const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ---------------- Auto-Update Setup ----------------
log.initialize({ preload: true });
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// ถ้ามี UPDATE_URL (generic server) จะใช้ feed URL นี้แทน config publish
// ตัวอย่าง: UPDATE_URL=https://updates.your-domain.com/win-overlay-artji
if (process.env.UPDATE_URL) {
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.UPDATE_URL });
    log.info('[Update] feed set to generic:', process.env.UPDATE_URL);
  } catch (e) {
    log.error('[Update] setFeedURL error:', e);
  }
}

// กันเรียกเช็กทับซ้อน
let isCheckingUpdate = false;
function safeCheckForUpdates() {
  if (isCheckingUpdate) return;
  isCheckingUpdate = true;
  autoUpdater.checkForUpdates().catch(err => log.error(err)).finally(() => {
    isCheckingUpdate = false;
  });
}

autoUpdater.on('checking-for-update', () => log.info('[Update] checking...'));
autoUpdater.on('update-available', (info) => log.info('[Update] available:', info?.version));
autoUpdater.on('update-not-available', () => log.info('[Update] none'));
autoUpdater.on('error', (err) => log.error('[Update] error:', err));
autoUpdater.on('download-progress', (p) => {
  log.info(`[Update] downloading ${Math.floor(p.percent || 0)}%  (${p.transferred}/${p.total})`);
});
autoUpdater.on('update-downloaded', (info) => {
  log.info('[Update] downloaded:', info?.version);
  dialog.showMessageBox({
    type: 'info',
    buttons: ['Restart', 'Later'],
    title: 'Application Update',
    message: 'พบเวอร์ชันใหม่',
    detail: `ดาวน์โหลดเวอร์ชัน ${info?.version} เสร็จแล้ว ต้องการรีสตาร์ทเพื่อติดตั้งเลยไหม?`
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

// ---------------- App State / Config ----------------
let mainWindow;
let tray;

let maxWin = 10;
let count  = 0;
let theme  = 'theme-default';
let font   = "'Kanit', sans-serif";
let fontUrl = "";
let showBg = true;
let strokeWidth = 2;
let strokeColor = '#000000';
let wsClients = [];

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(PUBLIC_DIR, 'config.json');
const ICON_PATH   = path.join(ROOT, 'icon.ico'); // dev tray icon

function ensureConfigFile() {
  try {
    if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      const init = {
        maxWin: 10, current: 0,
        theme: 'theme-default',
        font: "'Kanit', sans-serif",
        fontUrl: "",
        showBg: true,
        strokeWidth: 2,
        strokeColor: "#000000",
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(init, null, 2), 'utf-8');
    }
  } catch (e) { console.error('ensureConfigFile error:', e); }
}

function loadConfig() {
  try {
    ensureConfigFile();
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    if (typeof cfg.maxWin  === 'number') maxWin = cfg.maxWin;
    if (typeof cfg.current === 'number') count  = cfg.current;
    if (typeof cfg.theme   === 'string') theme  = cfg.theme;
    if (typeof cfg.font    === 'string') font   = cfg.font;
    if (typeof cfg.fontUrl === 'string') fontUrl = cfg.fontUrl || "";
    if (typeof cfg.showBg  === 'boolean') showBg = cfg.showBg;
    if (Number.isFinite(cfg.strokeWidth)) strokeWidth = cfg.strokeWidth;
    if (typeof cfg.strokeColor === 'string') strokeColor = cfg.strokeColor;
    return { maxWin, current: count, theme, font, fontUrl, showBg, strokeWidth, strokeColor };
  } catch (err) {
    console.error('loadConfig error:', err);
    return { maxWin, current: count, theme, font, fontUrl, showBg, strokeWidth, strokeColor };
  }
}

function saveConfig(next) {
  try {
    const toSave = {
      maxWin:  Number.isFinite(next.maxWin) ? next.maxWin : maxWin,
      current: Number.isFinite(next.current) ? next.current : count,
      theme:   typeof next.theme   === 'string' ? next.theme   : theme,
      font:    typeof next.font    === 'string' ? next.font    : font,
      fontUrl: typeof next.fontUrl === 'string' ? next.fontUrl : fontUrl,
      showBg:  typeof next.showBg  === 'boolean'? next.showBg  : showBg,
      strokeWidth: Number.isFinite(next.strokeWidth) ? next.strokeWidth : strokeWidth,
      strokeColor: typeof next.strokeColor === 'string' ? next.strokeColor : strokeColor,
    };
    if (toSave.maxWin < 1) toSave.maxWin = 1;
    if (toSave.strokeWidth < 0) toSave.strokeWidth = 0;
    if (toSave.strokeWidth > 12) toSave.strokeWidth = 12;

    maxWin = toSave.maxWin;
    count  = toSave.current;
    theme  = toSave.theme;
    font   = toSave.font;
    fontUrl = toSave.fontUrl;
    showBg = toSave.showBg;
    strokeWidth = toSave.strokeWidth;
    strokeColor = toSave.strokeColor;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      maxWin, current: count, theme, font, fontUrl, showBg, strokeWidth, strokeColor
    }, null, 2), 'utf-8');

    return { maxWin, current: count, theme, font, fontUrl, showBg, strokeWidth, strokeColor };
  } catch (e) {
    console.error('saveConfig error:', e);
    return { maxWin, current: count, theme, font, fontUrl, showBg, strokeWidth, strokeColor };
  }
}

function broadcastState() {
  const payload = { maxWin, current: count, theme, font, fontUrl, showBg, strokeWidth, strokeColor };
  const msg = JSON.stringify({ type: 'state', data: payload });
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  console.log('[WS] Sent state:', payload);
}

function applyAndPersist(next) {
  const merged = {
    maxWin:  Number.isFinite(next.maxWin) ? next.maxWin : maxWin,
    current: Number.isFinite(next.current) ? next.current : count,
    theme:   typeof next.theme   === 'string' ? next.theme   : theme,
    font:    typeof next.font    === 'string' ? next.font    : font,
    fontUrl: typeof next.fontUrl === 'string' ? next.fontUrl : fontUrl,
    showBg:  typeof next.showBg  === 'boolean'? next.showBg  : showBg,
    strokeWidth: Number.isFinite(next.strokeWidth) ? next.strokeWidth : strokeWidth,
    strokeColor: typeof next.strokeColor === 'string' ? next.strokeColor : strokeColor,
  };
  const saved = saveConfig(merged);
  broadcastState();
  return saved;
}

// ---------------- Single Instance Lock ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------- Electron Window ----------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 815,
    useContentSize: true,
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadURL('http://localhost:3000/config.html');
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
}

// ---------------- App Ready ----------------
app.whenReady().then(() => {
  // Tray (optional)
  try {
    tray = new Tray(ICON_PATH);
    tray.setToolTip('WIN Overlay');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'เปิดหน้าตั้งค่า', click: () => shell.openExternal('http://localhost:3000/config.html') },
      { type: 'separator' },
      { label: 'ออก', click: () => app.quit() }
    ]));
  } catch (e) { console.warn('Tray init warning:', e); }

  loadConfig();

  // ==== Express App ====
  const overlayApp = express();

  overlayApp.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
  });

  overlayApp.use(express.static(PUBLIC_DIR));
  overlayApp.use(express.json());

  overlayApp.get('/', (_, res) => res.redirect('/overlay.html'));

  // API config
  overlayApp.get('/api/config', (req, res) => res.json(loadConfig()));
  overlayApp.post('/api/config', (req, res) => {
    const saved = applyAndPersist(req.body || {});
    res.json({ ok: true, config: saved });
  });

  // legacy
  overlayApp.post('/save-config', (req, res) => { applyAndPersist(req.body || {}); res.sendStatus(200); });

  // win controls
  overlayApp.post('/api/win/plus', (req, res) => {
    const saved = applyAndPersist({ current: count + 1 });
    res.json({ count: saved.current, maxWin: saved.maxWin });
  });
  overlayApp.post('/api/win/minus', (req, res) => {
    const saved = applyAndPersist({ current: count - 1 });
    res.json({ count: saved.current, maxWin: saved.maxWin });
  });

  // ==== TikFinity Webhook Routes ====
  const WEBHOOK_TOKEN = process.env.WIN_TOKEN || 'artjiraphatjtt';
  const APP_NAME = 'winoverlay';

  function handleWebhookAction(action, rawArg) {
    let saved;
    const n = Number.parseInt(rawArg, 10);
    switch (action) {
      case 'win_plus': {
        const step = Number.isFinite(n) ? n : 1;
        saved = applyAndPersist({ current: count + step });
        break;
      }
      case 'win_minus': {
        const step = Number.isFinite(n) ? n : 1;
        saved = applyAndPersist({ current: count - step });
        break;
      }
      case 'set_current': {
        if (!Number.isFinite(n)) throw new Error('set_current needs a number');
        saved = applyAndPersist({ current: n });
        break;
      }
      case 'set_max': {
        const m = Number.isFinite(n) && n >= 1 ? n : 1;
        saved = applyAndPersist({ maxWin: m });
        break;
      }
      case 'theme': {
        if (!rawArg) throw new Error('theme needs a value');
        saved = applyAndPersist({ theme: rawArg });
        break;
      }
      case 'font': {
        if (!rawArg) throw new Error('font needs a value');
        saved = applyAndPersist({ font: rawArg });
        break;
      }
      case 'fonturl': {
        saved = applyAndPersist({ fontUrl: rawArg || "" });
        break;
      }
      case 'bg': { // bg:true/false
        const v = (rawArg||'').toLowerCase();
        saved = applyAndPersist({ showBg: v === '1' || v === 'true' || v === 'on' });
        break;
      }
      case 'stroke': { // stroke:<size>,<color>
        if (!rawArg) throw new Error('stroke needs "<size>,<color>"');
        const [sw, sc] = rawArg.split(',');
        const size = Number.parseFloat(sw);
        saved = applyAndPersist({
          strokeWidth: Number.isFinite(size) ? size : strokeWidth,
          strokeColor: sc || strokeColor
        });
        break;
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
    return saved;
  }

  function parsePayload(payload) {
    const text = decodeURIComponent(payload);
    const parts = text.split(':'); // [token, app, action, arg?]
    if (parts.length < 3) throw new Error('payload format: token:app:action[:arg]');
    const [token, appName, action, ...rest] = parts;
    const arg = rest.length ? rest.join(':') : undefined;
    if (token !== WEBHOOK_TOKEN) throw new Error('invalid token');
    if (appName !== APP_NAME)    throw new Error('invalid app name');
    return { action, arg };
  }

  overlayApp.get('/hook/:payload', (req, res) => {
    try {
      const { action, arg } = parsePayload(req.params.payload);
      const saved = handleWebhookAction(action, arg);
      res.json({ ok: true, action, state: saved });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  overlayApp.post('/hook/:payload', (req, res) => {
    try {
      const { action, arg } = parsePayload(req.params.payload);
      const saved = handleWebhookAction(action, arg);
      res.json({ ok: true, action, state: saved });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  overlayApp.get(/^\/([^/]+:[^/]+:[^/]+(?::[^/]+)?)$/, (req, res) => {
    try {
      const payload = req.path.slice(1);
      const { action, arg } = parsePayload(payload);
      const saved = handleWebhookAction(action, arg);
      res.json({ ok: true, action, state: saved });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  overlayApp.post(/^\/([^/]+:[^/]+:[^/]+(?::[^/]+)?)$/, (req, res) => {
    try {
      const payload = req.path.slice(1);
      const { action, arg } = parsePayload(payload);
      const saved = handleWebhookAction(action, arg);
      res.json({ ok: true, action, state: saved });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  overlayApp.listen(3000, () => console.log('✅ Overlay running at http://localhost:3000'));

  // ==== WebSocket ====
  const wss = new WebSocket.Server({ port: 8080 });
  wss.on('connection', ws => {
    wsClients.push(ws);
    ws.send(JSON.stringify({
      type: 'state',
      data: { maxWin, current: count, theme, font, fontUrl, showBg, strokeWidth, strokeColor }
    }));
    ws.on('close', () => { wsClients = wsClients.filter(c => c !== ws); });
  });

  try {
    fs.watch(CONFIG_PATH, { persistent: false }, () => { loadConfig(); broadcastState(); });
  } catch (e) { console.warn('watch config error:', e); }

  // shortcuts
  globalShortcut.register('Alt+=', () => applyAndPersist({ current: count + 1 }));
  globalShortcut.register('Alt+-', () => applyAndPersist({ current: count - 1 }));

  // เริ่มเช็กอัปเดต: ครั้งแรกหลัง ready แล้วค่อยทุก 60 วิ (กันซ้อนด้วย flag)
  setTimeout(() => safeCheckForUpdates(), 3000);
  setInterval(() => safeCheckForUpdates(), 60 * 1000);

  createWindow();
});

// Quit
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
