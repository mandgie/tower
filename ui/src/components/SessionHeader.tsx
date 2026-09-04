import { useEffect, useState } from 'react';
import type { Session } from '../../../shared/types';
import { statusWord } from './StatusStrip';

export function SessionHeader({ session: s, onResume, onFork, onKill }: {
  session: Session; onResume?: () => void; onFork?: () => void; onKill?: () => void;
}) {
  const home = '~';
  const cwd = s.cwd.replace(/^\/Users\/[^/]+/, home);
  const external = s.live?.kind === 'external';
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(t); }, [confirm]);
  useEffect(() => { setConfirm(false); }, [s.key]);
  const killLabel = s.status === 'ended' ? 'Close' : confirm ? 'Confirm kill' : 'Kill';
  const onKillClick = () => { if (s.status === 'ended' || confirm) { setConfirm(false); onKill?.(); } else setConfirm(true); };
  return (
    <div className={`session-head agent-${s.agent}`}>
      <div className="head-main">
        <div className="head-title">
          <span className="agent-badge">{s.agent === 'claude' ? 'Claude' : 'Codex'}</span>
          <h2>{s.title || 'Untitled'}</h2>
          {s.live && <span className={`pill status-${s.status}`}>{external ? 'in another terminal' : statusWord(s.status)}</span>}
        </div>
        <div className="head-meta">
          <span className="mono" title={s.cwd}>{cwd}</span>
          {s.gitBranch && s.gitBranch !== 'HEAD' && <span className="mono">⎇ {s.gitBranch}</span>}
          {s.model && <span className="mono">{s.model}</span>}
          {s.agentName && <span className="mono">{s.agentName}</span>}
          <span className="mono dim" title="Session id" onClick={() => navigator.clipboard?.writeText(s.id)} style={{ cursor: 'copy' }}>{s.id.slice(0, 8)}</span>
        </div>
      </div>
      <div className="head-actions">
        {external && <span className="hint">Attached to pid {(s.live as any).pid}. Finish it there, then resume here.</span>}
        {onResume && !s.live && <button className="btn primary" onClick={onResume}>Resume</button>}
        {onFork && s.transcriptPath && <button className="btn" onClick={onFork} title="Start a new session that continues from this conversation">Fork</button>}
        {onKill && s.live?.kind === 'tmux' && <button className={`btn danger ${confirm ? 'armed' : ''}`} onClick={onKillClick} title="Kill the process and its tmux session">{killLabel}</button>}
      </div>
    </div>
  );
}
