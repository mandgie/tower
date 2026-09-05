# Tower

Desktop cockpit for Codex + Codex sessions (package name `tower`; tmux socket and `~/.multisession` keep the old working name on purpose). Electron shell, Node server, React UI, tmux as the session host.

## Commands

- `npm run dev` — server (tsx watch under Electron's Node), Vite UI on :5173, Electron window.
- `npm start` — full build, then Electron serving `ui/dist` from the server on :4310.
- `npx tsc --noEmit` — typecheck everything.

## Rules of the road

- node-pty is rebuilt for Electron's ABI in `postinstall`. Run the server through `ELECTRON_RUN_AS_NODE=1 electron …`, never plain `node`, or the native module fails to load.
- Never touch the user's default tmux server. Everything goes through socket `-L multisession` and `~/.multisession/tmux.conf`.
- Session identity is the tmux session name: `ms-<agent>-<id>`. Do not add a second registry.
- Scanning 500 MB of Codex transcripts must stay cheap: read head and tail only, cache by size+mtime (`server/Codex.ts`).
- Codex data comes from the `threads` table through the `sqlite3` CLI (no native sqlite dependency).
- Status for a live Codex session comes from `~/.Codex/sessions/<pid>.json` (`status: idle` means waiting for the user). Fall back to transcript mtime.
- UI state: workspaces (grid of panes) live in `ui/src/App.tsx` and persist to localStorage key `ms.workspaces`. Pane identity is the tmux name; a Codex pane starts as `ms-codex-new-*` and is renamed by the reconcile effect.
