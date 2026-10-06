import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CLAUDE_DIR, APP_DIR, projectName } from './config.js';
import type { Session, Message, Block, SessionStats, SessionLoop } from '../shared/types.js';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');
const CACHE_FILE = path.join(APP_DIR, 'claude-cache.json');

interface Meta {
  id: string;
  cwd: string;
  firstPrompt: string;
  lastPrompt?: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  gitBranch?: string;
  version?: string;
  lastRole?: string;
  contextTokens?: number;
  loop?: LoopState;
}
interface CacheEntry { size: number; mtimeMs: number; meta: Meta | null }

/** Bump when Meta gains a field, so entries cached by size+mtime get re-extracted instead of missing it forever. */
const CACHE_VERSION = 3;
let cache: Record<string, CacheEntry> = {};
try {
  const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (j && j.v === CACHE_VERSION && j.entries) cache = j.entries;
} catch { /* fresh */ }
let cacheDirty = false;
let lastCacheWrite = 0;

function flushCache() {
  if (!cacheDirty || Date.now() - lastCacheWrite < 5000) return;
  fs.writeFile(CACHE_FILE, JSON.stringify({ v: CACHE_VERSION, entries: cache }), () => {});
  cacheDirty = false;
  lastCacheWrite = Date.now();
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 192 * 1024;

function readRange(fd: number, start: number, len: number): string {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return buf.subarray(0, n).toString('utf8');
}

function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.filter((b: any) => b && b.type === 'text').map((b: any) => b.text as string);
    if (texts.length) return texts.join('\n');
  }
  return null;
}

/** Real prompts only: skip slash-command expansions, tool results, meta injections. */
function isRealPrompt(rec: any): boolean {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return false;
  const t = userText(rec.message?.content);
  if (!t) return false;
  const s = t.trim();
  if (!s || s.startsWith('<')) return false;
  if (s.startsWith('[Request interrupted')) return false;
  return true;
}

