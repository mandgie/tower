import { useEffect, useState } from 'react';
import type { RemoteInfo, Settings } from '../../../shared/types';
import { api } from '../api';

type RemoteFields = Pick<Settings, 'remoteEnabled' | 'remoteAllowLan'>;

/**
 * Settings section for reaching Tower from a phone or iPad. Toggles apply at once (the server starts or
 * stops its remote listener) instead of waiting for the Settings form's Save. Hidden on a remote device,
 * where /api/remote answers 403.
 */
export function RemoteAccess({ s, onChange }: { s: Settings; onChange: (patch: RemoteFields) => void }) {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => api.remote().then((r) => { if (live) setInfo(r); }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!info) return null;

  const set = async (patch: Partial<RemoteFields>) => {
    const next = { remoteEnabled: s.remoteEnabled, remoteAllowLan: s.remoteAllowLan, ...patch };
    onChange(next);
    setBusy(true);
    try { await api.saveSettings(next); setInfo(await api.remote()); } finally { setBusy(false); }
  };
  const unpair = async () => { setInfo(await api.rotateRemote()); setConfirmUnpair(false); };
  const url = info.urls[Math.min(pick, info.urls.length - 1)];

  return (
    <section className="remote">
      <div className="remote-head">
        <span className="label">Remote access</span>
        {info.listening && <span className="remote-live">{info.connected ? `${info.connected} device${info.connected > 1 ? 's' : ''} connected` : 'On'}</span>}
      </div>
      <label className="check"><input type="checkbox" checked={s.remoteEnabled} disabled={busy} onChange={(e) => set({ remoteEnabled: e.target.checked })} />
        Open Tower from your phone or iPad over Tailscale</label>
      {s.remoteEnabled && <>
        <label className="check"><input type="checkbox" checked={s.remoteAllowLan} disabled={busy} onChange={(e) => set({ remoteAllowLan: e.target.checked })} />
          Also allow devices on this Wi-Fi <span className="muted">(not encrypted)</span></label>
        {info.error && <p className="remote-warn small">{info.error}</p>}
        {!info.tailscale && <p className="remote-warn small">This Mac has no Tailscale address. Install Tailscale, sign in on the Mac and on your phone with the same account, then come back here.</p>}
        {info.listening && url && (
          <div className="remote-pair">
            <div className="remote-qr" dangerouslySetInnerHTML={{ __html: url.qrSvg }} />
            <div className="remote-pair-text">
              <p className="small">Scan with the phone's camera to pair it. After that, open this address:</p>
              {info.urls.length > 1
                ? <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
                    {info.urls.map((u, i) => <option key={u.url} value={i}>{u.kind === 'lan' ? 'Wi-Fi: ' : ''}{u.url.replace(/^http:\/\//, '')}</option>)}
                  </select>
                : <code className="remote-url">{url.url.replace(/^http:\/\//, '')}</code>}
              <p className="muted small">Tip: in Safari use Share → Add to Home Screen.</p>
              {confirmUnpair
                ? <div className="remote-unpair">
                    <span className="small">Every paired device must scan again.</span>
                    <button type="button" className="btn small danger" onClick={unpair}>Unpair all</button>
                    <button type="button" className="btn small ghost" onClick={() => setConfirmUnpair(false)}>Keep</button>
                  </div>
                : <button type="button" className="btn small ghost remote-unpair-btn" onClick={() => setConfirmUnpair(true)}>Unpair all devices…</button>}
            </div>
          </div>
        )}
      </>}
    </section>
  );
}
