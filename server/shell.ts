import { execFileSync } from 'node:child_process';

let cachedPath: string | undefined;

/** PATH as the user's login shell sees it (nvm, homebrew, etc). */
export function loginPath(): string {
  if (cachedPath) return cachedPath;
  const shell = process.env.SHELL || '/bin/zsh';
  for (const flags of [['-lic'], ['-lc']]) {
    try {
      const out = execFileSync(shell, [...flags, 'echo "__PATH__=$PATH"'], {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/__PATH__=(.*)/);
      if (m && m[1].trim()) {
        cachedPath = m[1].trim();
        return cachedPath;
      }
    } catch {
      /* try next */
    }
  }
  cachedPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  return cachedPath;
}

export function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