function cleanPrompt(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function parseLines(text: string, dropFirst: boolean): any[] {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  const out: any[] = [];
  for (const l of lines) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return out;
}

/** What the model saw on this call: fresh input plus everything served from the prompt cache. */
export function contextTokensOf(usage: any): number {
  return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
}

function extractMeta(file: string, size: number, prevLoop?: LoopState): Meta | null {
  const fd = fs.openSync(file, 'r');
  try {
    let head: any[];
    let tail: any[];
    const whole = size <= HEAD_BYTES + TAIL_BYTES;
    if (whole) {
      head = parseLines(readRange(fd, 0, size), false);
      tail = head;
    } else {
      head = parseLines(readRange(fd, 0, HEAD_BYTES), false);
      tail = parseLines(readRange(fd, size - TAIL_BYTES, TAIL_BYTES), true);
    }
    const meta: Partial<Meta> = {};
    for (const r of head) {
      if (!meta.id && r.sessionId) meta.id = r.sessionId;
      if (!meta.cwd && r.cwd) meta.cwd = r.cwd;
      if (!meta.gitBranch && r.gitBranch) meta.gitBranch = r.gitBranch;
      if (!meta.version && r.version) meta.version = r.version;
      if (!meta.createdAt && r.timestamp) meta.createdAt = Date.parse(r.timestamp);
      if (!meta.firstPrompt && isRealPrompt(r)) meta.firstPrompt = cleanPrompt(userText(r.message.content)!);
      if (!meta.model && r.type === 'assistant' && r.message?.model) meta.model = r.message.model;
      if (r.type === 'ai-title' && r.aiTitle) meta.title = r.aiTitle;
      if (r.type === 'summary' && r.summary && !meta.title) meta.title = r.summary;
    }
    for (const r of tail) {
      if (r.timestamp) meta.updatedAt = Date.parse(r.timestamp);
      if (r.type === 'ai-title' && r.aiTitle) meta.title = r.aiTitle;
      if (r.type === 'last-prompt' && r.lastPrompt) meta.lastPrompt = cleanPrompt(r.lastPrompt);
      if (r.type === 'summary' && r.summary) meta.title = r.summary;
      if (r.type === 'user' || r.type === 'assistant') meta.lastRole = r.type;
      if (!meta.firstPrompt && isRealPrompt(r)) meta.firstPrompt = cleanPrompt(userText(r.message.content)!);
      if (r.type === 'assistant' && r.message?.model) meta.model = r.message.model;
      if (r.type === 'assistant' && !r.isSidechain && r.message?.usage) {
        const t = contextTokensOf(r.message.usage);
        if (t > 0) meta.contextTokens = t;
      }
      if (r.gitBranch) meta.gitBranch = r.gitBranch;
      if (r.version) meta.version = r.version;
    }
    const loop = scanLoop(tail, whole ? undefined : prevLoop);
    if (loop) meta.loop = loop;
    if (!meta.id) meta.id = path.basename(file, '.jsonl');
    if (!meta.cwd) return null;
    if (!meta.firstPrompt && meta.lastPrompt) meta.firstPrompt = meta.lastPrompt; // opened with a slash command such as /loop
    if (!meta.firstPrompt && !meta.title) return null; // empty session
    if (!meta.createdAt) meta.createdAt = fs.fstatSync(fd).birthtimeMs;
    if (!meta.updatedAt) meta.updatedAt = fs.fstatSync(fd).mtimeMs;
    return meta as Meta;
  } finally {
    fs.closeSync(fd);
  }
}

export interface ClaudeLive {
  pid: number;
  sessionId: string;
  cwd: string;
  status?: string;
  name?: string;
  tty?: string;
  startedAt?: number;  // process start; loops scheduled before it died with the previous process
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Claude's in-session schedulers, replayed from the transcript. `/loop` without an interval paces itself
 * with ScheduleWakeup (the tool result carries `scheduledFor`); with an interval it uses CronCreate, and
 * every run leaves a `scheduled_task_fire` system record. Both live only in the Claude process.
 */
interface WakeState { prompt: string; startedAt: number; ticks: number; quiet: number; lastAt: number; nextAt?: number; reason?: string; stopped?: boolean }
interface CronState { cron: string; prompt: string; schedule?: string; recurring: boolean; createdAt?: number; fires: number; lastAt?: number }
interface LoopState {
  seenUntil: number;                  // timestamp of the last record replayed; a later reading resumes after it
  loopCmdAt?: number;                 // last time the user typed /loop
  wake?: WakeState;
  crons: Record<string, CronState>;   // by job id
}

/** A wakeup this far past due, with no new one scheduled, means the loop ended without saying so. */
const WAKE_LAPSE_MS = 30 * 60 * 1000;
const CRON_EXPIRY_MS = 7 * 24 * 3600 * 1000;

function scanLoop(records: any[], prev: LoopState | undefined): LoopState | undefined {
  let firstTs = 0;
  for (const r of records) if (r.timestamp) { firstTs = Date.parse(r.timestamp); break; }
  // Resume from the previous state only if this tail overlaps what it already replayed; otherwise counts restart.
  const st: LoopState = prev && firstTs && prev.seenUntil >= firstTs
    ? { ...prev, wake: prev.wake && { ...prev.wake }, crons: Object.fromEntries(Object.entries(prev.crons).map(([k, v]) => [k, { ...v }])) }
    : { seenUntil: 0, crons: {} };
  const after = st.seenUntil;
  const uses = new Map<string, { name: string; input: any }>();
  let wakeFired = false;
  for (const r of records) {
    if (r.isSidechain) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0;
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) {
        if (b.type === 'tool_use' && (b.name === 'ScheduleWakeup' || b.name === 'CronCreate' || b.name === 'CronDelete')) uses.set(b.id, { name: b.name, input: b.input || {} });
      }
    }
    if (!ts || ts <= after) continue;
    st.seenUntil = ts;
    // A fired wakeup re-enters as the same /loop command (not typed by a human); only a typed /loop starts a new loop.
    if (r.type === 'user' && typeof r.message?.content === 'string') {
      if (!wakeFired && (!r.origin || r.origin.kind === 'human') && r.message.content.includes('<command-name>/loop</command-name>')) st.loopCmdAt = ts;
      wakeFired = false;
    }
    if (r.type === 'system' && r.subtype === 'scheduled_task_fire' && r.taskId) {
      // Wakeups ride on one-shot cron entries of their own; they are ticks of the self-paced loop, not jobs.
      if (!st.crons[r.taskId] && (/wakeup/i.test(r.content || '') || (st.wake && r.prompt === st.wake.prompt))) { wakeFired = true; continue; }
      const job = st.crons[r.taskId] ??= { cron: r.cron || '', prompt: r.prompt || '', recurring: true, fires: 0 };
      job.fires++;
      job.lastAt = ts;
      if (!job.recurring) delete st.crons[r.taskId];
    }
    if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) {
      if (b.type !== 'tool_result' || b.is_error) continue;
      const use = uses.get(b.tool_use_id);
      const out = r.toolUseResult;
      if (!use || !out || typeof out !== 'object') continue;
      if (use.name === 'ScheduleWakeup') {
        if (out.stopped || use.input.stop) { if (st.wake) { st.wake.stopped = true; st.wake.nextAt = undefined; st.wake.lastAt = ts; } continue; }
        let w = st.wake;
        const fresh = !w || w.stopped || (st.loopCmdAt != null && st.loopCmdAt > w.lastAt) || (w.nextAt != null && ts > w.nextAt + WAKE_LAPSE_MS);
        if (!w || fresh) w = st.wake = { prompt: '', startedAt: st.loopCmdAt && st.loopCmdAt <= ts ? st.loopCmdAt : ts, ticks: 0, quiet: 0, lastAt: ts };
        w.ticks++;
        w.quiet = use.input.noop === true ? w.quiet + 1 : 0;
        w.lastAt = ts;
        w.nextAt = typeof out.scheduledFor === 'number' && out.scheduledFor > 0 ? out.scheduledFor : ts + (Number(use.input.delaySeconds) || 0) * 1000;
        w.reason = typeof use.input.reason === 'string' ? use.input.reason.slice(0, 200) : undefined;
        if (typeof use.input.prompt === 'string') w.prompt = use.input.prompt;
      } else if (use.name === 'CronCreate' && typeof out.id === 'string') {
        st.crons[out.id] = { cron: String(use.input.cron || ''), prompt: String(use.input.prompt || ''), schedule: out.humanSchedule, recurring: out.recurring !== false && use.input.recurring !== false, createdAt: ts, fires: 0 };
      } else if (use.name === 'CronDelete' && typeof use.input.id === 'string') {
        delete st.crons[use.input.id];
      }
    }
  }
  if (!st.wake && !Object.keys(st.crons).length && !st.loopCmdAt) return undefined;
  return st;
}

