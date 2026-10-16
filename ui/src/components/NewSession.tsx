import { useEffect, useRef, useState } from 'react';
import type { Agent, Project } from '../../../shared/types';
import { api, type FolderInfo, type LaunchBody } from '../api';

export function NewSession({ preset, projects, onClose, onLaunch, mobile }: {
  preset: { cwd?: string; agent?: Agent };
  projects: Project[];
  onClose: () => void;
  onLaunch: (b: LaunchBody) => Promise<void>;
  /** The phone: a bottom sheet with bigger targets and folder shortcuts, and no autofocus (the keyboard would cover it). */
  mobile?: boolean;
}) {
  const [agent, setAgent] = useState<Agent>(preset.agent || (localStorage.getItem('ms.lastAgent') as Agent) || 'claude');
  const [cwd, setCwd] = useState(preset.cwd || projects[0]?.cwd || '');
  const [prompt, setPrompt] = useState('');
  const [skip, setSkip] = useState(localStorage.getItem('ms.skipPerms') !== '0');
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderInfo | null>(null);
  const cwdRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.projectDirs().then((r) => setDirs(r.dirs)).catch(() => {}); }, []);
  useEffect(() => { if (!mobile) (preset.cwd ? document.getElementById('ms-prompt') : cwdRef.current)?.focus(); }, [preset.cwd, mobile]);

  // Check the typed folder as it changes, so a new one is announced before launch rather than created by a typo.
  const typed = cwd.trim();
  const absolute = /^(~|\/)/.test(typed);
  useEffect(() => {
    setFolder(null);
    if (!typed || !absolute) return;
    let stale = false;
    const t = setTimeout(() => { api.folder(typed).then((f) => { if (!stale) setFolder(f); }).catch(() => {}); }, 150);
    return () => { stale = true; clearTimeout(t); };
  }, [typed, absolute]);
  const creating = !!folder && !folder.exists && folder.parentExists;
  const displayPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

  const known = Array.from(new Set([...projects.map((p) => p.cwd), ...dirs])).sort();
  // iOS hides datalist suggestions in the keyboard bar, so the phone gets the recent project folders as chips.
  const recent = mobile ? Array.from(new Set(projects.map((p) => p.cwd))).slice(0, 12) : [];

  const submit = async () => {
    if (!typed) { setErr('Choose a folder to work in.'); return; }
    if (!absolute) { setErr('Use a full path, such as ~/repos/my-project.'); return; }
    setBusy(true); setErr(null);
    // Started before the folder check came back: ask now rather than fail on a folder the user meant to create.
    const f = folder ?? await api.folder(typed).catch(() => null);
    const createFolder = !!f && !f.exists && f.parentExists;
    localStorage.setItem('ms.lastAgent', agent); localStorage.setItem('ms.skipPerms', skip ? '1' : '0');
    try { await onLaunch({ agent, cwd: typed, prompt: prompt.trim() || undefined, skipPermissions: skip, createFolder }); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className={`modal-backdrop ${mobile ? 'm-modal' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
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
          {recent.length > 0 && (
            <div className="m-dirs">
              {recent.map((d) => (
                <button key={d} type="button" className={d === typed ? 'on' : ''} title={displayPath(d)} onClick={() => setCwd(d)}>{d.split('/').pop() || d}</button>
              ))}
            </div>
          )}
          {creating && <span className="field-note new">New folder. Tower creates <b>{folder!.path.split('/').pop()}</b> in {displayPath(folder!.parent)}.</span>}
          {folder && !folder.exists && !folder.parentExists && <span className="field-note warn">{displayPath(folder.parent)} does not exist either. Tower creates one new folder at a time.</span>}
          {folder && folder.exists && !folder.isDir && <span className="field-note warn">That is a file, not a folder.</span>}
        </label>
        <label className="field">
          <span className="label">First message <span className="muted">optional</span></span>
          <textarea id="ms-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should it start on?"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }} />
        </label>
        <label className="check">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          Skip permission prompts {!mobile && <span className="muted">({agent === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox'})</span>}
        </label>
        {err && <div className="notice error">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Starting…' : creating ? 'Create folder & start' : 'Start session'}{!mobile && <kbd>⌘⏎</kbd>}</button>
        </div>
      </form>
    </div>
  );
}
