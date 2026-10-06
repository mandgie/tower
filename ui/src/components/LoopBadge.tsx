import type { Session } from '../../../shared/types';
import { relTime, useNow } from '../api';

function fmtIn(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Shown while Claude's own /loop is armed: when it wakes next, how many ticks it has run, and how many in a row changed nothing. */
export function LoopBadge({ session: s }: { session: Session }) {
  const now = useNow(1000);
  const l = s.loop;
  if (!l) return null;
  const ago = (t: number) => { const r = relTime(t, now); return r === 'now' ? 'just now' : `${r} ago`; };
  const ticks = `${l.ticks} ${l.ticks === 1 ? 'tick' : 'ticks'}`;
  let main: string;
  if (l.kind === 'self-paced') main = s.status === 'working' || !l.nextAt || l.nextAt <= now ? 'ticking' : `in ${fmtIn(l.nextAt - now)}`;
  else main = l.schedule || 'scheduled';
  const lines = [
    l.kind === 'self-paced' ? 'Self-paced /loop' : 'Scheduled prompt (cron)',
    l.prompt ? `Runs: ${l.prompt}` : 'Runs: autonomous loop',
    l.nextAt && l.nextAt > now ? `Next wakeup ${new Date(l.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '',
    l.reason ? `Why: ${l.reason}` : '',
    `${ticks}${l.startedAt ? `, started ${ago(l.startedAt)}` : ''}${l.lastAt ? ` · last ${ago(l.lastAt)}` : ''}`,
    l.quiet ? `${l.quiet} quiet ${l.quiet === 1 ? 'tick' : 'ticks'} in a row (nothing changed)` : '',
    l.jobs && l.jobs > 1 ? `${l.jobs} scheduled jobs in this session` : '',
  ].filter(Boolean);
  return (
    <span className={`loop ${l.quiet ? 'quiet' : ''}`} title={lines.join('\n')}>
      <span className="loop-icon" aria-hidden>⟳</span>
      <span className="loop-text">{main} · {ticks}{l.quiet ? ` · ${l.quiet} quiet` : ''}</span>
    </span>
  );
}
