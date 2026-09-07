import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loginPath, shellEnv } from './shell.js';
import type { DoctorCheck, DoctorId, DoctorResult } from '../shared/types.js';

interface Tool { id: DoctorId; label: string; required: boolean; versionArgs: string[]; hint: string }

const TOOLS: Tool[] = [
  { id: 'tmux', label: 'tmux', required: true, versionArgs: ['-V'], hint: 'brew install tmux' },
  { id: 'sqlite3', label: 'sqlite3', required: true, versionArgs: ['--version'], hint: 'xcode-select --install' },
  { id: 'claude', label: 'Claude Code CLI', required: false, versionArgs: ['--version'], hint: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex', label: 'Codex CLI', required: false, versionArgs: ['--version'], hint: 'npm install -g @openai/codex' },
];

/** PATH the doctor searches: the login shell's, unless MS_DOCTOR_PATH overrides it (tests only). */
function doctorPath(): string {
  return process.env.MS_DOCTOR_PATH ?? loginPath();
}

/** `which`-style lookup: first executable regular file named `name` on PATH. */
export function findOnPath(name: string, PATH: string): string | undefined {
  for (const dir of PATH.split(':').filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* keep looking */ }
  }
  return undefined;
}

/** First non-empty output line of `file args`, or undefined on error/timeout. */
function version(file: string, args: string[], PATH: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v?: string) => { if (!done) { done = true; resolve(v); } };
    try {
      execFile(file, args, { env: { ...shellEnv(), PATH }, timeout: 5000, encoding: 'utf8', maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        let line = String(stdout || stderr || '').split('\n').map((l) => l.trim()).find(Boolean);
        // sqlite3 prints "3.43.2 2023-10-10 13:08:14 <commit hash>"; keep version and date only.
        if (line) line = line.replace(/\s+\d\d:\d\d:\d\d\s+[0-9a-f]{12,}.*$/, '').slice(0, 80);
        finish(err && !line ? undefined : line);
      });
    } catch { finish(undefined); }
    setTimeout(() => finish(undefined), 6000).unref();
  });
}

async function check(tool: Tool, PATH: string): Promise<DoctorCheck> {
  const base: DoctorCheck = { id: tool.id, label: tool.label, required: tool.required, found: false, hint: tool.hint };
  try {
    const file = findOnPath(tool.id, PATH);
    if (!file) return base;
    return { ...base, found: true, path: file, version: await version(file, tool.versionArgs, PATH) };
  } catch {
    return base;
  }
}

/** Looks for every external tool Tower depends on. Never throws. */
export async function runDoctor(): Promise<DoctorResult> {
  let PATH: string;
  try { PATH = doctorPath(); } catch { PATH = process.env.PATH || ''; }
  const shell = process.env.SHELL || '/bin/zsh';
  const checks = await Promise.all(TOOLS.map((t) => check(t, PATH)));
  const requiredOk = checks.every((c) => c.found || !c.required);
  const agentOk = checks.some((c) => (c.id === 'claude' || c.id === 'codex') && c.found);
  return { checks, ok: requiredOk && agentOk, path: PATH, shell };
}

/** One line for the server log. */
export function doctorSummary(r: DoctorResult): string {
  const parts = r.checks.map((c) => {
    if (!c.found) return `${c.id} MISSING (${c.hint})`;
    const v = c.version || 'found';
    return v.startsWith(c.id) ? v : `${c.id} ${v}`;
  });
  return `${r.ok ? 'ok' : 'PROBLEMS'}: ${parts.join(', ')}`;
}
