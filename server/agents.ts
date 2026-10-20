import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_DIR } from './config.js';
import { shellEnv } from './shell.js';
import { isRealPrompt, userText } from './claude.js';
import { launchNew, closeTmux, placeSession, placementOf } from './sessions.js';
import { sendKeys } from './tmux.js';
import { trustFolder } from './trust.js';
import { loadWorkspaces } from './workspaces.js';
import type { Session, Snapshot } from '../shared/types.js';

/**
 * Agents: Claude sessions that another session started through the `tower` command (cli/tower.mjs).
 * A child is an ordinary Tower session in its own tmux pane, so the user can watch it and type in it;
 * the record here only remembers who started it, under which short name, and when it last got a prompt,
 * so the parent can wait for the turn that answers it. A child can start children of its own.
 */

interface AgentRecord {
  id: string;
  name: string;              // short name, unique among the live children of one parent
  tmux: string;              // tmux name at launch; follow `renamed` for the current one
  key: string;               // session key at launch
  parentTmux?: string;       // the session that ran `tower spawn`, when it ran inside Tower's tmux
  parentKey?: string;
  cwd: string;
  task: string;
  createdAt: number;
  sentAt: number;            // the last prompt Tower typed into it; a turn after this answers it
  worktree?: { path: string; branch: string; base: string };
  stoppedAt?: number;
}

/** A safety stop for runaway fan-out: children that spawn children. */
const MAX_LIVE_AGENTS = 30;
const FILE = path.join(APP_DIR, 'agents.json');
const WORKTREES = path.join(APP_DIR, 'worktrees');
const TAIL_BYTES = 512 * 1024;

let agents: AgentRecord[] = [];
try { agents = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }
/** Whole and in one go: parallel spawns would interleave async writes into a broken file. */
function save(): void {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(agents, null, 1));
  fs.renameSync(tmp, FILE);
}

const execFileP = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], { env: shellEnv(), timeout: 60_000, encoding: 'utf8' });
  return stdout.trim();
}

/** The session a record points at now: panes get renamed when Claude moves to a new session id. */
function sessionOf(snap: Snapshot, tmux: string | undefined, key: string | undefined): Session | undefined {
  const now = tmux ? snap.renamed[tmux] ?? tmux : undefined;
  return (now && snap.sessions.find((s) => s.live?.kind === 'tmux' && s.live.tmux === now))
    || (key ? snap.sessions.find((s) => s.key === key) : undefined);
}

const live = (snap: Snapshot, a: AgentRecord) => {
  const s = sessionOf(snap, a.tmux, a.key);
  return !a.stoppedAt && !!s?.live && s.status !== 'ended';
};

/** Is `a` a child of the session in pane `from`? */
function childOf(snap: Snapshot, a: AgentRecord, from: Session | undefined): boolean {
  if (!from) return false;
  return sessionOf(snap, a.parentTmux, a.parentKey)?.key === from.key;
}

function caller(snap: Snapshot, from: unknown): Session | undefined {
  return typeof from === 'string' && from ? sessionOf(snap, from, undefined) : undefined;
}

function recordOf(snap: Snapshot, s: Session): AgentRecord | undefined {
  return agents.find((a) => sessionOf(snap, a.tmux, a.key)?.key === s.key);
}

/**
 * What `ref` names, seen from the session in pane `from`: "parent", one of its children by name, or any
 * session by tmux name, key or the first 8 characters of its id.
 */
function resolve(snap: Snapshot, from: unknown, ref: unknown): { s?: Session; a?: AgentRecord } {
  if (typeof ref !== 'string' || !ref) throw new Error('Name an agent');
  const me = caller(snap, from);
  if (ref === 'parent') {
    const mine = me && recordOf(snap, me);
    if (!mine?.parentKey && !mine?.parentTmux) throw new Error('This session has no parent: no session started it with tower spawn');
    const s = sessionOf(snap, mine.parentTmux, mine.parentKey);
    if (!s) throw new Error('The parent session is gone');
    return { s, a: recordOf(snap, s) };
  }
  // Without a Tower session to ask from, the agents nobody's session started are the caller's.
  const kids = agents.filter((a) => a.name === ref && (me ? childOf(snap, a, me) : !a.parentKey && !a.parentTmux));
  const kid = kids.find((a) => live(snap, a)) ?? kids[kids.length - 1];
  if (kid) return { s: sessionOf(snap, kid.tmux, kid.key), a: kid };
  const s = snap.sessions.find((x) => (x.live?.kind === 'tmux' && x.live.tmux === (snap.renamed[ref] ?? ref)) || x.key === ref || (ref.length >= 8 && x.id.startsWith(ref)));
  if (s) return { s, a: recordOf(snap, s) };
  const named = agents.filter((a) => a.name === ref && live(snap, a));
  if (named.length === 1) return { s: sessionOf(snap, named[0].tmux, named[0].key), a: named[0] };
  if (named.length > 1) throw new Error(`More than one agent is called ${ref}; use its session name (tower list --all)`);
  throw new Error(`No agent called ${ref}${me ? ' among the children of this session' : ''}`);
}

