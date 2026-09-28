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

/**
 * Types `text` into the pane as a bracketed paste, so newlines stay in the prompt instead of submitting
 * it, then presses Enter as its own key. (`send-keys -l text Enter` would type the word "Enter".)
 */
export async function sendKeys(name: string, text: string, enter = true): Promise<void> {
  const target = `=${name}:`;
  if (text) {
    const buf = `tower-${process.pid}-${Date.now()}`;
    await tmux(['set-buffer', '-b', buf, '--', text]);
    await tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', target]);
    // Give the agent's input box a moment to take the paste, or Enter can land inside it.
    if (enter) await new Promise((r) => setTimeout(r, 150));
  }
  if (enter) await tmux(['send-keys', '-t', target, 'Enter']);
}

/** Keys a remote device may press: enough to answer menus and permission prompts, and to interrupt. */
const NAMED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'BSpace', 'Space', 'C-c', 'C-d', 'C-o', 'C-r', 'C-t']);

export async function pressKeys(name: string, keys: string[]): Promise<void> {
  const ok = keys.filter((k) => NAMED_KEYS.has(k) || /^[0-9a-zA-Z]$/.test(k));
  if (ok.length) await tmux(['send-keys', '-t', `=${name}:`, ...ok]);
}

/** The pane's text: the visible screen plus `lines` of scrollback above it (0 for the screen alone). */
export async function capturePane(name: string, lines = 60): Promise<string> {
  return (await tmuxQuiet(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`])) ?? '';
}

export interface PaneModes {
  alt: boolean;     // full-screen app on the alternate screen: tmux keeps no scrollback for it
  mouse: boolean;   // the app asked for mouse events (SGR), so it scrolls itself on wheel input
}

export async function paneModes(name: string): Promise<PaneModes> {
  const out = (await tmuxQuiet(['display', '-p', '-t', `=${name}:`, '#{alternate_on} #{mouse_any_flag}#{mouse_button_flag}#{mouse_standard_flag} #{mouse_sgr_flag}'])) ?? '';
  const [alt, flags, sgr] = out.trim().split(' ');
  return { alt: alt === '1', mouse: /1/.test(flags || '') && sgr === '1' };
}

/**
 * Scrolls the pane by `lines` (positive = back in time) without a terminal attached, for touch screens
 * that never produce wheel events. An app that takes the mouse (Claude Code's full-screen UI) gets SGR
 * wheel events typed into it; anything with tmux scrollback scrolls in copy mode. Anything else is left
 * alone rather than fed escape codes it would print.
 */
export async function scrollPane(name: string, lines: number): Promise<void> {
  const n = Math.min(200, Math.abs(Math.trunc(lines)));
  if (!n) return;
  const target = `=${name}:`;
  const m = await paneModes(name);
  if (m.mouse) {
    // Paced like a real wheel: Claude Code misreads a burst of 30+ events (it can scroll the wrong way
    // or jump to the top), so send at most 5 per write, a frame apart.
    const ev = `\x1b[<${lines > 0 ? 64 : 65};1;1M`;
    for (let left = n; left > 0; left -= 5) {
      await tmux(['send-keys', '-t', target, '-l', ev.repeat(Math.min(5, left))]);
      if (left > 5) await new Promise((r) => setTimeout(r, 16));
    }
  } else if (!m.alt) {
    // -e leaves copy mode by itself once scrolled back to the bottom.
    if (lines > 0) await tmux(['copy-mode', '-e', '-t', target]);
    await tmuxQuiet(['send-keys', '-t', target, '-X', '-N', String(n), lines > 0 ? 'scroll-up' : 'scroll-down']);
  }
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
