import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { APP_DIR } from './config.js';
import { shellEnv } from './shell.js';
import { loadSettings } from './settings.js';
import { userText, isRealPrompt } from './claude.js';
import { launchNew } from './sessions.js';
import type { Session, Todo, TodoScan, TodoStatus, WorkspaceSummary } from '../shared/types.js';

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

export function setTodoStatus(id: string, status: TodoStatus): Todo {
  const t = store.todos.find((x) => x.id === id);
  if (!t) throw new Error('Unknown todo');
  t.status = status;
  t.decidedAt = Date.now();
  save();
  onChange();
  return t;
}

/**
 * Start a Claude session in the todo's folder with the todo as its first prompt, and link the two.
 * Starting a proposal also accepts it.
 */
export async function startTodo(id: string, sessions: Session[], skipPermissions?: boolean): Promise<{ tmux: string; key?: string }> {
  const t = store.todos.find((x) => x.id === id);
  if (!t) throw new Error('Unknown todo');
  const from = sessions.find((s) => s.key === t.session);
  const prompt = [
    t.title,
    t.detail,
    `This task comes from Tower's todo list. Tower found it in an earlier Claude session in this folder ("${t.sessionTitle}").`,
    `The earlier session said: "${t.quote}"`,
    from?.transcriptPath ? `The earlier session's transcript is ${from.transcriptPath}. Read it only if you need more context.` : '',
  ].filter(Boolean).join('\n\n');
  const r = await launchNew({ agent: 'claude', cwd: t.cwd, prompt, skipPermissions });
  t.startedIn = { key: r.key ?? '', tmux: r.tmux, at: Date.now() };
  if (t.status === 'proposed' || t.status === 'rejected') { t.status = 'accepted'; t.decidedAt = Date.now(); }
  save();
  onChange();
  return r;
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
