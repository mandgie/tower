import type { Session, Project, Snapshot, SnapshotDelta, ProjectDir, Placement, WorkspaceSummary, WorkspaceOp } from './types';

/** Newest first. Array sort is stable, so ties keep their previous order. */
export function sortSessions(sessions: Session[]): Session[] {
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Group sorted sessions by folder; folders without sessions (from settings) come last. */
export function buildProjects(sessions: Session[], extraDirs: ProjectDir[]): Project[] {
  const projMap = new Map<string, Project>();
  for (const s of sessions) {
    let p = projMap.get(s.cwd);
    if (!p) { p = { cwd: s.cwd, name: s.project, sessions: [], updatedAt: 0, liveCount: 0 }; projMap.set(s.cwd, p); }
    p.sessions.push(s.key);
    p.updatedAt = Math.max(p.updatedAt, s.updatedAt);
    if (s.live && s.status !== 'ended') p.liveCount++;
  }
  for (const d of extraDirs) if (!projMap.has(d.cwd)) projMap.set(d.cwd, { cwd: d.cwd, name: d.name, sessions: [], updatedAt: 0, liveCount: 0 });
  return [...projMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Apply a server delta. Sessions the delta does not mention keep their object identity, so memoized
 * rows skip re-rendering; projects are derived again from the merged list.
 */
export function applyDelta(prev: Snapshot, d: SnapshotDelta): Snapshot {
  const gone = new Set(d.remove);
  const fresh = new Map(d.upsert.map((s) => [s.key, s]));
  const sessions: Session[] = [];
  for (const s of prev.sessions) {
    if (gone.has(s.key)) continue;
    const u = fresh.get(s.key);
    if (u) fresh.delete(s.key);
    sessions.push(u ?? s);
  }
  sessions.push(...fresh.values());
  sortSessions(sessions);
  const extraDirs = d.extraDirs ?? prev.extraDirs;
  return {
    generatedAt: d.generatedAt,
    sessions,
    projects: buildProjects(sessions, extraDirs),
    extraDirs,
    pending: d.pending ?? prev.pending,
    renamed: d.renamed ?? prev.renamed,
    workspaces: d.workspaces ?? prev.workspaces,
    placements: d.placements ?? prev.placements,
    workspaceOps: d.workspaceOps ?? prev.workspaceOps,
    todos: d.todos ?? prev.todos,
    todoScans: d.todoScans ?? prev.todoScans,
    lost: d.lost ?? prev.lost,
  };
}

/**
 * The workspace a placed session joins: the one it was started from if that still exists, else the one
 * with the most sessions in the same folder. Null leaves it outside every workspace.
 */
export function placementTarget(p: Placement, workspaces: WorkspaceSummary[], cwdOf: (tmux: string) => string | undefined): string | null {
  if (p.workspace && workspaces.some((w) => w.id === p.workspace)) return p.workspace;
  let best: string | null = null, most = 0;
  for (const w of workspaces) {
    const n = w.panes.filter((t) => t !== p.tmux && cwdOf(t) === p.cwd).length;
    if (n > most) { best = w.id; most = n; }
  }
  return best;
}

/**
 * Apply one phone request to a list of workspaces: the Mac's own (panes are objects) or the phone's
 * mirror (panes are tmux names). Applying a request twice changes nothing, so the Mac can see one again
 * before the server has dropped it. A workspace a move empties is closed, as on the desktop, unless it
 * is the last one.
 */
export function applyWorkspaceOp<P, W extends { id: string; name: string; panes: P[] }>(list: W[], op: WorkspaceOp, h: {
  tmuxOf: (p: P) => string;
  /** A pane for a session that is in no workspace yet; null when it is not running. */
  pane: (tmux: string) => P | null;
  create: (id: string, name: string) => W;
}): W[] {
  if (op.op === 'rename') return list.map((w) => (w.id === op.workspace ? { ...w, name: op.name } : w));
  if (op.op === 'close') return list.filter((w) => w.id !== op.workspace);
  const from = list.find((w) => w.panes.some((p) => h.tmuxOf(p) === op.tmux));
  if (from && from.id === op.to) return list;
  if (!from && !op.to) return list;
  // The workspace was closed after the request was made.
  if (op.to && !op.name && !list.some((w) => w.id === op.to)) return list;
  const pane = from?.panes.find((p) => h.tmuxOf(p) === op.tmux) ?? h.pane(op.tmux);
  if (!pane) return list;
  let next = list.map((w) => (w === from ? { ...w, panes: w.panes.filter((p) => h.tmuxOf(p) !== op.tmux) } : w));
  if (op.to) {
    if (!next.some((w) => w.id === op.to)) next = [...next, h.create(op.to, op.name!)];
    next = next.map((w) => (w.id === op.to ? { ...w, panes: [...w.panes, pane] } : w));
  }
  return next.length > 1 && from ? next.filter((w) => w.id !== from.id || w.panes.length > 0) : next;
}
