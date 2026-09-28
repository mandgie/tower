import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './config.js';
import type { WorkspaceSummary } from '../shared/types.js';

/**
 * A read-only mirror of the Mac's workspaces for the phone. The desktop UI owns them (localStorage) and
 * pushes every change here; nothing on the server reads them except to pass them on in the snapshot.
 */
const FILE = path.join(APP_DIR, 'workspaces.json');

let cache: WorkspaceSummary[] | null = null;

export function loadWorkspaces(): WorkspaceSummary[] {
  if (cache) return cache;
  try { cache = clean(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { cache = []; }
  return cache;
}

export function saveWorkspaces(raw: unknown): WorkspaceSummary[] {
  cache = clean(raw);
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  return cache;
}

function clean(raw: unknown): WorkspaceSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w) => w && typeof w.id === 'string' && typeof w.name === 'string' && Array.isArray(w.panes))
    .map((w) => ({ id: w.id, name: w.name, panes: w.panes.filter((p: unknown) => typeof p === 'string') }));
}
