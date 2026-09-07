import { useEffect, useState } from 'react';
import type { DoctorCheck, DoctorResult } from '../../../shared/types';
import { api } from '../api';

function tone(c: DoctorCheck): 'ok' | 'missing' | 'optional' {
  if (c.found) return 'ok';
  return c.required ? 'missing' : 'optional';
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }
    catch { /* clipboard unavailable; the text is still selectable */ }
  };
  return (
    <div className="doctor-hint">
      <code>{text}</code>
      <button type="button" className="btn ghost small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/** Setup check: which external tools Tower can see on the login PATH, and how to install the missing ones. */
export function Doctor({ initial, onClose }: { initial?: DoctorResult | null; onClose: () => void }) {
  const [r, setR] = useState<DoctorResult | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setR(await api.doctor()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (!initial) run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const agents = r?.checks.filter((c) => c.id === 'claude' || c.id === 'codex') ?? [];
  const noAgent = !!r && agents.length > 0 && agents.every((c) => !c.found);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal doctor" role="dialog" aria-label="Check setup">
        <h2>Setup check</h2>
        <p className="muted small">
          {r ? (r.ok ? 'Everything Tower needs is installed.' : 'Some tools are missing. Install them with the commands below, then check again.')
            : err ? `Could not run the check: ${err}` : 'Checking…'}
        </p>
        {r && (
          <ul className="doctor-list">
            {r.checks.map((c) => (
              <li key={c.id} className={`doctor-row ${tone(c)}`}>
                <span className="doctor-dot" aria-hidden />
                <div className="doctor-main">
                  <div className="doctor-title">
                    <span className="doctor-label">{c.label}</span>
                    <span className="doctor-tag">{c.found ? 'found' : c.required ? 'required' : 'optional'}</span>
                  </div>
                  {c.found
                    ? <div className="doctor-detail mono">{c.version || c.path}{c.version && c.path ? <span className="muted"> · {c.path}</span> : null}</div>
                    : <CopyLine text={c.hint} />}
                </div>
              </li>
            ))}
          </ul>
        )}
        {noAgent && <p className="doctor-warn small">Neither the Claude CLI nor the Codex CLI was found. Tower needs at least one to start sessions.</p>}
        {r && (
          <details className="doctor-env">
            <summary className="muted small">What Tower sees</summary>
            <div className="small"><span className="label">Shell</span> <code>{r.shell}</code></div>
            <div className="small"><span className="label">PATH</span></div>
            <div className="doctor-path mono">{r.path.split(':').filter(Boolean).map((d, i) => <div key={i}>{d}</div>)}</div>
          </details>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Check again'}</button>
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
