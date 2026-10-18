import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanClaudeSessions, liveClaudeSessions, transcriptMtime, type ClaudeLive } from './claude.js';
import { scanCodexSessions } from './codex.js';
import { listPanes, createSession, hasSession, renameSession, killSession, paneDescendants, type TmuxPane } from './tmux.js';
import { loadSettings } from './settings.js';
import { projectName, HOME, APP_DIR } from './config.js';
import { shQuote } from './shell.js';
import { trustFolder } from './trust.js';
import { renameInWorkspaceOps, pruneWorkspaceOps } from './workspaces.js';
import { sortSessions, buildProjects } from '../shared/snapshot.js';
import type { Session, Snapshot, Agent, PendingLaunch, Placement, LostSession } from '../shared/types.js';

const WORKING_WINDOW_MS = 8000;

/** Launches whose transcript/thread id is not known yet. Persisted so a server restart keeps the mapping. */
const PENDING_FILE = path.join(APP_DIR, 'pending.json');
const pending = new Map<string, PendingLaunch>();
try { for (const p of JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) as PendingLaunch[]) pending.set(p.tmux, p); } catch { /* none */ }
function savePending(): void {
  fs.writeFile(PENDING_FILE, JSON.stringify([...pending.values()]), () => {});
}

/** Sessions the phone started that the Mac has not put in a workspace yet (see `Placement`). Keyed by tmux name. */
const PLACEMENTS_FILE = path.join(APP_DIR, 'placements.json');
const placements = new Map<string, Placement>();
try { for (const p of JSON.parse(fs.readFileSync(PLACEMENTS_FILE, 'utf8')) as Placement[]) placements.set(p.tmux, p); } catch { /* none */ }
function savePlacements(): void {
  fs.writeFile(PLACEMENTS_FILE, JSON.stringify([...placements.values()]), () => {});
}

export function placeSession(tmux: string, cwd: string, workspace?: string): void {
  placements.set(tmux, { tmux, cwd, workspace: typeof workspace === 'string' && workspace ? workspace : undefined, at: Date.now() });
  savePlacements();
}

export function clearPlacement(tmux: string): void {
  if (placements.delete(tmux)) savePlacements();
}

/**
 * Old tmux name -> the name that pane carries now. A pane gets renamed when Claude moves to a new
 * session id (/clear) or a Codex launch learns its thread id; the UI follows its panes through this
 * map instead of guessing. Persisted so a server restart does not orphan open panes.
 */
const RENAMES_FILE = path.join(APP_DIR, 'renames.json');
const renames = new Map<string, string>();
try { for (const [from, to] of Object.entries(JSON.parse(fs.readFileSync(RENAMES_FILE, 'utf8')) as Record<string, string>)) renames.set(from, to); } catch { /* none */ }
function saveRenames(): void {
  fs.writeFile(RENAMES_FILE, JSON.stringify(Object.fromEntries(renames)), () => {});
}

async function rename(from: string, to: string): Promise<void> {
  await renameSession(from, to);
  // Keep every entry pointing at the current name, so a pane renamed twice resolves in one step.
  for (const [k, v] of renames) if (v === from) renames.set(k, to);
  renames.set(from, to);
  saveRenames();
  const placed = placements.get(from);
  if (placed) { placements.delete(from); placements.set(to, { ...placed, tmux: to }); savePlacements(); }
  renameInWorkspaceOps(from, to);
}

/** Forget renames whose target is gone; nothing can follow them any more. */
function pruneRenames(panes: TmuxPane[]): void {
  const alive = new Set(panes.map((p) => p.session));
  let changed = false;
  for (const [k, v] of renames) if (!alive.has(v) || alive.has(k)) { renames.delete(k); changed = true; }
  if (changed) saveRenames();
}

/**
 * What ran in the tmux server at the last look, and the sessions a dead tmux server took with it. A
 * shutdown kills tmux; the next look sees a different server start time (or no server), and every session
 * of the old server that is not running now is lost, not closed. The UI keeps those panes and resumes them.
 */