function loopPrompt(p: string): string {
  if (/^<<autonomous-loop(-dynamic)?>>$/.test(p.trim())) return '';
  return cleanPrompt(p.replace(/^\/loop\s+/, '')).slice(0, 200);
}

/** The loop as the UI shows it: an armed self-paced loop wins, else the newest cron job. Liveness is checked by the caller. */
function loopView(st: LoopState): SessionLoop | undefined {
  const w = st.wake;
  const now = Date.now();
  const jobs = Object.values(st.crons).filter((j) => !j.recurring || !j.createdAt || now - j.createdAt < CRON_EXPIRY_MS);
  if (w && !w.stopped && w.nextAt) {
    return { kind: 'self-paced', prompt: loopPrompt(w.prompt), ticks: w.ticks, startedAt: w.startedAt, lastAt: w.lastAt, nextAt: w.nextAt, reason: w.reason, quiet: w.quiet, jobs: jobs.length || undefined };
  }
  if (!jobs.length) return undefined;
  const j = jobs.sort((a, b) => (b.lastAt ?? b.createdAt ?? 0) - (a.lastAt ?? a.createdAt ?? 0))[0];
  return { kind: 'cron', prompt: loopPrompt(j.prompt), ticks: j.fires, startedAt: j.createdAt, lastAt: j.lastAt ?? j.createdAt, schedule: j.schedule || j.cron, jobs: jobs.length > 1 ? jobs.length : undefined };
}

export function liveClaudeSessions(): Map<string, ClaudeLive> {
  const out = new Map<string, ClaudeLive>();
  let files: string[] = [];
  try { files = fs.readdirSync(LIVE_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, f), 'utf8'));
      if (!j.pid || !j.sessionId || !pidAlive(j.pid)) continue;
      const started = typeof j.startedAt === 'number' ? j.startedAt : Date.parse(j.procStart ?? '');
      out.set(j.sessionId, { pid: j.pid, sessionId: j.sessionId, cwd: j.cwd, status: j.status, name: j.name, startedAt: Number.isFinite(started) ? started : undefined });
    } catch { /* skip */ }
  }
  return out;
}

export function scanClaudeSessions(): Session[] {
  const sessions: Session[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return sessions; }
  const seen = new Set<string>();
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      seen.add(file);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      let entry = cache[file];
      if (!entry || entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
        let meta: Meta | null = null;
        // Loop counters carry over from the previous reading when the file only grew, since the tail window may no longer reach the loop's start.
        const prevLoop = entry && st.size >= entry.size ? entry.meta?.loop : undefined;
        try { meta = extractMeta(file, st.size, prevLoop); } catch (e) { meta = null; }
        // A tool result bigger than the tail window hides the last usage record; keep the previous reading rather than blanking it.
        if (meta && meta.contextTokens == null && entry?.meta?.contextTokens != null) meta.contextTokens = entry.meta.contextTokens;
        entry = { size: st.size, mtimeMs: st.mtimeMs, meta };
        cache[file] = entry;
        cacheDirty = true;
      }
      if (!entry.meta) continue;
      const m = entry.meta;
      sessions.push({
        key: `claude:${m.id}`,
        id: m.id,
        agent: 'claude',
        cwd: m.cwd,
        project: projectName(m.cwd),
        title: m.title || m.firstPrompt.slice(0, 80),
        firstPrompt: m.firstPrompt,
        lastPrompt: m.lastPrompt,
        createdAt: m.createdAt,
        updatedAt: Math.max(m.updatedAt, st.mtimeMs),
        model: m.model,
        gitBranch: m.gitBranch,
        version: m.version,
        transcriptPath: file,
        status: 'idle',
        context: m.contextTokens != null ? { tokens: m.contextTokens, window: claudeContextWindow(m.model), estimated: true } : undefined,
        loop: m.loop ? loopView(m.loop) : undefined,
      });
    }
  }
  for (const k of Object.keys(cache)) if (!seen.has(k)) { delete cache[k]; cacheDirty = true; }
  flushCache();
  return sessions;
}

