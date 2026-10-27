import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT, APP_DIR, setServerUrl } from './config.js';
import { buildSnapshot, launchNew, resumeSession, resumeLost, lostSession, lostSessions, closeTmux, listProjectDirs, folderInfo, placeSession, clearPlacement } from './sessions.js';
import { claudeTranscript } from './claude.js';
import { codexTranscript } from './codex.js';
import { ensureServer, capturePane, sendKeys, pressKeys, paneModes, scrollPane } from './tmux.js';
import { attachTerminal } from './pty.js';
import { loadSettings, saveSettings } from './settings.js';
import { saveUpload, isUpload, uploadFile } from './uploads.js';
import { applyDone, setViewing } from './seen.js';
import { loadWorkspaces, saveWorkspaces, workspaceOps, addWorkspaceOp, clearWorkspaceOp } from './workspaces.js';
import { runDoctor, doctorSummary } from './doctor.js';
import { todoState, todoTick, scanWorkspace, setTodoStatus, startTodo, removeTodoWorktree, todoWorktreeTick, linkTodoSessions, checkTodoFinish, dismissFinish, onTodosChange } from './todos.js';
import { spawnAgent, agentState, listAgents, sendToAgent, stopAgent, linkAgentSessions } from './agents.js';
import { applyRemote, remoteInfo, rotateToken, isPaired, isLoopback, peerAllowed, originMatchesHost, handlePair, unpairedPage } from './remote.js';
import { startHosts, hostsInfo, hostParts, addHost, removeHost, hostApi, forwardUploads, pipeTerminal } from './hosts.js';
import { onHost, splitHost } from '../shared/hosts.js';
import { buildProjects, sortSessions } from '../shared/snapshot.js';
import type { Snapshot, SnapshotDelta } from '../shared/types.js';

const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(here, '..', 'ui', 'dist');

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

let snapshot: Snapshot = { generatedAt: 0, sessions: [], projects: [], extraDirs: [], pending: [], renamed: {} };
/** The same without the hosts' sessions: todos and `tower` agents only see sessions that run here. */
let localSnap: Snapshot = snapshot;
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

const DELTA_FIELDS = ['extraDirs', 'pending', 'renamed', 'workspaces', 'placements', 'workspaceOps', 'todos', 'todoScans', 'lost', 'hosts'] as const;

