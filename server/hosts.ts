import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { APP_DIR } from './config.js';
import { uploadFile } from './uploads.js';
import { applyDelta } from '../shared/snapshot.js';
import { onHost, splitHost, validHostName } from '../shared/hosts.js';
import type { HostInfo, LostSession, PendingLaunch, Placement, Session, Snapshot, SnapshotEvent, WorkspaceOp, WorkspaceSummary } from '../shared/types.js';

/**
 * Hosts: other Tower servers (a VM on Tailscale that runs the sessions which must not stop when the Mac
 * travels). This server pairs with a host the way a phone does, keeps its status feed open, and shows the
 * host's sessions as its own under `@host:` addresses (shared/hosts.ts). Requests and terminals for an
 * address go to the host with the prefix taken off. The last snapshot from each host stays on disk, so its
 * panes survive while the host is out of reach, also across a restart of this server.
 */

interface HostConfig { name: string; url: string; token: string }
interface Conn {
  cfg: HostConfig;
  snap: Snapshot | null;
  seenAt?: number;
  online: boolean;
  error?: string;
  ws?: WebSocket;
  retry: number;
  timer?: NodeJS.Timeout;
  closed?: boolean;
}

/**
 * A feed can die without a close: after the Mac sleeps or Tailscale changes its route, the socket stays
 * open here while the host has long dropped it, and the host's sessions would freeze as they last were.
 * Ping it; a feed that has not answered by the next ping is gone.
 */
const PING_MS = 15_000;

const FILE = path.join(APP_DIR, 'hosts.json');
const CACHE = path.join(APP_DIR, 'hosts-cache.json');
const COOKIE = 'tower_token';

const conns = new Map<string, Conn>();
let onChange: () => void = () => {};

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveConfig(): void {
  fs.writeFileSync(FILE, JSON.stringify([...conns.values()].map((c) => c.cfg), null, 2), { mode: 0o600 });
}

let cacheTimer: NodeJS.Timeout | undefined;
function saveCache(): void {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    const out: Record<string, { snap: Snapshot; seenAt?: number }> = {};
    for (const c of conns.values()) if (c.snap) out[c.cfg.name] = { snap: c.snap, seenAt: c.seenAt };
    try { fs.writeFileSync(CACHE, JSON.stringify(out)); } catch (e) { console.error('[hosts] cache write failed', e); }
  }, 2000);
}

/** `x-tower-owner`: the request comes from the Tower that owns the host's workspaces, not from a phone. */
function headers(c: HostConfig): Record<string, string> {
  return { cookie: `${COOKIE}=${encodeURIComponent(c.token)}`, origin: c.url, 'x-tower-owner': '1' };
}

