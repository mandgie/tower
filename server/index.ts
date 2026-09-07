import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT } from './config.js';
import { buildSnapshot, launchNew, resumeSession, closeTmux, listProjectDirs } from './sessions.js';
import { claudeTranscript } from './claude.js';
import { codexTranscript } from './codex.js';
import { ensureServer, capturePane, sendKeys } from './tmux.js';
import { attachTerminal } from './pty.js';
import { loadSettings, saveSettings } from './settings.js';
import { runDoctor, doctorSummary } from './doctor.js';
import type { Snapshot } from '../shared/types.js';

const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(here, '..', 'ui', 'dist');

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

let snapshot: Snapshot = { generatedAt: 0, sessions: [], projects: [], pending: [] };
let snapshotJson = '';
const eventClients = new Set<WebSocket>();
let refreshing = false;
let refreshQueued = false;

async function refresh(): Promise<Snapshot> {
  if (refreshing) { refreshQueued = true; return snapshot; }
  refreshing = true;
  try {
    const next = await buildSnapshot();
    const json = JSON.stringify(next);
    // Compare without the timestamp so unchanged state does not spam clients.
    const strip = (s: Snapshot) => JSON.stringify({ ...s, generatedAt: 0 });
    const changed = strip(next) !== strip(snapshot);
    snapshot = next; snapshotJson = json;
    if (changed) for (const c of eventClients) if (c.readyState === c.OPEN) c.send(json);
  } catch (e) {
    console.error('[snapshot] failed', e);
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; setTimeout(refresh, 200); }
  }
  return snapshot;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = url.pathname;
  const m = req.method;
  try {
    if (m === 'GET' && p === '/api/sessions') return json(res, 200, snapshotJson || JSON.stringify(await refresh()));
    if (m === 'POST' && p === '/api/refresh') return json(res, 200, await refresh());
    if (m === 'GET' && p === '/api/settings') return json(res, 200, loadSettings());
    if (m === 'PUT' && p === '/api/settings') { const s = saveSettings(await readBody(req)); refresh(); return json(res, 200, s); }
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
    mm = p.match(/^\/api\/tmux\/([^/]+)\/(kill|capture|send)$/);
    if (mm) {
      const name = decodeURIComponent(mm[1]);
      if (mm[2] === 'kill' && m === 'POST') { await closeTmux(name); setTimeout(refresh, 200); return json(res, 200, { ok: true }); }
      if (mm[2] === 'capture') return json(res, 200, { text: await capturePane(name, Number(url.searchParams.get('lines') || 60)) });
      if (mm[2] === 'send' && m === 'POST') { const b = await readBody(req); await sendKeys(name, b.text || '', b.enter !== false); return json(res, 200, { ok: true }); }
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  serveStatic(req, res, url);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/ws/events') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      eventClients.add(ws);
      ws.on('close', () => eventClients.delete(ws));
      if (snapshotJson) ws.send(snapshotJson);
    });
  } else if (url.pathname === '/ws/term') {
    const name = url.searchParams.get('tmux');
    if (!name) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachTerminal(ws, name, Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows')));
    });
  } else socket.destroy();
});

async function main() {
  runDoctor().then((r) => console.log(`[doctor] ${doctorSummary(r)}`));
  await ensureServer().catch((e) => console.error('[tmux] ensure failed', e));
  await refresh();
  setInterval(refresh, 2000);
  try {
    fs.watch(path.join(process.env.HOME || '', '.claude', 'sessions'), () => setTimeout(refresh, 100));
  } catch { /* dir may not exist */ }
  listen(PORT);
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