async function refresh(): Promise<Snapshot> {
  if (refreshing) { refreshQueued = true; return snapshot; }
  refreshing = true;
  try {
    let next = await buildSnapshot();
    applyDone(next.sessions);
    next.workspaces = loadWorkspaces();
    next.workspaceOps = workspaceOps();
    next.lost = lostSessions();
    Object.assign(next, todoState());
    linkTodoSessions(next.sessions, next.renamed);
    linkAgentSessions(next);
    checkTodoFinish(next.sessions, next.renamed);
    todoTick(next.workspaces, next.sessions);
    todoWorktreeTick(next.sessions);
    const local = next;
    next = withHosts(local);
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
    snapshot = next; localSnap = local; snapshotJson = '';
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

/** This server's snapshot with the hosts' sessions added (server/hosts.ts). */
function withHosts(local: Snapshot): Snapshot {
  const hosts = hostsInfo();
  if (!hosts.length) return local;
  const h = hostParts();
  const sessions = sortSessions([...local.sessions, ...h.sessions]);
  return {
    ...local,
    sessions,
    projects: buildProjects(sessions, local.extraDirs),
    pending: [...local.pending, ...h.pending],
    renamed: { ...local.renamed, ...h.renamed },
    lost: [...(local.lost ?? []), ...h.lost],
    hosts,
  };
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

/**
 * Requests that name something on a host (`@host:` in a tmux name, session id, folder or session key) go
 * to that host with the prefix taken off, and names in the answer get it back. True when answered here.
 */
async function hostRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  const m = req.method;
  const answer = async (fn: () => Promise<unknown>) => {
    try { json(res, 200, await fn()); } catch (e) { json(res, 502, { error: (e as Error).message }); }
    setTimeout(refresh, 300);
    return true;
  };
  let mm = p.match(/^\/api\/sessions\/(claude|codex)\/([^/]+)\/(transcript|resume|fork)$/);
  const sid = mm && splitHost(decodeURIComponent(mm[2]));
  if (mm && sid) {
    const at = `/api/sessions/${mm[1]}/${encodeURIComponent(sid.name)}/${mm[3]}`;
    if (mm[3] === 'transcript') return answer(() => hostApi(sid.host, 'GET', at));
    const { place, ...body } = await readBody(req);
    return answer(async () => {
      const r = await hostApi<{ tmux: string }>(sid.host, 'POST', at, body);
      const tmux = onHost(sid.host, r.tmux);
      const s = snapshot.sessions.find((x) => x.id === decodeURIComponent(mm![2]));
      if (place && s) placeSession(tmux, s.cwd, place.workspace);
      return { ...r, tmux };
    });
  }
  mm = p.match(/^\/api\/lost\/([^/]+)\/resume$/);
  const lost = mm && splitHost(decodeURIComponent(mm[1]));
  if (mm && lost && m === 'POST') {
    const body = await readBody(req);
    return answer(async () => {
      const r = await hostApi<{ tmux: string }>(lost.host, 'POST', `/api/lost/${encodeURIComponent(lost.name)}/resume`, body);
      return { ...r, tmux: onHost(lost.host, r.tmux) };
    });
  }
  mm = p.match(/^\/api\/tmux\/([^/]+)\/(kill|capture|send|keys|scroll)$/);
  const pane = mm && splitHost(decodeURIComponent(mm[1]));
  if (mm && pane) {
    const at = `/api/tmux/${encodeURIComponent(pane.name)}/${mm[2]}${url.search}`;
    if (mm[2] === 'capture') return answer(() => hostApi(pane.host, 'GET', at));
    const body = await readBody(req);
    return answer(async () => {
      if (Array.isArray(body.files) && body.files.length) body.files = await forwardUploads(pane.host, body.files.filter(isUpload));
      return hostApi(pane.host, 'POST', at, body);
    });
  }
  if (m === 'POST' && p === '/api/sessions/new') {
    // Read once here; the local route reads the same body again from this copy.
    const body = await readBody(req);
    const dir = typeof body.cwd === 'string' ? splitHost(body.cwd.trim()) : null;
    if (!dir) { (req as any).tower_body = body; return false; }
    const { place, ...rest } = body;
    return answer(async () => {
      const r = await hostApi<{ tmux: string; key?: string; cwd?: string }>(dir.host, 'POST', '/api/sessions/new', { ...rest, cwd: dir.name });
      const tmux = onHost(dir.host, r.tmux);
      if (place) placeSession(tmux, body.cwd.trim(), place.workspace);
      return { ...r, tmux, key: r.key && onHost(dir.host, r.key) };
    });
  }
  if (m === 'GET' && p === '/api/folder') {
    const at = splitHost(url.searchParams.get('path') || '');
    if (!at) return false;
    return answer(async () => {
      const f = await hostApi<{ path: string; parent: string }>(at.host, 'GET', `/api/folder?path=${encodeURIComponent(at.name)}`);
      return { ...f, path: onHost(at.host, f.path), parent: onHost(at.host, f.parent) };
    });
  }
  if (m === 'GET' && p === '/api/projects/dirs') {
    const dirs = [...listProjectDirs()];
    await Promise.all(hostsInfo().filter((h) => h.online).map(async (h) => {
      try { for (const d of (await hostApi<{ dirs: string[] }>(h.name, 'GET', '/api/projects/dirs')).dirs) dirs.push(onHost(h.name, d)); } catch { /* offline */ }
    }));
    json(res, 200, { dirs });
    return true;
  }
  if (m === 'POST' && p === '/api/seen') {
    // Each server marks its own turns as read: pass the hosts' keys on, keep the rest for seen.ts.
    const b = await readBody(req);
    const keys: string[] = Array.isArray(b.keys) ? b.keys.filter((k: unknown) => typeof k === 'string').slice(0, 64) : [];
    const client = String(b.client || '').slice(0, 64);
    const byHost = new Map<string, string[]>();
    for (const h of hostsInfo()) if (h.online) byHost.set(h.name, []);
    const mine: string[] = [];
    for (const k of keys) { const a = splitHost(k); if (a && byHost.has(a.host)) byHost.get(a.host)!.push(a.name); else if (!a) mine.push(k); }
    for (const [h, ks] of byHost) hostApi(h, 'POST', '/api/seen', { client, keys: ks }).catch(() => {});
    setViewing(client, mine);
    refresh();
    json(res, 200, { ok: true });
    return true;
  }
  return false;
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
    if (p.startsWith('/api/hosts')) {
      // Pairing with a host is managed from the Mac, like the phone's pairing.
      if (remote) return json(res, 403, { error: 'Only available on the Mac' });
      if (m === 'GET' && p === '/api/hosts') return json(res, 200, hostsInfo());
      if (m === 'POST' && p === '/api/hosts') {
        const b = await readBody(req);
        try { return json(res, 200, await addHost(String(b.pairUrl || ''), b.name ? String(b.name) : undefined)); }
        catch (e) { return json(res, 400, { error: (e as Error).message }); }
      }
      const one = p.match(/^\/api\/hosts\/([^/]+)$/);
      if (m === 'DELETE' && one) {
        try { removeHost(decodeURIComponent(one[1])); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 404, { error: (e as Error).message }); }
      }
    }
    if (await hostRoute(req, res, url)) return;
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
    if (m === 'POST' && p === '/api/workspaces/ops') {
      // The phone asks; the Mac applies (see WorkspaceOp). An explicit move replaces an automatic placement.
      let op;
      try { op = addWorkspaceOp(await readBody(req)); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
      if (op.op === 'move') clearPlacement(op.tmux);
      refresh();
      return json(res, 200, op);
    }
    const doneOp = p.match(/^\/api\/workspaces\/ops\/([^/]+)$/);
    if (m === 'DELETE' && doneOp) {
      if (remote) return json(res, 403, { error: 'Only available on the Mac' });
      clearWorkspaceOp(decodeURIComponent(doneOp[1]));
      refresh();
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/todos/scan') {
      // Scan now: read the workspace's quiet sessions without waiting for the next round.
      const b = await readBody(req);
      const w = loadWorkspaces().find((x) => x.id === b.workspace);
      if (!w) return json(res, 404, { error: 'Unknown workspace' });
      scanWorkspace(w, localSnap.sessions, true);
      return json(res, 200, { ok: true });
    }
    const startT = p.match(/^\/api\/todos\/([^/]+)\/start$/);
    if (m === 'POST' && startT) {
      const b = await readBody(req);
      const r = await startTodo(decodeURIComponent(startT[1]), localSnap.sessions, b.skipPermissions);
      setTimeout(refresh, 300);
      return json(res, 200, r);
    }
    const rmWt = p.match(/^\/api\/todos\/([^/]+)\/worktree$/);
    if (m === 'DELETE' && rmWt) {
      // Remove the todo's worktree and branch; ?force=1 also when work would be lost.
      try { return json(res, 200, await removeTodoWorktree(decodeURIComponent(rmWt[1]), localSnap.sessions, url.searchParams.get('force') === '1')); }
      catch (e) { return json(res, 409, { error: (e as Error).message }); }
    }
    const todo = p.match(/^\/api\/todos\/([^/]+)$/);
    if (m === 'POST' && todo) {
      const b = await readBody(req);
      if (b.dismissFinish) {
        try { return json(res, 200, dismissFinish(decodeURIComponent(todo[1]))); } catch (e) { return json(res, 404, { error: (e as Error).message }); }
      }
      if (!['proposed', 'accepted', 'done', 'rejected'].includes(b.status)) return json(res, 400, { error: 'Bad status' });
      try { return json(res, 200, setTodoStatus(decodeURIComponent(todo[1]), b.status)); } catch (e) { return json(res, 404, { error: (e as Error).message }); }
    }
    const placed = p.match(/^\/api\/placements\/([^/]+)$/);
    if (m === 'DELETE' && placed) {
      // The desktop clears a placement once the pane is in a workspace.
      if (remote) return json(res, 403, { error: 'Only available on the Mac' });
      clearPlacement(decodeURIComponent(placed[1]));
      refresh();
      return json(res, 200, { ok: true });
    }
    const up = m === 'GET' && p.match(/^\/api\/uploads\/([\w.-]+)$/);
    if (up) {
      const f = uploadFile(up[1]);
      if (!f) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': f.type, 'cache-control': 'private, max-age=604800, immutable' });
      fs.createReadStream(f.file).pipe(res);
      return;
    }
    if (m === 'POST' && p === '/api/seen') {
      // Which sessions a window shows now, so a turn that ends there is not marked unread (see seen.ts).
      const b = await readBody(req);
      const keys = Array.isArray(b.keys) ? b.keys.filter((k: unknown) => typeof k === 'string').slice(0, 64) : [];
      setViewing(String(b.client || '').slice(0, 64), keys);
      refresh();
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/uploads') {
      // A picture from the phone, sent as raw bytes with its image type.
      try { return json(res, 200, { path: await saveUpload(req) }); } catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }
    if (m === 'GET' && p === '/api/projects/dirs') return json(res, 200, { dirs: listProjectDirs() });
    if (m === 'GET' && p === '/api/folder') return json(res, 200, folderInfo(url.searchParams.get('path') || ''));
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
        if (body.place) placeSession(r.tmux, s.cwd, body.place.workspace);
        setTimeout(refresh, 300);
        return json(res, 200, r);
      }
    }
    mm = p.match(/^\/api\/lost\/([^/]+)\/resume$/);
    if (mm && m === 'POST') {
      const name = decodeURIComponent(mm[1]);
      const l = lostSession(name);
      if (!l) return json(res, 404, { error: 'Nothing to resume' });
      const key = `${l.agent}:${l.id}`;
      const s = snapshot.sessions.find((x) => x.key === key) || (await refresh()).sessions.find((x) => x.key === key);
      if (!s) return json(res, 404, { error: 'Unknown session' });
      const body = await readBody(req);
      const r = await resumeLost(name, s, { skipPermissions: body.skipPermissions });
      setTimeout(refresh, 300);
      return json(res, 200, r);
    }
    if (p.startsWith('/api/agents')) {
      // The `tower` command in a session on this Mac (cli/tower.mjs); not for the phone.
      if (remote) return json(res, 403, { error: 'Only available on the Mac' });
      const q = url.searchParams;
      try {
        if (m === 'POST' && p === '/api/agents/spawn') {
          const r = await spawnAgent(localSnap, await readBody(req));
          await refresh();
          return json(res, 200, r);
        }
        if (m === 'GET' && p === '/api/agents') return json(res, 200, listAgents(localSnap, q.get('from'), q.get('all') === '1'));
        if (m === 'GET' && p === '/api/agents/state') return json(res, 200, agentState(localSnap, q.get('from'), q.get('ref'), q.get('reply') === '1'));
        if (m === 'POST' && p === '/api/agents/send') {
          const b = await readBody(req);
          const r = await sendToAgent(localSnap, b.from, b.ref, b.text);
          setTimeout(refresh, 300);
          return json(res, 200, r);
        }
        if (m === 'POST' && p === '/api/agents/stop') {
          const b = await readBody(req);
          const r = await stopAgent(localSnap, b.from, b.ref);
          setTimeout(refresh, 200);
          return json(res, 200, r);
        }
      } catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }
    if (m === 'POST' && p === '/api/sessions/new') {
      const body = (req as any).tower_body ?? await readBody(req);
      const r = await launchNew(body);
      // launchNew resolves body.cwd in place (~, new folders), so the placement matches the session's folder.
      if (body.place) placeSession(r.tmux, body.cwd, body.place.workspace);
      setTimeout(refresh, 300);
      return json(res, 200, r);
    }
    mm = p.match(/^\/api\/tmux\/([^/]+)\/(kill|capture|send|keys|scroll)$/);
    if (mm) {
      const name = decodeURIComponent(mm[1]);
      if (mm[2] === 'kill' && m === 'POST') { await closeTmux(name); setTimeout(refresh, 200); return json(res, 200, { ok: true }); }
      if (mm[2] === 'capture') {
        const modes = await paneModes(name);
        return json(res, 200, { text: await capturePane(name, Number(url.searchParams.get('lines') || 60), true), ...modes });
      }
      if (mm[2] === 'scroll' && m === 'POST') { const b = await readBody(req); await scrollPane(name, Number(b.lines) || 0); return json(res, 200, { ok: true }); }
      if (mm[2] === 'send' && m === 'POST') {
        const b = await readBody(req);
        const files = Array.isArray(b.files) ? b.files.filter(isUpload) : [];
        await sendKeys(name, String(b.text || ''), b.enter !== false, files);
        setTimeout(refresh, 300);
        return json(res, 200, { ok: true });
      }
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
    const pane = splitHost(name);
    wss.handleUpgrade(req, socket, head, (ws) => {
      track(ws);
      const cols = Number(url.searchParams.get('cols')), rows = Number(url.searchParams.get('rows'));
      if (pane) pipeTerminal(ws, pane.host, pane.name, cols, rows);
      else attachTerminal(ws, name, cols, rows);
    });
  } else socket.destroy();
}

