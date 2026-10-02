import { useEffect, useState } from 'react';
import { applyDelta } from '../../shared/snapshot';
import type { Snapshot, SnapshotEvent, Settings, Agent, TranscriptResponse, DoctorResult, RemoteInfo, WorkspaceSummary } from '../../shared/types';

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
  resume: (agent: Agent, id: string, opts: { skipPermissions?: boolean; fork?: boolean } = {}) =>
    j<{ tmux: string }>(`/api/sessions/${agent}/${id}/${opts.fork ? 'fork' : 'resume'}`, { method: 'POST', body: JSON.stringify(opts) }),
  launch: (body: { agent: Agent; cwd: string; prompt?: string; skipPermissions?: boolean }) =>
    j<{ tmux: string; key?: string }>('/api/sessions/new', { method: 'POST', body: JSON.stringify(body) }),
  kill: (tmux: string) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/kill`, { method: 'POST' }),
  settings: () => j<Settings>('/api/settings'),
  saveSettings: (s: Partial<Settings>) => j<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  projectDirs: () => j<{ dirs: string[] }>('/api/projects/dirs'),
  doctor: () => j<DoctorResult>('/api/doctor'),
  capture: (tmux: string, lines = 0) => j<{ text: string; alt: boolean; mouse: boolean }>(`/api/tmux/${encodeURIComponent(tmux)}/capture?lines=${lines}`),
  scroll: (tmux: string, lines: number) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/scroll`, { method: 'POST', body: JSON.stringify({ lines }) }),
  send: (tmux: string, text: string, enter = true) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/send`, { method: 'POST', body: JSON.stringify({ text, enter }) }),
  keys: (tmux: string, keys: string[]) => j<{ ok: true }>(`/api/tmux/${encodeURIComponent(tmux)}/keys`, { method: 'POST', body: JSON.stringify({ keys }) }),
  saveWorkspaces: (w: WorkspaceSummary[]) => j<{ ok: true }>('/api/workspaces', { method: 'PUT', body: JSON.stringify(w) }),
  remote: () => j<RemoteInfo>('/api/remote'),
  rotateRemote: () => j<RemoteInfo>('/api/remote/rotate', { method: 'POST' }),
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