/** A git worktree on a new branch from the current HEAD of the repository that holds `cwd`. */
async function agentWorktree(cwd: string, name: string, id: string): Promise<{ cwd: string; path: string; branch: string; base: string }> {
  let top: string, prefix: string;
  try {
    top = await git(cwd, ['rev-parse', '--show-toplevel']);
    prefix = await git(cwd, ['rev-parse', '--show-prefix']);
  } catch { throw new Error(`Not in a git repository, so no worktree: ${cwd}`); }
  const short = id.slice(0, 8);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  const branch = `agent/${slug}-${short}`;
  const dir = path.join(WORKTREES, `${path.basename(top)}-${short}`);
  const base = (await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) || (await git(top, ['rev-parse', '--short', 'HEAD']));
  fs.mkdirSync(WORKTREES, { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  const inside = fs.existsSync(path.join(dir, prefix)) ? path.resolve(dir, prefix) : dir;
  return { cwd: inside, path: dir, branch, base };
}

export interface SpawnRequest { from?: string; task?: string; cwd?: string; name?: string; worktree?: boolean; model?: string }

export async function spawnAgent(snap: Snapshot, b: SpawnRequest): Promise<AgentView> {
  const task = typeof b.task === 'string' ? b.task.trim() : '';
  if (!task) throw new Error('Give the agent a task');
  if (agents.filter((a) => live(snap, a)).length >= MAX_LIVE_AGENTS) {
    throw new Error(`${MAX_LIVE_AGENTS} agents run already. Stop some first (tower stop).`);
  }
  const parent = caller(snap, b.from);
  const cwd = (typeof b.cwd === 'string' && b.cwd.trim()) || parent?.cwd;
  if (!cwd) throw new Error('Give a folder (--cwd): this session is not one of Tower\'s, so there is no folder to inherit');
  const siblings = agents.filter((a) => (parent ? childOf(snap, a, parent) : !a.parentKey && !a.parentTmux));
  let name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, '-') : '';
  if (name && !/^[\w.-]{1,40}$/.test(name)) throw new Error('A name has at most 40 letters, digits, dots, dashes or underscores');
  if (name === 'parent') throw new Error('"parent" is reserved');
  if (name && siblings.some((a) => a.name === name && live(snap, a))) throw new Error(`This session already has a running agent called ${name}`);
  if (!name) { let n = 1; while (siblings.some((a) => a.name === `agent-${n}`)) n++; name = `agent-${n}`; }

  const id = randomUUID();
  const wt = b.worktree ? await agentWorktree(cwd.replace(/^~(?=\/|$)/, process.env.HOME || ''), name, id) : undefined;
  const where = wt?.cwd ?? cwd;
  // A worktree is a new folder, and Claude would stop at its trust question.
  if (wt) await trustFolder(where);
  const prompt = [
    task,
    wt ? `You work in your own git worktree at ${wt.path}, on the branch ${wt.branch}, which Tower made from ${wt.base} so that parallel agents cannot collide. Commit your work on this branch. Do not merge it and do not change the main checkout. If the project needs installed dependencies (for example node_modules), install them in the worktree first. In your final message, give the branch name.` : '',
    // Not the parent's title: Claude names the session after its first prompt, and every child would get the parent's name.
    parent ? `(Another Claude session started you through Tower as the agent "${name}". It reads your final message when you finish a turn, so end each turn with a complete answer. To message it while you work, run: tower send parent "text")` : '',
  ].filter(Boolean).join('\n\n');
  const extraArgs = typeof b.model === 'string' && /^[\w.\[\]-]+$/.test(b.model) ? ['--model', b.model] : undefined;
  const r = await launchNew({ agent: 'claude', cwd: where, prompt, skipPermissions: true, extraArgs });
  const pTmux = parent?.live?.kind === 'tmux' ? parent.live.tmux : undefined;
  const rec: AgentRecord = {
    id, name, tmux: r.tmux, key: r.key ?? '', parentTmux: pTmux, parentKey: parent?.key,
    cwd: where, task, createdAt: Date.now(), sentAt: Date.now(), worktree: wt && { path: wt.path, branch: wt.branch, base: wt.base },
  };
  agents.push(rec);
  save();
  // Next to its parent, in the parent's workspace (the Mac applies the placement).
  // A parent that is an agent itself may still wait for its own placement.
  const ws = pTmux ? loadWorkspaces().find((w) => w.panes.includes(pTmux))?.id ?? placementOf(pTmux)?.workspace : undefined;
  placeSession(r.tmux, where, ws, pTmux);
  return { name, session: r.tmux, key: rec.key, state: 'working', cwd: where, worktree: rec.worktree };
}

export interface AgentView {
  name: string; session: string; key: string;
  state: 'working' | 'finished' | 'ended';
  status?: string; cwd: string; title?: string;
  worktree?: AgentRecord['worktree'];
  reply?: string; question?: string; repliedAt?: number;
}

/** The last answer in a Claude transcript: the last assistant text after the last real prompt, read from the tail. */
function lastReply(file: string | undefined): { reply?: string; at?: number; question?: string } {
  if (!file) return {};
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return {}; }
  let reply: string | undefined, at: number | undefined, question: string | undefined;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    if (isRealPrompt(r)) { reply = undefined; at = undefined; question = undefined; continue; }
    if (r.type !== 'assistant') continue;
    const content = r.message?.content;
    const t = userText(content);
    if (t && t.trim()) { reply = t.trim(); question = undefined; }
    at = ts ?? at;
    // A turn that stops on a question for the user: show the question as the answer.
    const ask = Array.isArray(content) ? content.find((c: any) => c?.type === 'tool_use' && c.name === 'AskUserQuestion') : undefined;
    if (ask) question = (ask.input?.questions ?? []).map((q: any) => `${q.question}\n${(q.options ?? []).map((o: any) => `  - ${o.label}: ${o.description ?? ''}`).join('\n')}`).join('\n\n');
  }
  return { reply, at, question };
}

