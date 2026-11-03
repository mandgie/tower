import type { CSSProperties } from 'react';
import type { HostInfo, Session } from '../../../shared/types';
import { relTime } from '../api';

/**
 * Machines: this Mac and the hosts (other Tower servers, server/hosts.ts) whose sessions Tower shows.
 * Each host keeps one color everywhere, so a session's machine reads at a glance; this Mac has no tag.
 */

/** The machine filter's value: 'all', '' for this Mac, or a host name. */
export type MachineFilter = string;
export const ALL = 'all';
export const FILTER_KEY = 'ms.machine';

export const machineOf = (s: Pick<Session, 'host'>): string => s.host ?? '';

export function inMachine(filter: MachineFilter, s: Pick<Session, 'host'>): boolean {
  return filter === ALL || machineOf(s) === filter;
}

// Hues apart from the status colors (orange working, yellow waiting, teal Codex), most distinct first.
const PALETTE = ['#A78BFA', '#60A5FA', '#A3E635', '#F472B6', '#FDE68A', '#67E8F9', '#FCA5A5', '#D8B4FE'];

/** Hosts in the order Settings lists them, so the first ones get the most distinct colors. */
let order: string[] = [];
export function setMachineOrder(hosts: HostInfo[] | undefined): void {
  order = (hosts ?? []).map((h) => h.name);
}

export function machineColor(host: string): string {
  const i = order.indexOf(host);
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const vars = (host: string) => ({ '--machine': machineColor(host) }) as CSSProperties;

/** A small colored name tag for a session on a host; nothing for this Mac. */
export function MachineTag({ host, offline }: { host?: string; offline?: boolean }) {
  if (!host) return null;
  return (
    <span className={`machine-tag ${offline ? 'offline' : ''}`} style={vars(host)} title={offline ? `Runs on ${host}, which is out of reach` : `Runs on ${host}`}>
      {host}
    </span>
  );
}

export function hostOnline(hosts: HostInfo[] | undefined, host?: string): boolean {
  return !host || !!hosts?.find((h) => h.name === host)?.online;
}

/** One line under a machine's name: online, or how long it has been out of reach. */
export function machineState(h: HostInfo | undefined, now: number): string {
  if (!h) return 'online';
  if (h.online) return 'online';
  return h.seenAt ? `offline · seen ${relTime(h.seenAt, now)} ago` : 'offline';
}

/** All · This Mac · host…, each with its live count; shown only when there is a host. */
export function MachineFilterBar({ hosts, sessions, value, onChange }: {
  hosts: HostInfo[]; sessions: Session[]; value: MachineFilter; onChange: (v: MachineFilter) => void;
}) {
  const live = (m: string) => sessions.filter((s) => s.live && s.status !== 'ended' && (m === ALL || machineOf(s) === m)).length;
  const item = (v: MachineFilter, label: string, host?: HostInfo) => (
    <button key={v} type="button" role="tab" aria-selected={value === v} className={`machine-pick ${value === v ? 'on' : ''}`}
      style={host ? vars(host.name) : undefined} onClick={() => onChange(v)}
      title={host ? `${host.name}: ${host.online ? 'online' : host.error || 'out of reach'}` : undefined}>
      {v !== ALL && <span className={`machine-dot ${host && !host.online ? 'offline' : ''} ${v === '' ? 'local' : ''}`} />}
      <span>{label}</span>
      <span className="machine-live">{live(v) || ''}</span>
    </button>
  );
  return (
    <div className="machine-bar" role="tablist" aria-label="Machine">
      {item(ALL, 'All')}
      {item('', 'This Mac')}
      {hosts.map((h) => item(h.name, h.name, h))}
    </div>
  );
}