function connect(c: Conn): void {
  if (c.closed) return;
  const ws = new WebSocket(`${c.cfg.url.replace(/^http/, 'ws')}/ws/events?v=2`, { headers: headers(c.cfg), handshakeTimeout: 10_000 });
  c.ws = ws;
  let alive = true;
  let ping: NodeJS.Timeout | undefined;
  ws.on('open', () => {
    c.retry = 1000;
    ping = setInterval(() => {
      if (!alive) { c.error = 'The host stopped answering'; ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, PING_MS);
  });
  ws.on('pong', () => { alive = true; });
  ws.on('message', (raw) => {
    let m: SnapshotEvent;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    c.snap = m.t === 'full' ? m.snapshot : applyDelta(c.snap ?? { generatedAt: 0, sessions: [], projects: [], extraDirs: [], pending: [], renamed: {} }, m);
    c.seenAt = Date.now();
    const changed = !c.online || c.error;
    c.online = true; c.error = undefined;
    if (changed) console.log(`[hosts] ${c.cfg.name} online`);
    saveCache();
    onChange();
  });
  ws.on('unexpected-response', (_req, res) => {
    c.error = res.statusCode === 401 || res.statusCode === 403 ? 'Not paired: the host has a new pairing token' : `HTTP ${res.statusCode}`;
    ws.terminate();
  });
  ws.on('error', (e) => { c.error = c.error || e.message; });
  ws.on('close', () => {
    clearInterval(ping);
    if (c.ws !== ws) return;
    if (c.online) console.log(`[hosts] ${c.cfg.name} offline${c.error ? `: ${c.error}` : ''}`);
    c.online = false; c.ws = undefined;
    onChange();
    if (c.closed) return;
    c.timer = setTimeout(() => connect(c), c.retry);
    c.retry = Math.min(c.retry * 2, 30_000);
  });
}

function open(cfg: HostConfig, cached?: { snap: Snapshot; seenAt?: number }): void {
  const c: Conn = { cfg, snap: cached?.snap ?? null, seenAt: cached?.seenAt, online: false, retry: 1000 };
  conns.set(cfg.name, c);
  connect(c);
}

function close(c: Conn): void {
  c.closed = true;
  clearTimeout(c.timer);
  c.ws?.terminate();
  conns.delete(c.cfg.name);
}

/** Connect to the saved hosts; `changed` runs when a host's sessions or its state change. */
export function startHosts(changed: () => void): void {
  onChange = changed;
  const cache = readJson<Record<string, { snap: Snapshot; seenAt?: number }>>(CACHE, {});
  for (const cfg of readJson<HostConfig[]>(FILE, [])) open(cfg, cache[cfg.name]);
}

export function hostsInfo(): HostInfo[] {
  return [...conns.values()].map((c) => ({ name: c.cfg.name, url: c.cfg.url, online: c.online, error: c.online ? undefined : c.error, seenAt: c.seenAt }));
}

/**
 * Pair with a host from its pairing link (`http://tower-1.tailnet.ts.net:4311/pair?t=…`, from the host's
 * Settings). The name defaults to the first label of its address.
 */
export async function addHost(pairUrl: string, name?: string): Promise<HostInfo> {
  let u: URL;
  try { u = new URL(pairUrl.trim()); } catch { throw new Error('That is not a link. Paste the pairing link from the other Tower.'); }
  const token = u.searchParams.get('t');
  if (!token || !/^https?:$/.test(u.protocol)) throw new Error('Paste the pairing link (it ends in /pair?t=…).');
  const cfg: HostConfig = { name: (name || u.hostname.split('.')[0]).toLowerCase(), url: u.origin, token };
  if (!validHostName(cfg.name)) throw new Error('Use a name with lowercase letters, digits and dashes.');
  const r = await fetch(`${cfg.url}/api/settings`, { headers: headers(cfg), signal: AbortSignal.timeout(8000) }).catch((e) => {
    throw new Error(`Cannot reach ${u.host}: ${(e as Error).message}`);
  });
  if (r.status === 401) throw new Error('The host does not accept that pairing link. Copy a new one from its Settings.');
  if (!r.ok) throw new Error(`The host answered HTTP ${r.status}.`);
  const old = conns.get(cfg.name);
  if (old) close(old);
  open(cfg, old?.snap ? { snap: old.snap, seenAt: old.seenAt } : undefined);
  saveConfig();
  onChange();
  return hostsInfo().find((h) => h.name === cfg.name)!;
}

export function removeHost(name: string): void {
  const c = conns.get(name);
  if (!c) throw new Error(`No host named ${name}`);
  close(c);
  saveConfig();
  saveCache();
  onChange();
}

// ---- the host's snapshot under addresses -------------------------------------------------------

function mapSession(host: string, s: Session): Session {
  const a = (x: string) => onHost(host, x);
  return {
    ...s,
    key: a(s.key),
    id: a(s.id),
    cwd: a(s.cwd),
    host,
    transcriptPath: undefined,
    live: s.live?.kind === 'tmux' ? { ...s.live, tmux: a(s.live.tmux) } : undefined,
    todo: undefined,
    spawn: s.spawn && {
      ...s.spawn,
      parentKey: s.spawn.parentKey && a(s.spawn.parentKey),
      parentTmux: s.spawn.parentTmux && a(s.spawn.parentTmux),
    },
  };
}

/** The hosts' sessions and the lists that name their tmux sessions, ready to add to this server's snapshot. */
export function hostParts(): {
  sessions: Session[]; pending: PendingLaunch[]; renamed: Record<string, string>; lost: LostSession[];
  placements: Placement[]; workspaces: Record<string, WorkspaceSummary[]>; workspaceOps: WorkspaceOp[];
} {
  const out = {
    sessions: [] as Session[], pending: [] as PendingLaunch[], renamed: {} as Record<string, string>, lost: [] as LostSession[],
    placements: [] as Placement[], workspaces: {} as Record<string, WorkspaceSummary[]>, workspaceOps: [] as WorkspaceOp[],
  };
  for (const c of conns.values()) {
    if (!c.snap) continue;
    const h = c.cfg.name;
    const a = (x: string) => onHost(h, x);
    for (const s of c.snap.sessions) out.sessions.push(mapSession(h, s));
    for (const p of c.snap.pending ?? []) out.pending.push({ ...p, tmux: a(p.tmux), cwd: a(p.cwd) });
    for (const [from, to] of Object.entries(c.snap.renamed ?? {})) out.renamed[a(from)] = a(to);
    for (const l of c.snap.lost ?? []) out.lost.push({ ...l, tmux: a(l.tmux), id: a(l.id), cwd: a(l.cwd) });
    // The host's workspaces, and the changes queued for them: this Mac applies them and writes the result back.
    out.workspaces[h] = (c.snap.workspaces ?? []).map((w) => ({ ...w, id: a(w.id), panes: w.panes.map(a) }));
    for (const p of c.snap.placements ?? []) {
      out.placements.push({ ...p, tmux: a(p.tmux), cwd: a(p.cwd), workspace: p.workspace && a(p.workspace), after: p.after && a(p.after), host: h });
    }
    for (const o of c.snap.workspaceOps ?? []) {
      const id = a(o.id);
      if (o.op === 'move') out.workspaceOps.push({ ...o, id, tmux: a(o.tmux), to: o.to && a(o.to) });
      else out.workspaceOps.push({ ...o, id, workspace: a(o.workspace) });
    }
  }
  return out;
}

// ---- requests to a host -------------------------------------------------------------------------

function conn(host: string): Conn {
  const c = conns.get(host);
  if (!c) throw new Error(`Unknown host ${host}`);
  return c;
}

/** A request to the host's API; throws with the host's error text when it does not answer 2xx. */
export async function hostApi<T = any>(host: string, method: string, apiPath: string, body?: unknown): Promise<T> {
  const c = conn(host);
  const r = await fetch(`${c.cfg.url}${apiPath}`, {
    method,
    headers: { ...headers(c.cfg), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw new Error(`${host} is out of reach (${(e as Error).message})`); });
  const text = await r.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!r.ok) throw new Error(typeof data === 'object' && data?.error ? `${host}: ${data.error}` : `${host} answered HTTP ${r.status}`);
  return data as T;
}

/** Pictures sent from the phone are saved here; the host's agent needs its own copy, at a path on the host. */
export async function forwardUploads(host: string, files: string[]): Promise<string[]> {
  const c = conn(host);
  const out: string[] = [];
  for (const file of files) {
    const f = uploadFile(path.basename(file));
    if (!f) continue;
    const r = await fetch(`${c.cfg.url}/api/uploads`, {
      method: 'POST',
      headers: { ...headers(c.cfg), 'content-type': f.type },
      body: fs.readFileSync(f.file),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`${host} did not take the picture (HTTP ${r.status})`);
    out.push((await r.json()).path);
  }
  return out;
}

/** Join a browser's terminal socket to the host's terminal for `tmux` (a name on the host). */
export function pipeTerminal(client: WebSocket, host: string, tmux: string, cols: number, rows: number): void {
  const c = conns.get(host);
  if (!c) { client.close(4004, 'unknown host'); return; }
  const q = new URLSearchParams({ tmux, cols: String(cols || 120), rows: String(rows || 30) });
  const remote = new WebSocket(`${c.cfg.url.replace(/^http/, 'ws')}/ws/term?${q}`, { headers: headers(c.cfg), handshakeTimeout: 10_000 });
  const early: { data: Buffer; binary: boolean }[] = [];
  client.on('message', (data: Buffer, binary) => {
    if (remote.readyState === remote.OPEN) remote.send(data, { binary });
    else if (remote.readyState === remote.CONNECTING) early.push({ data, binary });
  });
  remote.on('open', () => { for (const m of early.splice(0)) remote.send(m.data, { binary: m.binary }); });
  remote.on('message', (data: Buffer, binary) => { if (client.readyState === client.OPEN) client.send(binary ? data : data.toString()); });
  const end = () => { try { client.close(); } catch { /* gone */ } try { remote.terminate(); } catch { /* gone */ } };
  remote.on('close', end);
  remote.on('error', end);
  client.on('close', end);
  client.on('error', end);
}

export { splitHost };
