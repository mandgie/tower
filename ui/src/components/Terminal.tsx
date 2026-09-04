import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Agent } from '../../../shared/types';
import { wsUrl } from '../api';

const THEME = {
  background: '#0F1418',
  foreground: '#E6ECF1',
  cursor: '#F2A65A',
  cursorAccent: '#0F1418',
  selectionBackground: 'rgba(242,166,90,0.25)',
  black: '#1B232C', red: '#F07178', green: '#8FD9A8', yellow: '#FFD166', blue: '#82AAFF', magenta: '#C792EA', cyan: '#7FE0C8', white: '#D7DEE5',
  brightBlack: '#5A6673', brightRed: '#FF8B92', brightGreen: '#A6F0BF', brightYellow: '#FFE08A', brightBlue: '#9CBBFF', brightMagenta: '#DDB0F5', brightCyan: '#9AF0DC', brightWhite: '#FFFFFF',
};

export function TerminalPane({ tmux, active, agent }: { tmux: string; active: boolean; agent: Agent }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [gen, setGen] = useState(0);

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      theme: { ...THEME, cursor: agent === 'claude' ? '#F2A65A' : '#7FE0C8' },
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term; fitRef.current = fit;
    fit.fit();

    const ws = new WebSocket(wsUrl(`/ws/term?tmux=${encodeURIComponent(tmux)}&cols=${term.cols}&rows=${term.rows}`));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    ws.onopen = () => { setState('open'); ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string' && ev.data.startsWith('{"type":"exit"')) return;
      term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
    };
    ws.onclose = () => setState('closed');
    ws.onerror = () => setState('closed');
    const onData = term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    const onBinary = term.onBinary((d) => { if (ws.readyState === ws.OPEN) ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0))); });
    const onResize = term.onResize(({ cols, rows }) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });

    const ro = new ResizeObserver(() => { if (host.offsetWidth > 0 && host.offsetHeight > 0) requestAnimationFrame(() => fit.fit()); });
    ro.observe(host);

    return () => {
      ro.disconnect(); onData.dispose(); onBinary.dispose(); onResize.dispose();
      ws.close(); term.dispose();
      termRef.current = null; wsRef.current = null;
    };
  }, [tmux, gen, agent]);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => { fitRef.current?.fit(); termRef.current?.focus(); }, 30);
    return () => clearTimeout(t);
  }, [active]);

  return (
    <div className="term-wrap">
      <div className="term-host" ref={hostRef} />
      {state === 'closed' && (
        <div className="term-overlay">
          <div>
            <p>Disconnected from this session.</p>
            <button className="btn" onClick={() => setGen((g) => g + 1)}>Reconnect</button>
          </div>
        </div>
      )}
    </div>
  );
}
