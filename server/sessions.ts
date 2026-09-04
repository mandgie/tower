import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanClaudeSessions, liveClaudeSessions, transcriptMtime, type ClaudeLive } from './claude.js';
import { scanCodexSessions } from './codex.js';
import { listPanes, createSession, hasSession, renameSession, killSession, paneDescendants, type TmuxPane } from './tmux.js';
import { loadSettings } from './settings.js';
import { projectName, HOME, APP_DIR } from './config.js';
import { shQuote } from './shell.js';
import type { Session, Project, Snapshot, Agent, PendingLaunch } from '../shared/types.js';

const WORKING_WINDOW_MS = 8000;

/** Launches whose transcript/thread id is not known yet. Persisted so a server restart keeps the mapping. */
const PENDING_FILE = path.join(APP_DIR, 'pending.json');
const pending = new Map<string, PendingLaunch>();
try { for (const p of JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) as PendingLaunch[]) pending.set(p.tmux, p); } catch { /* none */ }
function savePending(): void {
  fs.writeFile(PENDING_FILE, JSON.stringify([...pending.values()]), () => {});
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

  // Map each tmux pane to the session it is really running. Claude Code can move a process onto a new
  // session id after launch (/clear, or resuming a session that was still open elsewhere), so the pane
  // name alone is not enough: prefer the pid recorded in Claude's live registry.
  const liveByPid = new Map<number, ClaudeLive>();
  for (const r of liveClaude.values()) liveByPid.set(r.pid, r);
  const paneForKey = new Map<string, TmuxPane>();
  const attachedPanes = new Set<string>();
  for (const p of panes) {
    const parsed = parseTmuxName(p.session);
    if (!parsed) continue;
    let id = parsed.id;
    if (parsed.agent === 'claude') {
      let reg = liveByPid.get(p.pid);
      if (!reg) for (const pid of await paneDescendants(p.pid)) { reg = liveByPid.get(pid); if (reg) break; }
      if (reg) id = reg.sessionId;
    }
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
    const cwd = pend?.cwd || HOME;
    const s: Session = {
      key, id: parsed.id, agent: parsed.agent, cwd, project: projectName(cwd),
      title: pend ? 'New session' : 'Session',
      firstPrompt: '', createdAt: p.created, updatedAt: Math.max(p.activity, p.created),
      live: { kind: 'tmux', tmux: p.session, dead: p.dead, pid: p.pid },
      status: p.dead ? 'ended' : (now - p.activity < WORKING_WINDOW_MS ? 'working' : 'waiting'),
    };
    sessions.push(s);
    byKey.set(key, s);
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  const projMap = new Map<string, Project>();
  for (const s of sessions) {
    let p = projMap.get(s.cwd);
    if (!p) { p = { cwd: s.cwd, name: s.project, sessions: [], updatedAt: 0, liveCount: 0 }; projMap.set(s.cwd, p); }
    p.sessions.push(s.key);
    p.updatedAt = Math.max(p.updatedAt, s.updatedAt);
    if (s.live && s.status !== 'ended') p.liveCount++;
  }
  for (const dir of settings.extraProjectDirs) {
    if (!projMap.has(dir) && fs.existsSync(dir)) projMap.set(dir, { cwd: dir, name: projectName(dir), sessions: [], updatedAt: 0, liveCount: 0 });
  }
  const projects = [...projMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  return { generatedAt: now, sessions, projects, pending: [...pending.values()] };
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
      await renameSession(tmux, tmuxName('codex', candidates[0].id));
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
  o.cwd = o.cwd.replace(/^~(?=\/|$)/, HOME);
  if (!fs.existsSync(o.cwd)) throw new Error(`Folder does not exist: ${o.cwd}`);
  if (o.agent === 'claude') {
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
  if (await hasSession(name)) return { tmux: name };
  const cwd = fs.existsSync(s.cwd) ? s.cwd : HOME;
  if (s.agent === 'claude') {
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
