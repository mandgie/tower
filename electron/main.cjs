const { app, BrowserWindow, Menu, shell, utilityProcess, nativeImage, screen, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const DEV = process.env.MS_DEV === '1';
// Packaged app: pick a free port (remembered between launches so localStorage keeps its origin).
// Dev (`npm run dev`): fixed 4310 behind the Vite dev server. MS_PORT always wins.
const FIXED_PORT = process.env.MS_PORT ? Number(process.env.MS_PORT) : DEV ? 4310 : 0;
const APP_NAME = app.isPackaged ? 'Tower' : 'Tower Dev';

// Keep a dev checkout and the installed app apart: separate name, userData, single-instance lock.
app.setName(APP_NAME);
const userData = path.join(app.getPath('appData'), APP_NAME);
if (!app.isPackaged) migrateDevUserData(userData);
app.setPath('userData', userData);
app.setPath('sessionData', userData);

const STATE_FILE = path.join(userData, 'window-state.json');
const PORT_FILE = path.join(userData, 'server.json');

let server = null;      // utilityProcess running dist/server.cjs
let serverPort = 0;
let win = null;

/** One-time copy of the old shared userData ("Tower") into "Tower Dev" so dev keeps its workspaces. */
function migrateDevUserData(dest) {
  const old = path.join(app.getPath('appData'), 'Tower');
  if (fs.existsSync(dest) || !fs.existsSync(old)) return;
  try { fs.cpSync(old, dest, { recursive: true, errorOnExist: false, force: true }); } catch (e) { console.warn('[dev] userData copy failed', e.message); }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, data) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.warn('[state] write failed', file, e.message); } }

function portOpen(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/settings`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

/** Start the server bundle in an Electron utility process and wait for it to report its port. */
async function ensureServer() {
  if (FIXED_PORT && (await portOpen(FIXED_PORT))) { serverPort = FIXED_PORT; return; } // dev server already up
  const preferred = FIXED_PORT || Number(readJson(PORT_FILE)?.port) || 0;
  const bundle = path.join(__dirname, '..', 'dist', 'server.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (preferred) env.MS_PORT = String(preferred); else delete env.MS_PORT;

  serverPort = await new Promise((resolve, reject) => {
    let settled = false;
    const child = utilityProcess.fork(bundle, [], { serviceName: 'tower-server', env, stdio: 'inherit' });
    server = child;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Server did not report a port within 20s')); } }, 20000);
    child.on('message', (m) => {
      if (m && m.type === 'listening' && !settled) { settled = true; clearTimeout(timer); resolve(Number(m.port)); }
    });
    child.on('exit', (code) => {
      console.log('[server] exited', code);
      if (server === child) server = null;
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); }
    });
  });
  if (!FIXED_PORT) writeJson(PORT_FILE, { port: serverPort });
}

function appUrl() { return DEV ? 'http://localhost:5173' : `http://127.0.0.1:${serverPort}`; }

// ---- window state -------------------------------------------------------------------------

function loadWindowState() {
  const s = readJson(STATE_FILE);
  if (!s || !s.bounds) return null;
  const b = s.bounds;
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  // Only restore onto a display that still exists and overlaps the saved bounds.
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + b.height > a.y;
  });
  return visible ? s : null;
}

let saveTimer = null;
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const fullScreen = win.isFullScreen();
  const bounds = maximized || fullScreen ? (readJson(STATE_FILE)?.bounds || win.getNormalBounds()) : win.getNormalBounds();
  writeJson(STATE_FILE, { bounds, maximized, fullScreen });
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400); }

// ---- window ------------------------------------------------------------------------------

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 500,
    ...(state ? state.bounds : {}),
    title: APP_NAME,
    backgroundColor: '#12171D',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, spellcheck: false },
  });
  if (state?.maximized) win.maximize();
  if (state?.fullScreen) win.setFullScreen(true);
  win.loadURL(appUrl());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', () => { clearTimeout(saveTimer); saveWindowState(); });
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', scheduleSave);
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const send = (cmd) => () => win?.webContents.send('command', cmd);

function buildMenu() {
  const template = [
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Session', submenu: [
      { label: 'New Session', accelerator: 'Cmd+N', click: send('new') },
      { label: 'New Session Here', accelerator: 'Cmd+D', click: send('duplicate') },
      { label: 'Find Session', accelerator: 'Cmd+K', click: send('search') },
      { type: 'separator' },
      { label: 'Remove Pane from Workspace', accelerator: 'Cmd+W', click: send('close-pane') },
      { label: 'Maximize Pane', accelerator: 'Cmd+Shift+Enter', click: send('maximize') },
      { label: 'Focus Left', accelerator: 'Cmd+Alt+Left', click: send('focus:left') },
      { label: 'Focus Right', accelerator: 'Cmd+Alt+Right', click: send('focus:right') },
      { label: 'Focus Up', accelerator: 'Cmd+Alt+Up', click: send('focus:up') },
      { label: 'Focus Down', accelerator: 'Cmd+Alt+Down', click: send('focus:down') },
    ] },
    { label: 'Workspace', submenu: [
      { label: 'New Workspace', accelerator: 'Cmd+T', click: send('new-workspace') },
      { label: 'Rename Workspace', accelerator: 'Cmd+Shift+R', click: send('rename-workspace') },
      { label: 'Next Workspace', accelerator: 'Cmd+Shift+]', click: send('next-workspace') },
      { label: 'Previous Workspace', accelerator: 'Cmd+Shift+[', click: send('prev-workspace') },
      { type: 'separator' },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `Workspace ${n}`, accelerator: `Cmd+${n}`, click: send(`workspace:${n}`) })),
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Toggle Session List', accelerator: 'Cmd+B', click: send('toggle-sidebar') },
      { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The packaged app gets its icon from the bundle; a dev checkout sets the Dock icon by hand. */
function setDevDockIcon() {
  if (app.isPackaged || process.platform !== 'darwin' || !app.dock) return;
  for (const file of ['icon.png', 'icon.icns']) {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', file));
    if (!img.isEmpty()) { app.dock.setIcon(img); return; }
  }
}

// ---- lifecycle ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    setDevDockIcon();
    buildMenu();
    try {
      await ensureServer();
    } catch (e) {
      console.error(e);
      dialog.showErrorBox(APP_NAME, `The Tower server did not start.\n\n${e.message}`);
      app.quit();
      return;
    }
    createWindow();
  });

  // macOS: closing the window keeps the app (and its server) alive in the Dock.
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    if (server) { server.kill(); server = null; }
  });
}
