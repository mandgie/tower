import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { TMUX_SOCKET, APP_DIR } from './config.js';
import { shellEnv, shQuote } from './shell.js';

const execFileP = promisify(execFile);

export async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileP('tmux', ['-L', TMUX_SOCKET, '-f', TMUX_CONF, ...args], { env: shellEnv(), maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function tmuxQuiet(args: string[]): Promise<string | null> {
  try { return await tmux(args); } catch { return null; }
}

const TMUX_CONF = path.join(APP_DIR, 'tmux.conf');
const TMUX_OPTIONS: [string, string][] = [
  ['status', 'off'],
  ['mouse', 'on'],
  ['history-limit', '100000'],
  ['default-terminal', 'tmux-256color'],
  ['escape-time', '0'],
  ['focus-events', 'on'],
  ['allow-passthrough', 'on'],
  ['set-titles', 'off'],
  ['destroy-unattached', 'off'],
  ['exit-empty', 'off'],
  ['remain-on-exit', 'on'],
  ['aggressive-resize', 'on'],
  ['window-size', 'latest'],
  ['set-clipboard', 'on'],
  ['terminal-overrides', ',xterm-256color:RGB,tmux-256color:RGB'],
];

function writeConf(): void {
  const lines = TMUX_OPTIONS.map(([k, v]) => `set-option -g ${k} ${JSON.stringify(v)}`);
  lines.push(`set-environment -g PATH ${JSON.stringify(shellEnv().PATH)}`);
  fs.writeFileSync(TMUX_CONF, lines.join('\n') + '\n');
}

let ensured = false;
/** Start the dedicated tmux server with our options, or apply them to a running one. */
export async function ensureServer(): Promise<void> {
  if (ensured) return;
  writeConf();
  // A server with no sessions exits immediately unless exit-empty is off, so chain the
  // option commands into the same client invocation that starts it.
  const args = ['start-server'];
  for (const [k, v] of TMUX_OPTIONS) args.push(';', 'set-option', '-g', k, v);
  args.push(';', 'set-environment', '-g', 'PATH', shellEnv().PATH!);
  await tmuxQuiet(args);
  ensured = true;
}

export interface TmuxPane {
  session: string;
  created: number;   // ms
  activity: number;  // ms
  attached: number;
  dead: boolean;
  command: string;
  pid: number;
  width: number;
  height: number;
}

export async function listPanes(): Promise<TmuxPane[]> {
  const out = await tmuxQuiet(['list-panes', '-a', '-F',
    '#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}\t#{pane_dead}\t#{pane_current_command}\t#{pane_pid}\t#{pane_width}\t#{pane_height}']);
  if (!out) return [];
  const panes: TmuxPane[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [session, created, activity, attached, dead, command, pid, w, h] = line.split('\t');
    if (!session.startsWith('ms-')) continue;
    panes.push({
      session, created: Number(created) * 1000, activity: Number(activity) * 1000, attached: Number(attached),
      dead: dead === '1', command, pid: Number(pid), width: Number(w), height: Number(h),
    });
  }
  return panes;
}

export async function hasSession(name: string): Promise<boolean> {
  return (await tmuxQuiet(['has-session', '-t', `=${name}`])) !== null;
}

export async function createSession(name: string, cwd: string, command: string): Promise<void> {
  await ensureServer();
  // Run through the login shell so PATH (nvm, homebrew) resolves the same as in a terminal.
  const shell = process.env.SHELL || '/bin/zsh';
  const wrapped = `${shell} -lc ${shQuote(command)}`;
  await tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '220', '-y', '55', wrapped]);
  await tmuxQuiet(['set-option', '-t', `=${name}`, 'remain-on-exit', 'on']);
}

export async function killSession(name: string): Promise<void> {
  await tmuxQuiet(['kill-session', '-t', `=${name}`]);
}

export async function renameSession(from: string, to: string): Promise<void> {
  await tmuxQuiet(['rename-session', '-t', `=${from}`, to]);
}

export async function sendKeys(name: string, text: string, enter = true): Promise<void> {
  const args = ['send-keys', '-t', `=${name}:`];
  if (text) args.push('-l', text);
  if (enter) args.push('Enter');
  await tmux(args);
}

export async function capturePane(name: string, lines = 60): Promise<string> {
  return (await tmuxQuiet(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`])) ?? '';
}

/** Descendant pids of the pane process, for mapping to agent registries. */
export async function paneDescendants(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileP('pgrep', ['-P', String(pid)]);
    const kids = stdout.split('\n').filter(Boolean).map(Number);
    const all = [...kids];
    for (const k of kids) all.push(...(await paneDescendants(k)));
    return all;
  } catch { return []; }
}
