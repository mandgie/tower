const { app, BrowserWindow, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.MS_PORT || 4310);
const DEV = process.env.MS_DEV === '1';
const URL = DEV ? 'http://localhost:5173' : `http://127.0.0.1:${PORT}`;

let serverProc = null;
let win = null;

function portOpen() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/settings`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (await portOpen()) return; // already running (dev, or another window)
  const bundle = path.join(__dirname, '..', 'dist', 'server.cjs');
  serverProc = spawn(process.execPath, [bundle], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MS_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  serverProc.on('exit', (code) => { console.log('[server] exited', code); serverProc = null; });
  for (let i = 0; i < 100; i++) {
    if (await portOpen()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not start');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 500,
    title: 'Tower',
    backgroundColor: '#12171D',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, spellcheck: false },
  });
  win.loadURL(URL);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
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

app.setName('Tower');
app.whenReady().then(async () => {
  buildMenu();
  try { await ensureServer(); } catch (e) { console.error(e); }
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { if (serverProc) serverProc.kill(); });
