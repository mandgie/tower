import type { Session, Project, Snapshot, SnapshotDelta, ProjectDir } from './types';

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
  };
}
