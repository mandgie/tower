import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const CODEX_DIR = path.join(HOME, '.codex');
export const APP_DIR = path.join(HOME, '.multisession');
export const TMUX_SOCKET = 'multisession';
/** Port to listen on. 0 (MS_PORT unset) lets the OS pick a free one; the chosen port is reported to Electron. */
export const PORT = Number(process.env.MS_PORT || 0);

fs.mkdirSync(APP_DIR, { recursive: true });

export function displayPath(p: string): string {
  if (p === HOME) return '~';
  if (p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length);
  return p;
}

export function projectName(cwd: string): string {
  const d = displayPath(cwd);
  if (d === '~') return 'home';
  // ~/projects/foo -> foo, ~/repos/foo -> foo, deeper paths keep the tail two segments
  const parts = d.split('/').filter((x) => x && x !== '~');
  if (parts.length <= 2) return parts[parts.length - 1];
  return parts.slice(-2).join('/');
}
