import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODEX_DIR, projectName } from './config.js';
import type { Session, Message, Block, SessionStats } from '../shared/types.js';
import { newStats, trackTime } from './claude.js';

const execFileP = promisify(execFile);

function stateDb(): string | null {
  let files: string[] = [];
  try { files = fs.readdirSync(CODEX_DIR).filter((f) => /^state_\d+\.sqlite$/.test(f)); } catch { return null; }
  if (!files.length) return null;
  files.sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  return path.join(CODEX_DIR, files[0]);
}

interface ImportRecord { source_path: string; imported_thread_id: string }
let importsCache: { mtimeMs: number; map: Map<string, string> } | null = null;

/** imported codex thread id -> claude session id */
export function codexImports(): Map<string, string> {
  const file = path.join(CODEX_DIR, 'external_agent_session_imports.json');
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return new Map(); }
  if (importsCache && importsCache.mtimeMs === st.mtimeMs) return importsCache.map;
  const map = new Map<string, string>();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of (j.records || []) as ImportRecord[]) {
      if (r.imported_thread_id && r.source_path) map.set(r.imported_thread_id, path.basename(r.source_path, '.jsonl'));
    }
  } catch { /* ignore */ }
  importsCache = { mtimeMs: st.mtimeMs, map };
  return map;
}

interface ThreadRow {
  id: string; title: string; cwd: string; source: string; created_at_ms: number; updated_at_ms: number;
  archived: number; git_branch: string | null; model: string | null; first_user_message: string; rollout_path: string;
  cli_version: string; preview: string; name: string | null; recency_at_ms: number;
}

let rowsCache: { key: string; rows: ThreadRow[] } = { key: '', rows: [] };

function dbKey(db: string): string {
  const parts = [db, db + '-wal'].map((f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } });
  return parts.join('|');
}

const THREADS_SQL = 'select id,title,cwd,source,created_at_ms,updated_at_ms,archived,git_branch,model,first_user_message,rollout_path,cli_version,preview,name,recency_at_ms from threads';

/**
 * A plain open works whether or not Codex is running (it may create -wal/-shm files, which is what Codex does too).
 * A read-only open fails with "unable to open database file" once Codex has closed and removed its -shm file,
 * so fall back to immutable mode, which reads the main file without locking.
 */
async function readThreads(db: string): Promise<ThreadRow[]> {
  const opts = { maxBuffer: 64 * 1024 * 1024 };
  try {
    const { stdout } = await execFileP('sqlite3', ['-json', db, THREADS_SQL], opts);
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    const { stdout } = await execFileP('sqlite3', ['-json', `file:${db}?immutable=1`, THREADS_SQL], opts);
    return stdout.trim() ? JSON.parse(stdout) : [];
  }
}

export async function scanCodexSessions(): Promise<Session[]> {
  const db = stateDb();
  if (!db) return [];
  const key = dbKey(db);
  if (rowsCache.key !== key) {
    try {
      rowsCache = { key, rows: await readThreads(db) };
    } catch (e) {
      console.error('[codex] sqlite read failed', (e as Error).message);
      return rowsCache.rows.length ? toSessions(rowsCache.rows) : [];
    }
  }
  return toSessions(rowsCache.rows);
}

function toSessions(rows: ThreadRow[]): Session[] {
  const imports = codexImports();
  return rows.filter((r) => r.cwd).map((r) => {
    const imp = imports.get(r.id);
    const first = (r.first_user_message || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return {
      key: `codex:${r.id}`,
      id: r.id,
      agent: 'codex' as const,
      cwd: r.cwd,
      project: projectName(r.cwd),
      title: r.name || (r.title || '').slice(0, 120) || first.slice(0, 80) || 'Untitled',
      firstPrompt: first,
      lastPrompt: (r.preview || '').replace(/\s+/g, ' ').trim().slice(0, 400) || undefined,
      createdAt: r.created_at_ms,
      updatedAt: Math.max(r.updated_at_ms || 0, r.recency_at_ms || 0),
      model: r.model || undefined,
      gitBranch: r.git_branch || undefined,
      version: r.cli_version || undefined,
      transcriptPath: r.rollout_path,
      importedFrom: imp ? { agent: 'claude' as const, id: imp } : undefined,
      archived: !!r.archived,
      status: 'idle' as const,
    };
  });
}

export async function codexTranscript(file: string): Promise<{ messages: Message[]; stats: SessionStats }> {
  const msgs: Message[] = [];
  const stats = newStats();
  if (!fs.existsSync(file)) return { messages: msgs, stats };
  const files = new Set<string>();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const p = r.payload || {};
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    if (r.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const last = p.info.last_token_usage || {};
      stats.contextTokens = (last.input_tokens || 0) + (last.output_tokens || 0);
      stats.outputTokens = p.info.total_token_usage?.output_tokens ?? stats.outputTokens;
      if (p.info.model_context_window) { stats.contextWindow = p.info.model_context_window; stats.contextEstimated = false; }
      continue;
    }
    if (r.type === 'event_msg' && (p.type === 'context_compacted' || p.type === 'compaction')) { stats.compactions++; continue; }
    if (r.type !== 'response_item') continue;
    trackTime(stats, ts);
    if (p.type === 'message') {
      const blocks: Block[] = [];
      for (const c of p.content || []) {
        const t = c.text ?? c.input_text ?? c.output_text;
        if (typeof t === 'string' && t.trim()) blocks.push({ type: 'text', text: t });
      }
      if (blocks.length) { msgs.push({ role: p.role === 'user' ? 'user' : 'assistant', ts, blocks }); if (p.role === 'user') stats.turns++; else stats.assistantMessages++; }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input = '';
      if (typeof p.arguments === 'string') {
        try { const a = JSON.parse(p.arguments); input = a.cmd || a.command || a.path || JSON.stringify(a); } catch { input = p.arguments; }
      } else if (p.action?.command) input = Array.isArray(p.action.command) ? p.action.command.join(' ') : String(p.action.command);
      else if (p.input) input = String(p.input);
      stats.toolCalls++;
      if (typeof p.arguments === 'string' && /"(path|file_path|filename)"/.test(p.arguments) && /apply_patch|write|edit/i.test(p.name || '')) { try { const a = JSON.parse(p.arguments); const f = a.path || a.file_path || a.filename; if (f) files.add(String(f)); } catch { /* ignore */ } }
      if (typeof input === 'string' && /apply_patch/.test(input)) for (const m of input.matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)) files.add(m[1].trim());
      if (/spawn_agent|subagent/i.test(p.name || '')) stats.subagents++;
      msgs.push({ role: 'assistant', ts, blocks: [{ type: 'tool_use', name: p.name || p.type, input: String(input).slice(0, 1500) }] });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      msgs.push({ role: 'user', ts, blocks: [{ type: 'tool_result', text: out.slice(0, 4000) }] });
    } else if (p.type === 'reasoning') {
      const txt = (p.summary || []).map((s: any) => s.text).filter(Boolean).join('\n');
      if (txt) msgs.push({ role: 'assistant', ts, blocks: [{ type: 'thinking', text: txt }] });
    }
  }
  stats.filesTouched = files.size;
  try { stats.bytes = fs.statSync(file).size; } catch { /* ignore */ }
  return { messages: msgs, stats };
}
