import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT } from './config.js';
import { buildSnapshot, launchNew, resumeSession, closeTmux, listProjectDirs } from './sessions.js';
import { claudeTranscript } from './claude.js';
import { codexTranscript } from './codex.js';
import { ensureServer, capturePane, sendKeys, pressKeys, paneModes, scrollPane } from './tmux.js';
import { attachTerminal } from './pty.js';
import { loadSettings, saveSettings } from './settings.js';
import { loadWorkspaces, saveWorkspaces } from './workspaces.js';
import { runDoctor, doctorSummary } from './doctor.js';
import { applyRemote, remoteInfo, rotateToken, isPaired, isLoopback, peerAllowed, originMatchesHost, handlePair, unpairedPage } from './remote.js';
import type { Snapshot, SnapshotDelta } from '../shared/types.js';

const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(here, '..', 'ui', 'dist');

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

let snapshot: Snapshot = { generatedAt: 0, sessions: [], projects: [], extraDirs: [], pending: [], renamed: {} };
/** Last sent JSON per session key, and per top-level field, so a tick only ships what changed. */
let sentSessions = new Map<string, string>();
let sentFields: Record<string, string> = {};
/** The full snapshot as JSON, built on demand: most ticks only need the delta. */
let snapshotJson = '';
const fullJson = () => snapshotJson || (snapshotJson = JSON.stringify(snapshot));
/** Status feeds that take deltas (`?v=2`), and older pages (a phone with a cached build) that want whole snapshots. */
const deltaClients = new Set<WebSocket>();
const legacyClients = new Set<WebSocket>();
/** Remote status feeds (one per open device) and every remote socket, so unpairing can cut them all. */
const remoteClients = new Set<WebSocket>();
const remoteSockets = new Set<WebSocket>();
let refreshing = false;
let refreshQueued = false;

const DELTA_FIELDS = ['extraDirs', 'pending', 'renamed', 'workspaces'] as const;

async function refresh(): Promise<Snapshot> {
  if (refreshing) { refreshQueued = true; return snapshot; }
  refreshing = true;
  try {
    const next = await buildSnapshot();
    next.workspaces = loadWorkspaces();
    const delta: SnapshotDelta = { generatedAt: next.generatedAt, upsert: [], remove: [] };
    const sessions = new Map<string, string>();
    for (const s of next.sessions) {
      const j = JSON.stringify(s);
      sessions.set(s.key, j);
      if (sentSessions.get(s.key) !== j) delta.upsert.push(s);
    }
    for (const k of sentSessions.keys()) if (!sessions.has(k)) delta.remove.push(k);
    const fields: Record<string, string> = {};
    let changed = delta.upsert.length > 0 || delta.remove.length > 0;
    for (const f of DELTA_FIELDS) {
      fields[f] = JSON.stringify(next[f] ?? null);
      if (fields[f] !== sentFields[f]) { (delta as any)[f] = next[f]; changed = true; }
    }
    snapshot = next; snapshotJson = '';
    sentSessions = sessions; sentFields = fields;
    if (changed) {
      const msg = JSON.stringify({ t: 'delta', ...delta });
      for (const c of deltaClients) if (c.readyState === c.OPEN) c.send(msg);
      if (legacyClients.size) { const full = fullJson(); for (const c of legacyClients) if (c.readyState === c.OPEN) c.send(full); }
    }
  } catch (e) {
    console.error('[snapshot] failed', e);
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 200); }
  }
  return snapshot;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, remote: boolean): Promise<void> {
  const p = url.pathname;
  const m = req.method;
  try {
    // Pairing is managed from the Mac only; a paired phone cannot read the token or mint a new one.
    if (p.startsWith('/api/remote')) {
      if (remote) return json(res, 403, { error: 'Only available on the Mac' });
      if (m === 'GET' && p === '/api/remote') return json(res, 200, await remoteInfo(loadSettings(), remoteClients.size));
      if (m === 'POST' && p === '/api/remote/rotate') {
        rotateToken();
        for (const c of remoteSockets) c.close(4001, 'unpaired');
        return json(res, 200, await remoteInfo(loadSettings(), 0));
      }
    }
    if (m === 'GET' && p === '/api/sessions') { if (!snapshot.generatedAt) await refresh(); return json(res, 200, fullJson()); }
    if (m === 'POST' && p === '/api/refresh') return json(res, 200, await refresh());
    if (m === 'GET' && p === '/api/settings') return json(res, 200, loadSettings());
    if (m === 'PUT' && p === '/api/settings') {
      const s = saveSettings(await readBody(req));
      refresh();
      if (!remote) await applyRemote(s, () => createServer(true));
      return json(res, 200, s);
    }
    if (m === 'PUT' && p === '/api/workspaces') {
      // The Mac owns the workspaces; the phone only reads them from the snapshot.
      if (remote) return json(res, 403, { error: 'Only available on the Mac' });
      saveWorkspaces(await readBody(req));
      refresh();
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/projects/dirs') return json(res, 200, { dirs: listProjectDirs() });
    if (m === 'GET' && p === '/api/doctor') return json(res, 200, await runDoctor());

    let mm = p.match(/^\/api\/sessions\/(claude|codex)\/([^/]+)\/(transcript|resume|fork)$/);
    if (mm) {
      const key = `${mm[1]}:${mm[2]}`;
      const s = snapshot.sessions.find((x) => x.key === key) || (await refresh()).sessions.find((x) => x.key === key);
      if (!s) return json(res, 404, { error: 'Unknown session' });
      if (mm[3] === 'transcript') {
        if (!s.transcriptPath) return json(res, 200, { messages: [], stats: { turns: 0, assistantMessages: 0, toolCalls: 0, filesTouched: 0, subagents: 0, compactions: 0, activeMs: 0 } });
        const result = s.agent === 'claude' ? await claudeTranscript(s.transcriptPath) : await codexTranscript(s.transcriptPath);
        return json(res, 200, result);
      }
      if (m === 'POST') {
        const body = await readBody(req);
        const r = await resumeSession(s, { skipPermissions: body.skipPermissions, fork: mm[3] === 'fork' });
        setTimeout(refresh, 300);
        return json(res, 200, r);
      }
    }
    if (m === 'POST' && p === '/api/sessions/new') {
      const body = await readBody(req);
      const r = await launchNew(body);
      setTimeout(refresh, 300);
      return json(res, 200, r);
    }
    mm = p.match(/^\/api\/tmux\/([^/]+)\/(kill|capture|send|keys|scroll)$/);
    if (mm) {
      const name = decodeURIComponent(mm[1]);
      if (mm[2] === 'kill' && m === 'POST') { await closeTmux(name); setTimeout(refresh, 200); return json(res, 200, { ok: true }); }
      if (mm[2] === 'capture') {
        const modes = await paneModes(name);
        return json(res, 200, { text: await capturePane(name, Number(url.searchParams.get('lines') || 60)), ...modes });
      }
      if (mm[2] === 'scroll' && m === 'POST') { const b = await readBody(req); await scrollPane(name, Number(b.lines) || 0); return json(res, 200, { ok: true }); }
      if (mm[2] === 'send' && m === 'POST') { const b = await readBody(req); await sendKeys(name, String(b.text || ''), b.enter !== false); setTimeout(refresh, 300); return json(res, 200, { ok: true }); }
      if (mm[2] === 'keys' && m === 'POST') { const b = await readBody(req); await pressKeys(name, Array.isArray(b.keys) ? b.keys.map(String) : []); setTimeout(refresh, 300); return json(res, 200, { ok: true }); }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('[api]', p, e);
    json(res, 500, { error: (e as Error).message });
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  let file = path.join(UI_DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(UI_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(UI_DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('UI not built. Run: npm run build:ui'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/** The loopback listener only answers to loopback names, which defeats DNS rebinding. */
function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || isLoopback(name);
}

/** Browsers send Origin on WebSockets and writes; another site's page must not reach the terminals. */
function originAllowed(req: http.IncomingMessage, remote: boolean): boolean {
  if (remote) return originMatchesHost(req);
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return loopbackHost(new URL(origin).host); } catch { return false; }
}

/** Local requests must name a loopback host; remote ones need the pairing cookie. False means the request was already answered. */
function gate(req: http.IncomingMessage, res: http.ServerResponse, url: URL, remote: boolean): boolean {
  if (!remote) {
    if (!loopbackHost(req.headers.host)) { res.writeHead(421); res.end(); return false; }
  } else {
    if (url.pathname === '/pair') { handlePair(req, res, url); return false; }
    if (!isPaired(req)) {
      if (url.pathname.startsWith('/api/')) json(res, 401, { error: 'Not paired' });
      else unpairedPage(res);
      return false;
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req, remote)) { json(res, 403, { error: 'Bad origin' }); return false; }
  return true;
}

const wss = new WebSocketServer({ noServer: true });

function createServer(remote: boolean): http.Server {
  const s = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!gate(req, res, url, remote)) return;
    if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url, remote);
    serveStatic(req, res, url);
  });
  if (remote) {
    s.on('connection', (sock) => {
      if (!peerAllowed(sock.remoteAddress, loadSettings().remoteAllowLan)) sock.destroy();
    });
  }
  s.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head, remote));
  return s;
}

function onUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, remote: boolean): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const ok = originAllowed(req, remote) && (remote ? isPaired(req) : loopbackHost(req.headers.host));
  if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const track = (ws: WebSocket) => {
    if (!remote) return;
    remoteSockets.add(ws);
    ws.on('close', () => remoteSockets.delete(ws));
  };
  if (url.pathname === '/ws/events') {
    const deltas = url.searchParams.get('v') === '2';
    wss.handleUpgrade(req, socket, head, (ws) => {
      track(ws);
      const set = deltas ? deltaClients : legacyClients;
      set.add(ws);
      if (remote) remoteClients.add(ws);
      ws.on('close', () => { set.delete(ws); remoteClients.delete(ws); });
      if (snapshot.generatedAt) ws.send(deltas ? `{"t":"full","snapshot":${fullJson()}}` : fullJson());
    });
  } else if (url.pathname === '/ws/term') {
    const name = url.searchParams.get('tmux');
    if (!name) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      track(ws);
      attachTerminal(ws, name, Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows')));
    });
  } else socket.destroy();
}

const server = createServer(false);

async function main() {
  runDoctor().then((r) => console.log(`[doctor] ${doctorSummary(r)}`));
  await ensureServer().catch((e) => console.error('[tmux] ensure failed', e));
  await refresh();
  setInterval(refresh, 2000);
  try {
    fs.watch(path.join(process.env.HOME || '', '.claude', 'sessions'), () => setTimeout(refresh, 100));
  } catch { /* dir may not exist */ }
  listen(PORT);
  applyRemote(loadSettings(), () => createServer(true));
}

/** Listen on `port`; if a preferred port is taken, fall back to a free one (port 0). */
function listen(port: number): void {
  const onError = (e: NodeJS.ErrnoException) => {
    if (port && e.code === 'EADDRINUSE') { console.warn(`[multisession] port ${port} busy, picking a free one`); listen(0); return; }
    console.error('[multisession] listen failed', e);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', onError);
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`[multisession] http://127.0.0.1:${actual}`);
    // Under Electron's utilityProcess the main process waits for this message to learn the port.
    const parentPort = (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort;
    parentPort?.postMessage({ type: 'listening', port: actual });
  });
}
main();
