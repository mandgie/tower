import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CLAUDE_DIR, APP_DIR, projectName } from './config.js';
import type { Session, Message, Block, SessionStats } from '../shared/types.js';

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
}
interface CacheEntry { size: number; mtimeMs: number; meta: Meta | null }

let cache: Record<string, CacheEntry> = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* fresh */ }
let cacheDirty = false;
let lastCacheWrite = 0;

function flushCache() {
  if (!cacheDirty || Date.now() - lastCacheWrite < 5000) return;
  fs.writeFile(CACHE_FILE, JSON.stringify(cache), () => {});
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

function extractMeta(file: string, size: number): Meta | null {
  const fd = fs.openSync(file, 'r');
  try {
    let head: any[];
    let tail: any[];
    if (size <= HEAD_BYTES + TAIL_BYTES) {
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
      if (r.gitBranch) meta.gitBranch = r.gitBranch;
      if (r.version) meta.version = r.version;
    }
    if (!meta.id) meta.id = path.basename(file, '.jsonl');
    if (!meta.cwd) return null;
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
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function liveClaudeSessions(): Map<string, ClaudeLive> {
  const out = new Map<string, ClaudeLive>();
  let files: string[] = [];
  try { files = fs.readdirSync(LIVE_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, f), 'utf8'));
      if (!j.pid || !j.sessionId || !pidAlive(j.pid)) continue;
      out.set(j.sessionId, { pid: j.pid, sessionId: j.sessionId, cwd: j.cwd, status: j.status, name: j.name });
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
        try { meta = extractMeta(file, st.size); } catch (e) { meta = null; }
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
    stats.contextTokens = (lastUsage.input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0);
    stats.contextWindow = claudeContextWindow(model);
    stats.contextEstimated = true;
  }
  try { stats.bytes = fs.statSync(file).size; } catch { /* ignore */ }
  return { messages: msgs, stats };
}