const LIVE_FILE = path.join(APP_DIR, 'live.json');
const LOST_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
let liveRecord: { serverStart: number; sessions: LostSession[] } = { serverStart: 0, sessions: [] };
const lost = new Map<string, LostSession>();
try {
  const j = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
  if (Array.isArray(j.sessions)) liveRecord = { serverStart: Number(j.serverStart) || 0, sessions: j.sessions };
  for (const l of (j.lost ?? []) as LostSession[]) lost.set(l.tmux, l);
} catch { /* none */ }
let liveJson = '';
function saveLive(): void {
  const j = JSON.stringify({ ...liveRecord, lost: [...lost.values()] });
  if (j === liveJson) return;
  liveJson = j;
  fs.writeFile(LIVE_FILE, j, () => {});
}

function trackLost(panes: TmuxPane[], sessions: Session[]): void {
  const now = Date.now();
  const alive = new Set(panes.map((p) => p.session));
  const serverStart = panes[0]?.serverStart ?? 0;
  if (liveRecord.serverStart && serverStart !== liveRecord.serverStart) {
    for (const s of liveRecord.sessions) if (!alive.has(s.tmux) && !lost.has(s.tmux)) lost.set(s.tmux, { ...s, at: now });
  }
  // Only sessions with a conversation on disk can be resumed; a fresh launch that never got one cannot.
  const current: LostSession[] = [];
  for (const s of sessions) {
    if (s.live?.kind !== 'tmux' || s.live.dead || !s.transcriptPath) continue;
    current.push({ tmux: s.live.tmux, agent: s.agent, id: s.id, cwd: s.cwd, at: now });
  }
  // The UI only uses entries for panes it still has, so one nobody resumed for two weeks can go.
  for (const [t, l] of lost) if (alive.has(t) || now - l.at > LOST_MAX_AGE_MS) lost.delete(t);
  const same = current.length === liveRecord.sessions.length && current.every((c, i) => liveRecord.sessions[i].tmux === c.tmux && liveRecord.sessions[i].id === c.id && liveRecord.sessions[i].cwd === c.cwd);
  if (serverStart) liveRecord = { serverStart, sessions: same ? liveRecord.sessions : current };
  else liveRecord = { serverStart: 0, sessions: [] };
  saveLive();
}

export function lostSessions(): LostSession[] {
  return [...lost.values()];
}

/** Resume a lost session. Its pane follows a new tmux name through the rename map, like after /clear. */
export async function resumeLost(tmux: string, s: Session, o: { skipPermissions?: boolean } = {}): Promise<{ tmux: string }> {
  const r = await resumeSession(s, o);
  if (r.tmux !== tmux) {
    for (const [k, v] of renames) if (v === tmux) renames.set(k, r.tmux);
    renames.set(tmux, r.tmux);
    saveRenames();
  }
  lost.delete(tmux);
  saveLive();
  return r;
}

export function lostSession(tmux: string): LostSession | undefined {
  return lost.get(tmux);
}

function tmuxName(agent: Agent, id: string): string {
  return `ms-${agent}-${id}`;
}

function parseTmuxName(name: string): { agent: Agent; id: string } | null {
  const m = name.match(/^ms-(claude|codex)-(.+)$/);
  if (!m) return null;
  return { agent: m[1] as Agent, id: m[2] };
}