function view(snap: Snapshot, s: Session | undefined, a: AgentRecord | undefined, withReply: boolean): AgentView {
  const out: AgentView = {
    name: a?.name ?? (s?.live?.kind === 'tmux' ? s.live.tmux : s?.key ?? '?'),
    session: s?.live?.kind === 'tmux' ? s.live.tmux : (a ? snap.renamed[a.tmux] ?? a.tmux : ''),
    key: s?.key ?? a?.key ?? '', cwd: s?.cwd ?? a?.cwd ?? '', title: s?.title, status: s?.status, worktree: a?.worktree, state: 'working',
  };
  // A child that started a moment ago may not be in the snapshot yet.
  const starting = !s && a && Date.now() - a.createdAt < 60_000;
  if ((!s?.live && !starting) || s?.status === 'ended' || a?.stoppedAt) out.state = 'ended';
  const r = lastReply(s?.transcriptPath);
  const since = a?.sentAt ?? 0;
  const idle = s?.status === 'waiting' || s?.status === 'done' || s?.status === 'looping';
  // Idle alone is not enough: right after a prompt the pane still looks idle until Claude takes it.
  if (out.state === 'working' && idle && r.at && r.at >= since - 1000) out.state = 'finished';
  if (withReply) { out.reply = r.reply; out.question = r.question; out.repliedAt = r.at; }
  return out;
}

export function agentState(snap: Snapshot, from: unknown, ref: unknown, withReply: boolean): AgentView {
  const { s, a } = resolve(snap, from, ref);
  return view(snap, s, a, withReply);
}

export function listAgents(snap: Snapshot, from: unknown, all: boolean): AgentView[] {
  const me = caller(snap, from);
  return agents
    .filter((a) => (all || !me ? live(snap, a) || Date.now() - a.createdAt < 86_400_000 : childOf(snap, a, me)))
    .map((a) => view(snap, sessionOf(snap, a.tmux, a.key), a, false));
}

export async function sendToAgent(snap: Snapshot, from: unknown, ref: unknown, text: unknown): Promise<AgentView> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to send');
  const { s, a } = resolve(snap, from, ref);
  if (!s?.live || s.live.kind !== 'tmux' || s.status === 'ended') throw new Error(`${a?.name ?? ref} is not running`);
  const me = caller(snap, from);
  const mine = me && recordOf(snap, me);
  // Say who writes when a child writes to its parent or to another session; a parent's prompt needs no label.
  const label = me && !(a && childOf(snap, a, me)) ? `[Message from the Tower agent "${mine?.name ?? me.title}" (session ${me.live?.kind === 'tmux' ? me.live.tmux : me.key})]\n` : '';
  await sendKeys(s.live.tmux, label + text);
  if (a) { a.sentAt = Date.now(); save(); }
  return view(snap, s, a, false);
}

export async function stopAgent(snap: Snapshot, from: unknown, ref: unknown): Promise<AgentView> {
  const { s, a } = resolve(snap, from, ref);
  if (!a) throw new Error(`${ref} is not an agent; stop it in Tower`);
  if (s?.live?.kind === 'tmux') await closeTmux(s.live.tmux);
  a.stoppedAt = Date.now();
  save();
  return { ...view(snap, s, a, false), state: 'ended' };
}

/** Mark sessions that an agent started, for the UI. */
export function linkAgentSessions(snap: Snapshot): void {
  if (!agents.length) return;
  for (const a of agents) {
    const s = sessionOf(snap, a.tmux, a.key);
    if (!s) continue;
    const p = sessionOf(snap, a.parentTmux, a.parentKey);
    s.spawn = { name: a.name, parentKey: p?.key ?? a.parentKey, parentTitle: p?.title, parentTmux: p?.live?.kind === 'tmux' ? p.live.tmux : undefined };
  }
}
