import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_DIR } from './config.js';
import { shellEnv } from './shell.js';
import { loadSettings } from './settings.js';
import { userText, isRealPrompt } from './claude.js';
import { launchNew } from './sessions.js';
import type { Session, Todo, TodoScan, TodoStatus, TodoWorktree, WorkspaceSummary } from '../shared/types.js';

/**
 * The todo finder. For each workspace that has it on, it reads the turns its Claude sessions added since
 * the last look, asks a model (`claude -p`) which work those turns left open, and keeps the answers as
 * `proposed` todos for the user to accept or reject. It never writes to a session.
 *
 * A session is read only after it has been quiet for a while, so a conversation that is still going is
 * not cut in half. The read position is a byte offset per transcript, kept on disk with the todos.
 */
const FILE = path.join(APP_DIR, 'todos.json');
const WORK_DIR = path.join(APP_DIR, 'todo-finder');

const SCAN_EVERY_MS = 5 * 60_000;
const QUIET_MS = 3 * 60_000;
/** A session the finder has not read before: start this many real prompts back, not at the beginning. */
const FIRST_PROMPTS = 6;
const FIRST_TAIL_BYTES = 512 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** What one scan sends the model: the newest part of the turns wins when they are longer. */
const MAX_CHARS = 80_000;
const MAX_TODOS_PER_SESSION = 6;
const RUN_TIMEOUT_MS = 4 * 60_000;

interface Store { todos: Todo[]; marks: Record<string, number> }

let store: Store = load();
const scans = new Map<string, TodoScan>();
let lastTick = 0;
let queue: Promise<void> = Promise.resolve();
let onChange: () => void = () => {};

function load(): Store {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { todos: Array.isArray(j.todos) ? j.todos : [], marks: j.marks && typeof j.marks === 'object' ? j.marks : {} };
  } catch { return { todos: [], marks: {} }; }
}

function save(): void {
  fs.writeFile(FILE, JSON.stringify(store), () => {});
}

export function onTodosChange(fn: () => void): void { onChange = fn; }

export function todoState(): { todos: Todo[]; todoScans: TodoScan[] } {
  return { todos: store.todos, todoScans: [...scans.values()] };
}

/** "Not yet" on a finish report: keep the todo open until the session reports again. */
export function dismissFinish(id: string): Todo {
  const t = store.todos.find((x) => x.id === id);
  if (!t) throw new Error('Unknown todo');
  if (t.finished) t.finished.dismissed = true;
  save();
  onChange();
  return t;
}

export function setTodoStatus(id: string, status: TodoStatus): Todo {
  const t = store.todos.find((x) => x.id === id);
  if (!t) throw new Error('Unknown todo');
  t.status = status;
  t.decidedAt = Date.now();
  if (status === 'done' || status === 'rejected') lastWorktreeTick = 0; // clean up its worktree soon
  save();
  onChange();
  return t;
}

const execFileP = promisify(execFile);
/** Where startTodo puts the git worktrees of started sessions: outside the repo, so it never sees them. */
const WORKTREES = path.join(APP_DIR, 'worktrees');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], { env: shellEnv(), timeout: 60_000, encoding: 'utf8' });
  return stdout.trim();
}

/**
 * A git worktree of the todo's repository on a new branch from the current HEAD, so sessions started from
 * todos never commit into the same checkout at the same time. Returns the folder to start in (the todo's
 * folder at the same place inside the worktree), or null when the folder is not in a git repository.
 * Starting the same todo again reuses its worktree, with the work done so far.
 */