export async function buildSnapshot(): Promise<Snapshot> {
  const settings = loadSettings();
  const [claude, codex, panes] = await Promise.all([
    Promise.resolve(scanClaudeSessions()),
    scanCodexSessions(),
    listPanes(),
  ]);
  const liveClaude = liveClaudeSessions();
  await resolvePendingCodex(codex, panes);

  const paneRegistry = await reconcilePaneNames(panes, liveClaude);
  pruneRenames(panes);
  // A placement whose session ended before the Mac saw it has nowhere to go.
  const alive = new Set(panes.map((p) => p.session));
  for (const t of placements.keys()) if (!alive.has(t)) clearPlacement(t);
  pruneWorkspaceOps(alive);
  const paneForKey = new Map<string, TmuxPane>();
  const attachedPanes = new Set<string>();
  for (const p of panes) {
    const parsed = parseTmuxName(p.session);
    if (!parsed) continue;
    const id = paneRegistry.get(p.session)?.sessionId ?? parsed.id;
    const key = `${parsed.agent}:${id}`;
    if (!paneForKey.has(key)) paneForKey.set(key, p);
  }

  const now = Date.now();
  const sessions: Session[] = [];
  const byKey = new Map<string, Session>();

  for (const s of [...claude, ...codex]) {
    if (s.importedFrom && !settings.showImported) continue;
    if (s.archived) continue;
    const pane = paneForKey.get(s.key);
    if (pane) attachedPanes.add(pane.session);
    const reg = s.agent === 'claude' ? liveClaude.get(s.id) : undefined;
    if (reg?.name) s.agentName = reg.name;

    if (pane) {
      s.live = { kind: 'tmux', tmux: pane.session, dead: pane.dead, pid: pane.pid };
      if (pane.dead) s.status = 'ended';
      else if (reg?.status) s.status = reg.status === 'idle' ? 'waiting' : 'working';
      else {
        const mt = s.transcriptPath ? transcriptMtime(s.transcriptPath) : 0;
        const recent = now - Math.max(mt, pane.activity) < WORKING_WINDOW_MS;
        s.status = recent ? 'working' : 'waiting';
      }
      s.updatedAt = Math.max(s.updatedAt, pane.activity);
    } else if (reg) {
      s.live = { kind: 'external', pid: reg.pid };
      s.status = reg.status === 'idle' ? 'waiting' : 'working';
    } else {
      s.status = 'idle';
    }
    if (s.loop && !loopArmed(s, reg, now)) s.loop = undefined;
    if (s.loop && s.status === 'waiting') s.status = 'looping';
    sessions.push(s);
    byKey.set(s.key, s);
  }

  // tmux sessions we manage that have no transcript yet (fresh launches)
  for (const p of panes) {
    if (attachedPanes.has(p.session)) continue;
    const parsed = parseTmuxName(p.session);
    if (!parsed) continue;
    const key = `${parsed.agent}:${parsed.id}`;
    if (byKey.has(key)) continue;
    const pend = pending.get(p.session);
    const reg = paneRegistry.get(p.session);
    const cwd = pend?.cwd || reg?.cwd || HOME;
    const s: Session = {
      key, id: parsed.id, agent: parsed.agent, cwd, project: projectName(cwd),
      title: reg?.name ? `New session (${reg.name})` : pend ? 'New session' : 'Session',
      agentName: reg?.name,
      firstPrompt: '', createdAt: p.created, updatedAt: Math.max(p.activity, p.created),
      live: { kind: 'tmux', tmux: p.session, dead: p.dead, pid: p.pid },
      status: p.dead ? 'ended' : (now - p.activity < WORKING_WINDOW_MS ? 'working' : 'waiting'),
    };
    sessions.push(s);
    byKey.set(key, s);
  }

  trackLost(panes, sessions);
  sortSessions(sessions);
  const extraDirs = settings.extraProjectDirs.filter((d) => fs.existsSync(d)).map((cwd) => ({ cwd, name: projectName(cwd) }));
  const projects = buildProjects(sessions, extraDirs);

  return { generatedAt: now, sessions, projects, extraDirs, pending: [...pending.values()], renamed: Object.fromEntries(renames), placements: [...placements.values()] };
}

/** A wakeup this long overdue while the session sits at the prompt was the last one: the tick ran and did not reschedule. */
const WAKE_GRACE_MS = 2 * 60 * 1000;

