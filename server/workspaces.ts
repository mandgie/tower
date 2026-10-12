import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { APP_DIR } from './config.js';
import type { WorkspaceSummary, WorkspaceOp, WorkspaceOpRequest } from '../shared/types.js';

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

/**
 * Workspace changes made on the phone (see `WorkspaceOp`), queued until the Mac applies and clears them.
 * Persisted so a change made while the Mac window is closed survives a restart.
 */
const OPS_FILE = path.join(APP_DIR, 'workspace-ops.json');
let ops: WorkspaceOp[] = [];
try { ops = JSON.parse(fs.readFileSync(OPS_FILE, 'utf8')); } catch { /* none */ }
function saveOps(): void {
  fs.writeFile(OPS_FILE, JSON.stringify(ops), () => {});
}

export function workspaceOps(): WorkspaceOp[] {
  return [...ops];
}

const NAME_MAX = 60;
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

export function addWorkspaceOp(raw: any): WorkspaceOp {
  const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : '';
  let req: WorkspaceOpRequest;
  if (raw?.op === 'move' && str(raw.tmux) && (raw.to === null || str(raw.to))) req = { op: 'move', tmux: raw.tmux, to: raw.to, ...(name ? { name } : {}) };
  else if (raw?.op === 'rename' && str(raw.workspace) && name) req = { op: 'rename', workspace: raw.workspace, name };
  else if (raw?.op === 'close' && str(raw.workspace)) req = { op: 'close', workspace: raw.workspace };
  else throw new Error('Bad workspace change');
  const op = { ...req, id: randomUUID(), at: Date.now() } as WorkspaceOp;
  ops.push(op);
  saveOps();
  return op;
}

export function clearWorkspaceOp(id: string): void {
  const n = ops.length;
  ops = ops.filter((o) => o.id !== id);
  if (ops.length !== n) saveOps();
}

/** Keep queued moves pointing at a pane that was renamed. */
export function renameInWorkspaceOps(from: string, to: string): void {
  let changed = false;
  ops = ops.map((o) => (o.op === 'move' && o.tmux === from ? (changed = true, { ...o, tmux: to }) : o));
  if (changed) saveOps();
}

/** Drop moves for sessions that ended before the Mac saw them. */
export function pruneWorkspaceOps(alive: Set<string>): void {
  const n = ops.length;
  ops = ops.filter((o) => o.op !== 'move' || alive.has(o.tmux));
  if (ops.length !== n) saveOps();
}
