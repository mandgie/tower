import { useEffect, useRef, useState } from 'react';
import type { Agent, Project } from '../../../shared/types';
import { api } from '../api';

export function NewSession({ preset, projects, onClose, onLaunch }: {
  preset: { cwd?: string; agent?: Agent };
  projects: Project[];
  onClose: () => void;
  onLaunch: (b: { agent: Agent; cwd: string; prompt?: string; skipPermissions?: boolean }) => Promise<void>;
}) {
  const [agent, setAgent] = useState<Agent>(preset.agent || (localStorage.getItem('ms.lastAgent') as Agent) || 'claude');
  const [cwd, setCwd] = useState(preset.cwd || projects[0]?.cwd || '');
  const [prompt, setPrompt] = useState('');
  const [skip, setSkip] = useState(localStorage.getItem('ms.skipPerms') !== '0');
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cwdRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.projectDirs().then((r) => setDirs(r.dirs)).catch(() => {}); }, []);
  useEffect(() => { (preset.cwd ? document.getElementById('ms-prompt') : cwdRef.current)?.focus(); }, [preset.cwd]);

  const known = Array.from(new Set([...projects.map((p) => p.cwd), ...dirs])).sort();

  const submit = async () => {
    if (!cwd.trim()) { setErr('Choose a folder to work in.'); return; }
    setBusy(true); setErr(null);
    localStorage.setItem('ms.lastAgent', agent); localStorage.setItem('ms.skipPerms', skip ? '1' : '0');
    try { await onLaunch({ agent, cwd: cwd.trim(), prompt: prompt.trim() || undefined, skipPermissions: skip }); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>New session</h2>
        <div className="field">
          <span className="label">Agent</span>
          <div className="seg big">
            <button type="button" className={`agent-claude ${agent === 'claude' ? 'on' : ''}`} onClick={() => setAgent('claude')}>Claude Code</button>
            <button type="button" className={`agent-codex ${agent === 'codex' ? 'on' : ''}`} onClick={() => setAgent('codex')}>Codex</button>
          </div>
        </div>
        <label className="field">
          <span className="label">Folder</span>
          <input ref={cwdRef} list="ms-dirs" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/projects/…" spellCheck={false} />
          <datalist id="ms-dirs">{known.map((d) => <option key={d} value={d} />)}</datalist>
        </label>
        <label className="field">
          <span className="label">First message <span className="muted">optional</span></span>
          <textarea id="ms-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should it start on?"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }} />
        </label>
        <label className="check">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          Skip permission prompts <span className="muted">({agent === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox'})</span>
        </label>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start session'} <kbd>⌘⏎</kbd></button>
        </div>
      </form>
    </div>
  );
}
