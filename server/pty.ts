import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import path from 'node:path';
import { TMUX_SOCKET, APP_DIR } from './config.js';
import { shellEnv } from './shell.js';

export function attachTerminal(ws: WebSocket, session: string, cols: number, rows: number): void {
  const term = pty.spawn('tmux', ['-L', TMUX_SOCKET, '-f', path.join(APP_DIR, 'tmux.conf'), 'attach-session', '-t', `=${session}`], {
    name: 'xterm-256color',
    cols: Math.max(20, cols || 120),
    rows: Math.max(5, rows || 30),
    cwd: process.env.HOME,
    env: shellEnv() as Record<string, string>,
  });

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      ws.close();
    }
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) { term.write(raw.toString()); return; }
    const s = raw.toString();
    if (s.startsWith('{')) {
      try {
        const m = JSON.parse(s);
        if (m.type === 'resize' && m.cols && m.rows) { term.resize(m.cols, m.rows); return; }
        if (m.type === 'input') { term.write(m.data); return; }
      } catch { /* fallthrough: treat as input */ }
    }
    term.write(s);
  });
  ws.on('close', () => { try { term.kill(); } catch { /* already gone */ } });
  ws.on('error', () => { try { term.kill(); } catch { /* ignore */ } });
}
