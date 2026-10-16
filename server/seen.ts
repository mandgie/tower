import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './config.js';
import type { Session, Status } from '../shared/types.js';

/**
 * `done`: the agent finished a turn that nobody has looked at yet. Each open window (the Mac, a phone)
 * says which sessions it shows; a session counts as seen while one of them shows it. A turn that ends
 * after the last look makes the session `done` until someone opens it, and then it is `waiting` again.
 * The finish and look times are kept on disk, so a restart does not forget what is unread.
 */
const FILE = path.join(APP_DIR, 'seen.json');
/** A window repeats what it shows every 15 seconds; one that stops (closed, asleep) is ignored after this. */
const LEASE_MS = 40_000;

interface Mark { finishedAt?: number; seenAt?: number }

let marks: Record<string, Mark> = load();
let dirty = false;
const viewers = new Map<string, { keys: string[]; until: number }>();
/** Last status per session key and per tmux name: a fresh session changes key when its transcript appears. */
const last = new Map<string, Status>();

function load(): Record<string, Mark> {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

function save(): void {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(FILE, JSON.stringify(marks)); } catch { /* next change tries again */ }
}
setInterval(save, 5000).unref();

/** What one window shows now; an empty list when it is hidden or closed. */
export function setViewing(client: string, keys: string[]): void {
  if (!client) return;
  if (keys.length) viewers.set(client, { keys, until: Date.now() + LEASE_MS });
  else viewers.delete(client);
  const now = Date.now();
  for (const k of keys) { marks[k] = { ...marks[k], seenAt: now }; dirty = true; }
}

/** Turn `waiting` into `done` for sessions whose last turn ended after anyone looked. */
export function applyDone(sessions: Session[], now = Date.now()): void {
  const viewed = new Set<string>();
  for (const [c, v] of viewers) {
    if (v.until < now) viewers.delete(c);
    else for (const k of v.keys) viewed.add(k);
  }
  const live = new Set<string>();
  for (const s of sessions) {
    if (!s.live) continue;
    const tmux = s.live.kind === 'tmux' ? `tmux:${s.live.tmux}` : '';
    live.add(s.key);
    if (tmux) live.add(tmux);
    const prev = last.get(s.key) ?? (tmux ? last.get(tmux) : undefined);
    last.set(s.key, s.status);
    if (tmux) last.set(tmux, s.status);
    let m = marks[s.key];
    if (prev === 'working' && s.status === 'waiting') { m = marks[s.key] = { ...m, finishedAt: now }; dirty = true; }
    if (viewed.has(s.key)) { m = marks[s.key] = { ...m, seenAt: now }; dirty = true; }
    if (s.status === 'waiting' && m?.finishedAt && m.finishedAt > (m.seenAt ?? 0)) s.status = 'done';
  }
  for (const k of Object.keys(marks)) if (!live.has(k)) { delete marks[k]; dirty = true; }
  for (const k of last.keys()) if (!live.has(k)) last.delete(k);
}