/** Loops live in the Claude process, so they count only while it runs and only if it scheduled them itself. */
function loopArmed(s: Session, reg: ClaudeLive | undefined, now: number): boolean {
  const l = s.loop;
  if (!l || !s.live || s.status === 'ended' || s.status === 'idle') return false;
  if (reg?.startedAt && (l.lastAt ?? 0) < reg.startedAt) return false;
  if (l.kind === 'self-paced' && l.nextAt && l.nextAt < now - WAKE_GRACE_MS && s.status !== 'working') return false;
  return true;
}

/**
 * Claude Code can move a process onto a new session id after launch (/clear, or resuming a session that
 * was still open elsewhere). Rename such panes so the tmux name follows the process, and return the
 * registry entry for every pane that has one. Panes are updated in place.
 */
async function reconcilePaneNames(panes: TmuxPane[], liveClaude: Map<string, ClaudeLive>): Promise<Map<string, ClaudeLive>> {
  const liveByPid = new Map<number, ClaudeLive>();
  for (const r of liveClaude.values()) liveByPid.set(r.pid, r);
  const names = new Set(panes.map((p) => p.session));
  const out = new Map<string, ClaudeLive>();
  for (const p of panes) {
    const parsed = parseTmuxName(p.session);
    if (!parsed || parsed.agent !== 'claude') continue;
    let reg = liveByPid.get(p.pid);
    if (!reg) for (const pid of await paneDescendants(p.pid)) { reg = liveByPid.get(pid); if (reg) break; }
    if (!reg) continue;
    if (reg.sessionId !== parsed.id) {
      const target = tmuxName('claude', reg.sessionId);
      if (!names.has(target)) {
        await rename(p.session, target);
        names.delete(p.session); names.add(target);
        p.session = target;
      }
    }
    out.set(p.session, reg);
  }
  return out;
}

async function resolvePendingCodex(codex: Session[], panes: TmuxPane[]): Promise<void> {
  const alive = new Set(panes.map((p) => p.session));
  for (const [tmux, p] of pending) {
    if (!alive.has(tmux)) { pending.delete(tmux); savePending(); continue; }
    if (p.agent !== 'codex') continue;
    const taken = new Set(panes.map((x) => x.session));
    const candidates = codex
      .filter((s) => s.cwd === p.cwd && s.createdAt >= p.startedAt - 2000 && !taken.has(tmuxName('codex', s.id)))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (candidates.length) {
      await rename(tmux, tmuxName('codex', candidates[0].id));
      pending.delete(tmux);
      savePending();
    }
  }
}

export interface LaunchOptions {
  agent: Agent;
  cwd: string;
  prompt?: string;
  extraArgs?: string[];
  skipPermissions?: boolean;
  createFolder?: boolean;  // make the folder first (one level: its parent must exist)
}

export interface FolderInfo { path: string; exists: boolean; isDir: boolean; parent: string; parentExists: boolean }

/** What the New session dialog needs to say about a typed folder before launching there. */
export function folderInfo(raw: string): FolderInfo {
  const p = path.resolve(raw.trim().replace(/^~(?=\/|$)/, HOME));
  const parent = path.dirname(p);
  let st: fs.Stats | null = null;
  try { st = fs.statSync(p); } catch { /* missing */ }
  let parentExists = false;
  try { parentExists = fs.statSync(parent).isDirectory(); } catch { /* missing */ }
  return { path: p, exists: !!st, isDir: !!st?.isDirectory(), parent, parentExists };
}

function claudeArgs(settings: ReturnType<typeof loadSettings>, o: LaunchOptions): string[] {
  const args = [...(settings.claudeArgs || [])].filter((a) => a !== '--dangerously-skip-permissions');
  if (o.skipPermissions !== false) args.push('--dangerously-skip-permissions');
  args.push(...(o.extraArgs || []));
  return args;
}

function codexArgs(settings: ReturnType<typeof loadSettings>, o: LaunchOptions): string[] {
  const args = [...(settings.codexArgs || [])];
  if (o.skipPermissions !== false && !args.some((a) => a.includes('bypass') || a === '--full-auto' || a === '--yolo')) args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push(...(o.extraArgs || []));
  return args;
}