export function transcriptMtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function summarizeInput(input: any): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 2000);
  const keys = ['command', 'file_path', 'pattern', 'query', 'prompt', 'description', 'url', 'path'];
  for (const k of keys) if (typeof input[k] === 'string') return `${k}: ${input[k].slice(0, 1500)}`;
  try { return JSON.stringify(input).slice(0, 1500); } catch { return ''; }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n');
  return '';
}

const ACTIVE_GAP_MS = 30 * 60 * 1000;

export function newStats(): SessionStats {
  return { turns: 0, assistantMessages: 0, toolCalls: 0, filesTouched: 0, subagents: 0, compactions: 0, activeMs: 0 };
}

/** Claude context window by model name. Fable and Opus 5 run with 1M in Claude Code; older models 200k. */
export function claudeContextWindow(model?: string): number {
  if (!model) return 200_000;
  if (/fable|mythos|\[1m\]|opus-5|sonnet-5/i.test(model)) return 1_000_000;
  return 200_000;
}

export function trackTime(stats: SessionStats, ts?: number): void {
  if (!ts) return;
  if (!stats.firstAt) stats.firstAt = ts;
  if (stats.lastAt && ts > stats.lastAt) stats.activeMs += Math.min(ts - stats.lastAt, ACTIVE_GAP_MS);
  if (!stats.lastAt || ts > stats.lastAt) stats.lastAt = ts;
}

export async function claudeTranscript(file: string): Promise<{ messages: Message[]; stats: SessionStats }> {
  const msgs: Message[] = [];
  const stats = newStats();
  const files = new Set<string>();
  let model: string | undefined;
  let lastUsage: any = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    if (r.type === 'user' || r.type === 'assistant') trackTime(stats, ts);
    if (r.type === 'system' && r.subtype === 'compact_boundary') stats.compactions++;
    if (isRealPrompt(r)) stats.turns++;
    if (r.type === 'assistant') {
      stats.assistantMessages++;
      if (r.message?.model) model = r.message.model;
      if (r.message?.usage) { lastUsage = r.message.usage; stats.outputTokens = (stats.outputTokens || 0) + (r.message.usage.output_tokens || 0); }
      if (Array.isArray(r.message?.content)) for (const b of r.message.content) if (b.type === 'tool_use') {
        stats.toolCalls++;
        if (b.name === 'Agent' || b.name === 'Task') stats.subagents++;
        if ((b.name === 'Edit' || b.name === 'Write' || b.name === 'MultiEdit' || b.name === 'NotebookEdit') && typeof b.input?.file_path === 'string') files.add(b.input.file_path);
      }
    }
    if (r.type === 'user') {
      const c = r.message?.content;
      const blocks: Block[] = [];
      if (typeof c === 'string') {
        if (c.trim()) blocks.push({ type: 'text', text: c });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text?.trim()) blocks.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_result') blocks.push({ type: 'tool_result', text: resultText(b.content).slice(0, 4000), isError: !!b.is_error });
        }
      }
      if (blocks.length) msgs.push({ role: 'user', ts, blocks });
    } else if (r.type === 'assistant') {
      const c = r.message?.content;
      const blocks: Block[] = [];
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text?.trim()) blocks.push({ type: 'text', text: b.text });
          else if (b.type === 'thinking' && b.thinking?.trim()) blocks.push({ type: 'thinking', text: b.thinking });
          else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', name: b.name, input: summarizeInput(b.input) });
        }
      } else if (typeof c === 'string' && c.trim()) blocks.push({ type: 'text', text: c });
      if (blocks.length) msgs.push({ role: 'assistant', ts, blocks });
    } else if (r.type === 'system' && r.subtype === 'away_summary' && r.content) {
      msgs.push({ role: 'system', ts, blocks: [{ type: 'text', text: r.content }] });
    }
  }
  stats.filesTouched = files.size;
  if (lastUsage) {
    stats.contextTokens = contextTokensOf(lastUsage);
    stats.contextWindow = claudeContextWindow(model);
    stats.contextEstimated = true;
  }
  try { stats.bytes = fs.statSync(file).size; } catch { /* ignore */ }
  return { messages: msgs, stats };
}