const server = createServer(false);

async function main() {
  runDoctor().then((r) => console.log(`[doctor] ${doctorSummary(r)}`));
  await ensureServer().catch((e) => console.error('[tmux] ensure failed', e));
  onTodosChange(() => setTimeout(refresh, 50));
  startHosts(() => setTimeout(refresh, 50));
  await refresh();
  setInterval(refresh, 2000);
  try {
    fs.watch(path.join(process.env.HOME || '', '.claude', 'sessions'), () => setTimeout(refresh, 100));
  } catch { /* dir may not exist */ }
  listen(PORT);
  applyRemote(loadSettings(), () => createServer(true));
}

/**
 * Put the `tower` command (cli/tower.mjs) in APP_DIR/bin, which every session Tower starts has on PATH, and
 * say where this server listens for sessions that did not get TOWER_URL. The dev server (no Electron parent,
 * shared APP_DIR) leaves server.json to the app.
 */
function installCli(port: number): void {
  try {
    const src = fs.readFileSync(path.resolve(here, '..', 'cli', 'tower.mjs'), 'utf8');
    const bin = path.join(APP_DIR, 'bin');
    const dest = path.join(bin, 'tower');
    fs.mkdirSync(bin, { recursive: true });
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== src) fs.writeFileSync(dest, src, { mode: 0o755 });
    const owner = (process as unknown as { parentPort?: unknown }).parentPort || process.env.MS_APP_DIR;
    if (owner) fs.writeFileSync(path.join(APP_DIR, 'server.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid }));
  } catch (e) {
    console.error('[agents] could not install the tower command', e);
  }
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
    setServerUrl(`http://127.0.0.1:${actual}`);
    installCli(actual);
    // Under Electron's utilityProcess the main process waits for this message to learn the port.
    const parentPort = (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort;
    parentPort?.postMessage({ type: 'listening', port: actual });
  });
}
main();
