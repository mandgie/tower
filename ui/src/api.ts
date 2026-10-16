import { useEffect, useState } from 'react';
import { applyDelta } from '../../shared/snapshot';
import type { Snapshot, SnapshotEvent, Settings, Agent, TranscriptResponse, DoctorResult, RemoteInfo, WorkspaceSummary, WorkspaceOp, WorkspaceOpRequest, Todo, TodoStatus } from '../../shared/types';

/** Where the Mac should put a session the phone starts (see `Placement`); absent on the desktop, which opens its own panes. */
export interface Place { workspace?: string }
export interface LaunchBody { agent: Agent; cwd: string; prompt?: string; skipPermissions?: boolean; createFolder?: boolean; place?: Place }
export interface FolderInfo { path: string; exists: boolean; isDir: boolean; parent: string; parentExists: boolean }

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  sessions: () => j<Snapshot>('/api/sessions'),
  transcript: (agent: Agent, id: string) => j<TranscriptResponse>(`/api/sessions/${agent}/${id}/transcript`),
  resume: (agent: Agent, id: string, opts: { skipPermissions?: boolean; fork?: boolean; place?: Place } = {}) =>
    j<{ tmux: string }>(`/api/sessions/${agent}/${id}/${opts.fork ? 'fork' : 'resume'}`, { method: 'POST', body: JSON.stringify(opts) }),
  launch: (body: LaunchBody) =>
    j<{ tmux: string; key?: string }>('/api/sessions/new', { method: 'POST', body: JSON.stringify(body) }),
  kill: (tmux: string) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/kill`, { method: 'POST' }),
  settings: () => j<Settings>('/api/settings'),
  saveSettings: (s: Partial<Settings>) => j<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  projectDirs: () => j<{ dirs: string[] }>('/api/projects/dirs'),
  folder: (path: string) => j<FolderInfo>(`/api/folder?path=${encodeURIComponent(path)}`),
  doctor: () => j<DoctorResult>('/api/doctor'),
  capture: (tmux: string, lines = 0) => j<{ text: string; alt: boolean; mouse: boolean; width: number }>(`/api/tmux/${encodeURIComponent(tmux)}/capture?lines=${lines}`),
  scroll: (tmux: string, lines: number) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/scroll`, { method: 'POST', body: JSON.stringify({ lines }) }),
  send: (tmux: string, text: string, enter = true, files: string[] = []) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/send`, { method: 'POST', body: JSON.stringify({ text, enter, files }) }),
  upload: (file: Blob) => j<{ path: string }>('/api/uploads', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }),
  seen: (client: string, keys: string[]) => j<{ ok: true }>('/api/seen', { method: 'POST', body: JSON.stringify({ client, keys }) }),
  keys: (tmux: string, keys: string[]) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/keys`, { method: 'POST', body: JSON.stringify({ keys }) }),
  workspaceOp: (op: WorkspaceOpRequest) => j<WorkspaceOp>('/api/workspaces/ops', { method: 'POST', body: JSON.stringify(op) }),
  clearWorkspaceOp: (id: string) => j<{ ok: true }>(`/api/workspaces/ops/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearPlacement: (tmux: string) => j<{ ok: true }>(`/api/placements/${encodeURIComponent(tmux)}`, { method: 'DELETE' }),
  saveWorkspaces: (w: WorkspaceSummary[]) => j<{ ok: true }>('/api/workspaces', { method: 'PUT', body: JSON.stringify(w) }),
  remote: () => j<RemoteInfo>('/api/remote'),
  rotateRemote: () => j<RemoteInfo>('/api/remote/rotate', { method: 'POST' }),
  setTodo: (id: string, status: TodoStatus) => j<Todo>(`/api/todos/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ status }) }),
  removeWorktree: (id: string, force = false) => j<Todo>(`/api/todos/${encodeURIComponent(id)}/worktree${force ? '?force=1' : ''}`, { method: 'DELETE' }),
  dismissFinish: (id: string) => j<Todo>(`/api/todos/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ dismissFinish: true }) }),
  startTodo: (id: string, skipPermissions?: boolean) => j<{ tmux: string; key?: string }>(`/api/todos/${encodeURIComponent(id)}/start`, { method: 'POST', body: JSON.stringify({ skipPermissions }) }),
  scanTodos: (workspace: string) => j<{ ok: true }>('/api/todos/scan', { method: 'POST', body: JSON.stringify({ workspace }) }),
};

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

const EMPTY: Snapshot = { generatedAt: 0, sessions: [], projects: [], extraDirs: [], pending: [], renamed: {} };

export function useSnapshot(): { snapshot: Snapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl('/ws/events?v=2'));
      ws.onopen = () => { setConnected(true); retry = 1000; };
      ws.onmessage = (ev) => {
        let m: SnapshotEvent;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'full') setSnapshot(m.snapshot);
        else setSnapshot((prev) => applyDelta(prev ?? EMPTY, m));
      };
      ws.onclose = () => { setConnected(false); if (!closed) setTimeout(connect, retry); retry = Math.min(retry * 2, 10000); };
      ws.onerror = () => ws?.close();
    };
    // The socket opens with the whole snapshot; no separate fetch that could land after a newer delta.
    connect();
    return () => { closed = true; ws?.close(); };
  }, []);
  return { snapshot, connected };
}

export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w}w`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function useNow(interval = 15000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(t); }, [interval]);
  return now;
}

/** This window, for `/api/seen`. */
const CLIENT = Math.random().toString(36).slice(2, 10);
/** Without a key or mouse event for this long, a focused Mac window no longer counts as looked at. */
const AWAY_MS = 5 * 60 * 1000;

/**
 * Whether someone is looking at this window: it is visible, and on the Mac it also has focus and saw input
 * in the last five minutes (a Mac left on with Tower in front is not someone reading it).
 */
export function usePresent(needFocus: boolean): boolean {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    let lastInput = Date.now();
    const check = () => setPresent(document.visibilityState === 'visible' && (!needFocus || (document.hasFocus() && Date.now() - lastInput < AWAY_MS)));
    const input = () => { const was = Date.now() - lastInput >= AWAY_MS; lastInput = Date.now(); if (was) check(); };
    check();
    const t = setInterval(check, 30_000);
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, input, { capture: true, passive: true });
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    return () => {
      clearInterval(t);
      for (const e of events) window.removeEventListener(e, input, { capture: true });
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
    };
  }, [needFocus]);
  return present;
}

/** Tell the server which sessions this window shows, so a turn that ends in view is not marked `done`. */
export function useViewing(keys: string[], present: boolean): void {
  const list = present ? [...new Set(keys)].sort().join('\n') : '';
  useEffect(() => {
    const keys = list ? list.split('\n') : [];
    const send = () => { api.seen(CLIENT, keys).catch(() => {}); };
    send();
    if (!keys.length) return;
    const t = setInterval(send, 15_000);
    const leave = () => navigator.sendBeacon('/api/seen', JSON.stringify({ client: CLIENT, keys: [] }));
    window.addEventListener('pagehide', leave);
    return () => { clearInterval(t); window.removeEventListener('pagehide', leave); };
  }, [list]);
}
