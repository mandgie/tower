import { useEffect, useState } from 'react';
import type { Snapshot, Settings, Agent, TranscriptResponse } from '../../shared/types';

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
};

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

export function useSnapshot(): { snapshot: Snapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl('/ws/events'));
      ws.onopen = () => { setConnected(true); retry = 1000; };
      ws.onmessage = (ev) => { try { setSnapshot(JSON.parse(ev.data)); } catch { /* ignore */ } };
      ws.onclose = () => { setConnected(false); if (!closed) setTimeout(connect, retry); retry = Math.min(retry * 2, 10000); };
      ws.onerror = () => ws?.close();
    };
    api.sessions().then(setSnapshot).catch(() => {});
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
