import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/types';
import { api } from '../api';

export function SettingsPanel({ onClose, onDoctor }: { onClose: () => void; onDoctor?: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.settings().then(setS); }, []);
  if (!s) return null;
  const save = async () => { await api.saveSettings(s); setSaved(true); setTimeout(onClose, 400); };
  const list = (v: string[]) => v.join(' ');
  const parse = (t: string) => t.split(/\s+/).filter(Boolean);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <h2>Settings</h2>
        <label className="field"><span className="label">Default Claude flags</span>
          <input value={list(s.claudeArgs)} onChange={(e) => setS({ ...s, claudeArgs: parse(e.target.value) })} spellCheck={false} /></label>
        <label className="field"><span className="label">Default Codex flags</span>
          <input value={list(s.codexArgs)} onChange={(e) => setS({ ...s, codexArgs: parse(e.target.value) })} spellCheck={false} /></label>
        <label className="field"><span className="label">Extra project folders <span className="muted">one per line</span></span>
          <textarea rows={3} value={s.extraProjectDirs.join('\n')} onChange={(e) => setS({ ...s, extraProjectDirs: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} spellCheck={false} /></label>
        <label className="check"><input type="checkbox" checked={s.showImported} onChange={(e) => setS({ ...s, showImported: e.target.checked })} />
          Show Codex threads that were imported from Claude <span className="muted">(duplicates)</span></label>
        <p className="muted small">Sessions live in tmux socket <code>multisession</code>. From any terminal: <code>tmux -L multisession attach</code>.</p>
        <div className="modal-actions">
          {onDoctor && <button type="button" className="btn ghost" style={{ marginRight: 'auto' }} onClick={onDoctor}>Check setup</button>}
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">{saved ? 'Saved' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
