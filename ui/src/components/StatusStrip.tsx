import type { Session } from '../../../shared/types';
import { relTime, useNow } from '../api';

const ORDER: Record<string, number> = { done: 0, working: 1, waiting: 2, looping: 3, ended: 4, idle: 5 };

export function StatusStrip({ sessions, connected, onPick, activeKey, sidebarOpen, onToggleSidebar }: {
  sessions: Session[]; connected: boolean; onPick: (s: Session) => void; activeKey: string | null;
  sidebarOpen: boolean; onToggleSidebar: () => void;
}) {
  const now = useNow(5000);
  const live = sessions.filter((s) => s.live).sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (b.updatedAt - a.updatedAt));
  const done = live.filter((s) => s.status === 'done').length;
  const working = live.filter((s) => s.status === 'working').length;
  const looping = live.filter((s) => s.status === 'looping').length;

  return (
    <header className="strip">
      <button className={`sidebar-toggle ${sidebarOpen ? 'open' : ''}`} onClick={onToggleSidebar}
        title={`${sidebarOpen ? 'Hide' : 'Show'} session list  ⌘B`} aria-label={sidebarOpen ? 'Hide session list' : 'Show session list'} aria-pressed={sidebarOpen}>
        <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <rect x="0.7" y="0.7" width="14.6" height="12.6" rx="2.2" />
          <line x1="5.6" y1="0.7" x2="5.6" y2="13.3" />
          {sidebarOpen && <rect className="toggle-fill" x="0.7" y="0.7" width="4.9" height="12.6" rx="2.2" fill="currentColor" stroke="none" opacity="0.35" />}
        </svg>
      </button>
      <div className="brand">
        <span className={`beacon ${connected ? 'on' : 'off'}`} />
        <span className="brand-name">tower</span>
      </div>
      <div className="strip-summary">
        {live.length === 0 ? <span className="muted">No live sessions</span> : (
          <>
            {done > 0 && <span className="sum sum-wait">{done} need{done === 1 ? 's' : ''} you</span>}
            {working > 0 && <span className="sum sum-work">{working} working</span>}
            {looping > 0 && <span className="sum sum-loop">{looping} looping</span>}
          </>
        )}
      </div>
      <div className="chips">
        {live.map((s) => (
          <button key={s.key} className={`chip agent-${s.agent} status-${s.status} ${activeKey === s.key ? 'active' : ''}`} onClick={() => onPick(s)}
            title={`${s.title}\n${s.cwd}${s.live?.kind === 'external' ? '\nRunning in another terminal' : ''}`}>
            <span className="dot" />
            <span className="chip-name">{s.project}</span>
            <span className="chip-meta">{s.live?.kind === 'external' ? 'terminal' : statusWord(s.status)} · {relTime(s.updatedAt, now)}</span>
          </button>
        ))}
      </div>
    </header>
  );
}

export function statusWord(st: Session['status']): string {
  return st === 'done' ? 'needs you' : st === 'waiting' ? 'your turn' : st === 'working' ? 'working' : st === 'looping' ? 'looping' : st === 'ended' ? 'exited' : '';
}