export async function launchNew(o: LaunchOptions): Promise<{ tmux: string; key?: string }> {
  const settings = loadSettings();
  o.cwd = o.cwd.trim().replace(/^~(?=\/|$)/, HOME);
  if (!path.isAbsolute(o.cwd)) throw new Error('Use a full path, such as ~/repos/my-project.');
  const f = folderInfo(o.cwd);
  if (f.exists && !f.isDir) throw new Error(`Not a folder: ${o.cwd}`);
  if (!f.exists) {
    if (!o.createFolder) throw new Error(`Folder does not exist: ${o.cwd}`);
    if (!f.parentExists) throw new Error(`Cannot create ${path.basename(f.path)}: ${f.parent} does not exist.`);
    fs.mkdirSync(f.path);
  }
  o.cwd = f.path;
  if (o.agent === 'claude') {
    if (settings.trustFolders) await trustFolder(o.cwd);
    const id = randomUUID();
    const name = tmuxName('claude', id);
    const parts = ['claude', '--session-id', id, ...claudeArgs(settings, o)];
    if (o.prompt) parts.push(shQuote(o.prompt));
    await createSession(name, o.cwd, parts.join(' '));
    pending.set(name, { tmux: name, agent: 'claude', cwd: o.cwd, startedAt: Date.now() });
    savePending();
    return { tmux: name, key: `claude:${id}` };
  }
  const name = `ms-codex-new-${Date.now().toString(36)}`;
  const parts = ['codex', ...codexArgs(settings, o)];
  if (o.prompt) parts.push(shQuote(o.prompt));
  await createSession(name, o.cwd, parts.join(' '));
  pending.set(name, { tmux: name, agent: 'codex', cwd: o.cwd, startedAt: Date.now() });
  savePending();
  return { tmux: name };
}

export async function resumeSession(s: Session, o: { skipPermissions?: boolean; fork?: boolean } = {}): Promise<{ tmux: string }> {
  const settings = loadSettings();
  const name = tmuxName(s.agent, s.id);
  if (s.agent === 'claude') {
    // Make pane names follow their processes first, so a pane that moved to another id does not shadow this one.
    const panes = await listPanes();
    const reg = await reconcilePaneNames(panes, liveClaudeSessions());
    const existing = panes.find((p) => p.session === name);
    if (existing && (reg.get(name)?.sessionId ?? s.id) === s.id) return { tmux: name };
    if (existing) throw new Error('A different session is running in this pane. Kill it first, then resume.');
  } else if (await hasSession(name)) return { tmux: name };
  const cwd = fs.existsSync(s.cwd) ? s.cwd : HOME;
  if (s.agent === 'claude') {
    if (settings.trustFolders) await trustFolder(cwd);
    const parts = ['claude', '--resume', s.id, ...claudeArgs(settings, { agent: 'claude', cwd, skipPermissions: o.skipPermissions })];
    if (o.fork) parts.push('--fork-session');
    await createSession(name, cwd, parts.join(' '));
  } else {
    const parts = ['codex', o.fork ? 'fork' : 'resume', s.id, ...codexArgs(settings, { agent: 'codex', cwd, skipPermissions: o.skipPermissions })];
    await createSession(name, cwd, parts.join(' '));
  }
  return { tmux: name };
}

export async function closeTmux(name: string): Promise<void> {
  // A session closed on purpose is not lost, even if it was the last one and tmux looks gone next time.
  liveRecord.sessions = liveRecord.sessions.filter((s) => s.tmux !== name);
  lost.delete(name);
  saveLive();
  await killSession(name);
  pending.delete(name);
  savePending();
}

export function listProjectDirs(): string[] {
  const roots = [path.join(HOME, 'projects'), path.join(HOME, 'repos')];
  const out: string[] = [];
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) out.push(path.join(r, d.name));
    } catch { /* missing */ }
  }
  return out;
}
