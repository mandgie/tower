import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';

/**
 * Claude Code asks "Do you trust the files in this folder?" the first time it starts in a folder, and
 * drops the first message passed on the command line while it waits. It remembers the answer per
 * folder as `projects[<path>].hasTrustDialogAccepted` in ~/.claude.json, and a trusted parent covers
 * every folder below it. Tower sets that flag before it launches Claude, so the question never comes.
 */

const CONFIG = path.join(HOME, '.claude.json');

type Config = { projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>> };

function read(): Config | null {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}

/** The folder or one of its parents is trusted. Claude never stores trust for the home folder itself. */
function isTrusted(cfg: Config, dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    if (cfg.projects?.[d]?.hasTrustDialogAccepted) return true;
    if (d === path.dirname(d)) return false;
  }
}

export async function trustFolder(cwd: string): Promise<void> {
  let dir: string;
  try { dir = fs.realpathSync(cwd); } catch { return; }   // Claude keys folders by their real path (/tmp is /private/tmp)
  if (dir === HOME) return;
  // Every Claude process rewrites this file whole (temp file + rename, no lock), so a write can be
  // lost to one of theirs. Read it back and try again a couple of times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cfg = read();
    if (!cfg) return;                                       // missing or mid-write: never risk clobbering it
    if (isTrusted(cfg, dir)) return;
    cfg.projects ??= {};
    cfg.projects[dir] = { ...cfg.projects[dir], hasTrustDialogAccepted: true };
    const tmp = `${CONFIG}.tower.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, CONFIG);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      console.error('[trust] could not update ~/.claude.json', (e as Error).message);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