async function todoWorktree(t: Todo): Promise<{ cwd: string; path: string; branch: string; base: string } | null> {
  let top: string, prefix: string;
  try {
    top = await git(t.cwd, ['rev-parse', '--show-toplevel']);
    prefix = await git(t.cwd, ['rev-parse', '--show-prefix']);
  } catch { return null; }
  // The todo's folder may be untracked, and then it is not in the worktree.
  const inside = (dir: string) => (fs.existsSync(path.join(dir, prefix)) ? path.resolve(dir, prefix) : dir);
  const old = t.startedIn?.worktree;
  if (old && !old.removedAt && fs.existsSync(old.path)) return { cwd: inside(old.path), path: old.path, branch: old.branch, base: old.base };
  const short = t.id.slice(0, 8);
  const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const branch = `todo/${slug || 'task'}-${short}`;
  const dir = path.join(WORKTREES, `${path.basename(top)}-${short}`);
  const base = (await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')) || (await git(top, ['rev-parse', '--short', 'HEAD']));
  fs.mkdirSync(WORKTREES, { recursive: true });
  // The branch outlives its worktree when someone removed only the folder: check it out again.
  const kept = await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  if (kept) await git(top, ['worktree', 'prune']);
  await git(top, kept ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  return { cwd: inside(dir), path: dir, branch, base };
}

/**
 * Start a Claude session for the todo with the todo as its first prompt, and link the two. In a git
 * repository the session gets its own worktree (see todoWorktree). Starting a proposal also accepts it.
 */
export async function startTodo(id: string, sessions: Session[], skipPermissions?: boolean): Promise<{ tmux: string; key?: string }> {
  const t = store.todos.find((x) => x.id === id);
  if (!t) throw new Error('Unknown todo');
  const from = sessions.find((s) => s.key === t.session);
  const wt = await todoWorktree(t);
  const prompt = [
    t.title,
    t.detail,
    `This task comes from Tower's todo list. Tower found it in an earlier Claude session in this folder ("${t.sessionTitle}").`,
    `The earlier session said: "${t.quote}"`,
    from?.transcriptPath ? `The earlier session's transcript is ${from.transcriptPath}. Read it only if you need more context.` : '',
    wt ? `You work in your own git worktree at ${wt.path}, on the branch ${wt.branch}, which Tower made from ${wt.base} so that parallel sessions cannot collide. Commit your work on this branch. Do not merge it into ${wt.base} and do not change the main checkout in ${t.cwd}. Uncommitted changes in the main checkout are not in this worktree. If the project needs installed dependencies (for example node_modules), install them in the worktree first. In your final message, give the branch name so the user can merge it.` : '',
    `When the task is completely done, end your final message with a line that says only ${FINISH_LINE}. Tower then proposes to mark the todo done. Do not write that line while work is left or while you wait for an answer.`,
  ].filter(Boolean).join('\n\n');
  const r = await launchNew({ agent: 'claude', cwd: wt?.cwd ?? t.cwd, prompt, skipPermissions });
  t.startedIn = { key: r.key ?? '', tmux: r.tmux, at: Date.now(), worktree: wt ? { path: wt.path, branch: wt.branch, base: wt.base } : undefined };
  if (t.status === 'proposed' || t.status === 'rejected') { t.status = 'accepted'; t.decidedAt = Date.now(); }
  save();
  onChange();
  return r;
}

/** How often todoWorktreeTick looks at the worktrees: a few git commands per worktree. */
const WORKTREE_EVERY_MS = 2 * 60_000;
let lastWorktreeTick = 0;
let worktreeBusy = false;

/** The main checkout the worktree belongs to: git commands about the branch run there. */
const repoOf = (t: Todo) => t.cwd;

/** True when a live session runs inside the worktree, so its folder must stay. */
function inUse(wt: TodoWorktree, sessions: Session[]): boolean {
  return sessions.some((s) => s.live && s.status !== 'ended' && (s.cwd === wt.path || s.cwd.startsWith(wt.path + path.sep)));
}

/**
 * Uncommitted files in the worktree, and the commits on its branch whose change is not in the base.
 * `git cherry` compares patches, so a branch that was rebased or cherry-picked into the base counts as merged.
 */
async function checkWorktree(t: Todo, wt: TodoWorktree): Promise<NonNullable<TodoWorktree['check']>> {
  const dirty = (await git(wt.path, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
  const ahead = await git(repoOf(t), ['cherry', wt.base, wt.branch])
    .then((out) => out.split('\n').filter((l) => l.startsWith('+')).length, () => undefined);
  return { dirty, ahead };
}

/**
 * Remove the todo's worktree and delete its branch. Without `force` it refuses while the worktree has
 * uncommitted files or the branch has work that is not in the base. It always refuses while a session runs in it.
 */
export async function removeTodoWorktree(id: string, sessions: Session[], force = false): Promise<Todo> {
  const t = store.todos.find((x) => x.id === id);
  if (!t) throw new Error('Unknown todo');
  const wt = t.startedIn?.worktree;
  if (!wt || wt.removedAt) throw new Error('The todo has no worktree');
  if (inUse(wt, sessions)) throw new Error('A session still runs in the worktree. Close it first.');
  if (fs.existsSync(wt.path)) {
    const c = wt.check = await checkWorktree(t, wt);
    if (!force) {
      if (c.dirty) throw new Error(`The worktree has ${c.dirty} uncommitted ${c.dirty === 1 ? 'file' : 'files'}.`);
      if (c.ahead === undefined) throw new Error(`Tower cannot compare ${wt.branch} with ${wt.base}.`);
      if (c.ahead) throw new Error(`${wt.branch} has ${c.ahead} ${c.ahead === 1 ? 'commit' : 'commits'} that ${wt.base} does not have.`);
    }
    await git(repoOf(t), ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
  } else {
    await git(repoOf(t), ['worktree', 'prune']).catch(() => {});
  }
  // -D: checkWorktree already found the work in the base (or the user forced it), also after a rebase that -d misses.
  await git(repoOf(t), ['branch', '-D', wt.branch]).catch(() => {});
  wt.removedAt = Date.now();
  save();
  onChange();
  return t;
}

/**
 * Called on every snapshot tick. At most every WORKTREE_EVERY_MS it checks each todo worktree, so the
 * panel can show unmerged work, and it removes the worktree and branch of a done or rejected todo when
 * nothing would be lost: no uncommitted files, every commit in the base, and no session running in it.
 */
export function todoWorktreeTick(sessions: Session[], now = Date.now()): void {
  if (worktreeBusy || now - lastWorktreeTick < WORKTREE_EVERY_MS) return;
  const todos = store.todos.filter((t) => t.startedIn?.worktree && !t.startedIn.worktree.removedAt);
  if (!todos.length) return;
  lastWorktreeTick = now;
  worktreeBusy = true;
  (async () => {
    let changed = false;
    for (const t of todos) {
      const wt = t.startedIn!.worktree!;
      try {
        if (!fs.existsSync(wt.path)) {
          // Someone removed the folder by hand: forget the worktree; keep the branch, it may hold work.
          await git(repoOf(t), ['worktree', 'prune']).catch(() => {});
          wt.removedAt = Date.now();
          changed = true;
          continue;
        }
        const c = await checkWorktree(t, wt);
        if (JSON.stringify(c) !== JSON.stringify(wt.check)) { wt.check = c; changed = true; }
        const finished = t.status === 'done' || t.status === 'rejected';
        if (finished && c.dirty === 0 && c.ahead === 0 && !inUse(wt, sessions)) {
          await removeTodoWorktree(t.id, sessions);
          changed = false; // removeTodoWorktree saved and told the clients
        }
      } catch { /* try again next round */ }
    }
    if (changed) { save(); onChange(); }
  })().finally(() => { worktreeBusy = false; });
}

/**
 * Mark each session that a todo started. The key is known at launch; after /clear the session gets a new
 * key, but its pane keeps following the tmux renames, so match the pane name too.
 */
export function linkTodoSessions(sessions: Session[], renamed: Record<string, string>): void {
  const byKey = new Map<string, Todo>();
  const byTmux = new Map<string, Todo>();
  for (const t of store.todos) {
    if (!t.startedIn) continue;
    if (t.startedIn.key) byKey.set(t.startedIn.key, t);
    byTmux.set(renamed[t.startedIn.tmux] ?? t.startedIn.tmux, t);
  }
  if (!byKey.size && !byTmux.size) return;
  for (const s of sessions) {
    const t = byKey.get(s.key) ?? (s.live?.kind === 'tmux' ? byTmux.get(s.live.tmux) : undefined);
    if (t) s.todo = { id: t.id, title: t.title, status: t.status };
  }
}

/** The line a started session ends its last message with when the todo is done (see startTodo). */
const FINISH_LINE = '[todo done]';
const FINISH_TAIL_BYTES = 256 * 1024;
/** Transcript size at the last finish check, so an unchanged transcript is not read again. */
const finishChecked = new Map<string, number>();

/**
 * Propose `done` for an open todo when the session started for it ends a turn with FINISH_LINE.
 * The report is kept by the uuid of that message: "Not yet" holds until a later message reports again.
 */
export function checkTodoFinish(sessions: Session[], renamed: Record<string, string>): void {
  let changed = false;
  for (const t of store.todos) {
    if (t.status !== 'accepted' || !t.startedIn) continue;
    const tmux = renamed[t.startedIn.tmux] ?? t.startedIn.tmux;
    const s = sessions.find((x) => x.key === t.startedIn!.key)
      ?? sessions.find((x) => x.live?.kind === 'tmux' && x.live.tmux === tmux);
    if (!s?.transcriptPath || s.status === 'working') continue;
    let size: number;
    try { size = fs.statSync(s.transcriptPath).size; } catch { continue; }
    if (finishChecked.get(s.transcriptPath) === size) continue;
    finishChecked.set(s.transcriptPath, size);
    const last = lastReply(s.transcriptPath, size);
    if (!last || last.uuid === t.finished?.uuid) continue;
    const lines = last.text.trimEnd().split('\n');
    if (lines.pop()!.replace(/[\s`*_>.]+/g, '').toLowerCase() !== FINISH_LINE.replace(/\s/g, '')) continue;
    t.finished = { at: Date.now(), uuid: last.uuid, text: clip(lines.join('\n').trim(), 600) };
    changed = true;
  }
  if (changed) { save(); onChange(); }
}

/** The text of the main thread's last assistant message that has text. */
function lastReply(file: string, size: number): { uuid: string; text: string } | null {
  const start = Math.max(0, size - FINISH_TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let r: any;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r.isSidechain || r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const text = r.message.content.filter((b: any) => b.type === 'text' && b.text?.trim()).map((b: any) => b.text).join('\n');
    if (text) return { uuid: String(r.uuid ?? i), text };
  }
  return null;
}

/** Called on every snapshot tick; starts a scan of each enabled workspace at most every SCAN_EVERY_MS. */
export function todoTick(workspaces: WorkspaceSummary[], sessions: Session[], now = Date.now()): void {
  if (now - lastTick < SCAN_EVERY_MS) return;
  lastTick = now;
  for (const w of workspaces) if (w.todos) scanWorkspace(w, sessions, false);
}

/** Queue a scan of one workspace. `force` (the Scan now button) skips the quiet wait. */
export function scanWorkspace(w: WorkspaceSummary, sessions: Session[], force: boolean): void {
  const cur = scans.get(w.id);
  if (cur?.running) return;
  scans.set(w.id, { ...cur, workspace: w.id, running: true, error: undefined });
  onChange();
  queue = queue.then(() => runScan(w, sessions, force)).catch(() => {});
}

async function runScan(w: WorkspaceSummary, sessions: Session[], force: boolean): Promise<void> {
  const byTmux = new Map<string, Session>();
  for (const s of sessions) if (s.live?.kind === 'tmux') byTmux.set(s.live.tmux, s);
  const errors: string[] = [];
  const now = Date.now();
  for (const tmux of w.panes) {
    const s = byTmux.get(tmux);
    if (!s || s.agent !== 'claude' || !s.transcriptPath) continue;
    if (s.status === 'working') continue;
    if (!force && now - s.updatedAt < QUIET_MS) continue;
    try { await scanSession(w.id, s); } catch (e) { errors.push(`${s.title || s.id}: ${(e as Error).message}`); }
  }
  scans.set(w.id, { workspace: w.id, running: false, lastAt: Date.now(), error: errors.length ? errors.join('\n') : undefined });
  onChange();
}

async function scanSession(workspace: string, s: Session): Promise<void> {
  const file = s.transcriptPath!;
  const read = readNew(file, store.marks[file]);
  if (!read) return;
  const text = render(read.records);
  if (text.trim()) {
    const open = store.todos.filter((t) => t.workspace === workspace || t.cwd === s.cwd).slice(-80);
    const found = await ask(s, text, open);
    const haystack = normalize(text);
    for (const f of found.slice(0, MAX_TODOS_PER_SESSION)) {
      // The quote is the proof; a todo whose quote is not in the turns is the model's invention.
      if (!f.title.trim() || !haystack.includes(normalize(f.quote).slice(0, 60))) continue;
      store.todos.push({
        id: randomUUID(), workspace, session: s.key, sessionTitle: s.title || s.firstPrompt.slice(0, 80), cwd: s.cwd,
        title: f.title.trim(), detail: f.detail.trim(), quote: f.quote.trim(), createdAt: Date.now(), status: 'proposed',
      });
    }
  }
  store.marks[file] = read.end;
  save();
  onChange();
}

/** Records after `mark`, ending at the last complete line. Null when nothing new was written. */
function readNew(file: string, mark: number | undefined): { records: any[]; end: number } | null {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (mark !== undefined && mark > size) mark = 0; // the file was replaced
  if (mark !== undefined && mark === size) return null;
  const first = mark === undefined;
  const start = first ? Math.max(0, size - FIRST_TAIL_BYTES) : Math.max(mark!, size - MAX_READ_BYTES);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return null;
  const end = start + lastNl + 1;
  const lines = buf.subarray(0, lastNl).toString('utf8').split('\n');
  if (start > 0 && start !== mark) lines.shift(); // starts mid-line
  let records: any[] = [];
  for (const l of lines) { if (l) try { records.push(JSON.parse(l)); } catch { /* skip */ } }
  if (first) {
    const prompts = records.map((r, i) => (isRealPrompt(r) ? i : -1)).filter((i) => i >= 0);
    records = prompts.length > FIRST_PROMPTS ? records.slice(prompts[prompts.length - FIRST_PROMPTS]) : records;
  }
  return { records, end };
}

/** The turns as plain text: the user's prompts, Claude's replies, and the tool calls that failed. */
function render(records: any[]): string {
  const out: string[] = [];
  for (const r of records) {
    if (r.isSidechain) continue;
    if (isRealPrompt(r)) { out.push(`USER: ${clip(userText(r.message.content)!, 4000)}`); continue; }
    const c = r.message?.content;
    if (r.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b: any) => b.type === 'text' && b.text?.trim()).map((b: any) => b.text).join('\n');
      if (text) out.push(`CLAUDE: ${clip(text, 6000)}`);
    } else if (r.type === 'user' && Array.isArray(c)) {
      for (const b of c) if (b.type === 'tool_result' && b.is_error) out.push(`TOOL ERROR: ${clip(resultText(b.content), 600)}`);
    }
  }
  const all = out.join('\n\n');
  return all.length > MAX_CHARS ? all.slice(all.length - MAX_CHARS) : all;
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s);
const normalize = (s: string) => s.toLowerCase().replace(/[\s`*_>"'“”‘’]+/g, ' ').trim();

const SYSTEM = `You read part of a conversation between a developer (USER) and a coding agent (CLAUDE), and you find the work that the conversation leaves open.

A todo is a concrete piece of work that someone still needs to do. Report a todo only when the text shows it:
- CLAUDE says that it did not do, skipped, could not finish, or only partly finished something.
- CLAUDE suggests a next step or a follow-up, and the USER did not reject it or ask for it to be done in the same conversation.
- The USER says that something must happen later ("later", "next", "remember to", "after that").
- A test, build, check or command failed, and the conversation does not show a fix.
- CLAUDE found a bug or a risk outside the task and left it alone.

Do not report:
- Work that a later part of the conversation finishes.
- Vague ideas, general advice, or questions without a concrete action.
- Anything that matches a todo in the list of existing todos, even with other words.
- Anything only about this conversation's own chat (for example "answer the user").

Write each todo for the developer, who will read it days later without the conversation:
- title: one imperative line under 90 characters that names the thing (file, feature, command) to act on.
- detail: one or two sentences: why it is open and what "done" means.
- quote: the exact words from the conversation that show the todo is open, copied character for character, 5 to 30 words.

Return at most ${MAX_TODOS_PER_SESSION} todos, the most useful first. Return an empty list when nothing is open; that is the usual answer.`;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, detail: { type: 'string' }, quote: { type: 'string' } },
        required: ['title', 'detail', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
  additionalProperties: false,
});

interface Found { title: string; detail: string; quote: string }

async function ask(s: Session, text: string, existing: Todo[]): Promise<Found[]> {
  const known = existing.length
    ? existing.map((t) => `- [${t.status}] ${t.title}`).join('\n')
    : '(none)';
  const prompt = `Project folder: ${s.cwd}\nSession: ${s.title || s.firstPrompt}\n\nExisting todos (do not repeat these):\n${known}\n\n<conversation>\n${text}\n</conversation>`;
  const model = loadSettings().todoModel || 'claude-opus-5-5';
  fs.mkdirSync(WORK_DIR, { recursive: true });
  // No tools, no MCP servers (their tool lists cost ~30k tokens a call), no transcript left behind.
  const args = ['-p', '--model', model, '--effort', 'medium', '--tools', '', '--strict-mcp-config',
    '--no-session-persistence', '--system-prompt', SYSTEM, '--output-format', 'json', '--json-schema', SCHEMA];
  const out = await run('claude', args, prompt);
  let j: any;
  try { j = JSON.parse(out); } catch { throw new Error('the model did not return JSON'); }
  if (j.is_error) throw new Error(String(j.result || j.subtype || 'claude failed').slice(0, 200));
  const todos = j.structured_output?.todos;
  if (!Array.isArray(todos)) throw new Error('the model returned no todo list');
  return todos.filter((t: any) => t && typeof t.title === 'string' && typeof t.quote === 'string')
    .map((t: any) => ({ title: t.title, detail: typeof t.detail === 'string' ? t.detail : '', quote: t.quote }));
}

function run(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: WORK_DIR, env: shellEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGTERM'); reject(new Error('the model took too long')); }, RUN_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim().startsWith('{')) resolve(out);
      else reject(new Error((err || out || `claude exited with ${code}`).trim().slice(0, 200)));
    });
    p.stdin.end(input);
  });
}
