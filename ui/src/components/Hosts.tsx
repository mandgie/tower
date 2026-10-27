import { useEffect, useState } from 'react';
import type { HostInfo } from '../../../shared/types';
import { api, relTime } from '../api';

/**
 * Settings section for hosts: other Tower servers (a VM) whose sessions show up here. Pairing uses the
 * host's own pairing link, the one its phone QR code holds. Hidden on a remote device, where /api/hosts
 * answers 403.
 */
export function Hosts() {
  const [hosts, setHosts] = useState<HostInfo[] | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.hosts().then((h) => { if (live) setHosts(h); }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!hosts) return null;

  const add = async () => {
    setBusy(true); setErr(null);
    try { await api.addHost(link.trim()); setLink(''); setHosts(await api.hosts()); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (name: string) => { await api.removeHost(name); setConfirm(null); setHosts(await api.hosts()); };

  return (
    <section className="hosts">
      <span className="label">Hosts <span className="muted">other Tower servers whose sessions show here</span></span>
      {hosts.map((h) => (
        <div key={h.name} className="host-row">
          <span className={`host-dot ${h.online ? 'on' : ''}`} />
          <span className="host-name">{h.name}</span>
          <span className="muted small host-state" title={h.url}>
            {h.online ? 'Online' : h.error || 'Out of reach'}{!h.online && h.seenAt ? ` · last seen ${relTime(h.seenAt)}` : ''}
          </span>
          {confirm === h.name
            ? <button type="button" className="btn ghost small" onClick={() => remove(h.name)}>Confirm remove</button>
            : <button type="button" className="btn ghost small" onClick={() => setConfirm(h.name)}>Remove</button>}
        </div>
      ))}
      <div className="host-add">
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Pairing link of the other Tower (…:4311/pair?t=…)" spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (link.trim()) add(); } }} />
        <button type="button" className="btn" disabled={busy || !link.trim()} onClick={add}>{busy ? 'Pairing…' : 'Add host'}</button>
      </div>
      {err && <p className="remote-warn small">{err}</p>}
    </section>
  );
}
