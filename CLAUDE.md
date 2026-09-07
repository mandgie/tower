# Tower

Desktop cockpit for Claude Code + Codex sessions (package name `tower`; tmux socket and `~/.multisession` keep the old working name on purpose). Electron shell, Node server, React UI, tmux as the session host.

## Commands

- `npm run dev` — server (tsx watch under Electron's Node), Vite UI on :5173, Electron window.
- `npm start` — full build, then Electron serving `ui/dist` from the server on :4310.
- `npx tsc --noEmit` — typecheck everything.
- `npm run dist` — build, then electron-builder makes `release/Tower-<version>-arm64.dmg` (config in `package.json` under `build`).
- `npm run icon` — re-render `build/icon.icns` from `build/icon.svg`.

## Rules of the road

- node-pty is rebuilt for Electron's ABI in `postinstall`. Run the server through `ELECTRON_RUN_AS_NODE=1 electron …`, never plain `node`, or the native module fails to load.
- Never touch the user's default tmux server. Everything goes through socket `-L multisession` and `~/.multisession/tmux.conf`.
- Session identity is the tmux session name: `ms-<agent>-<id>`. Do not add a second registry.
- Scanning 500 MB of Claude transcripts must stay cheap: read head and tail only, cache by size+mtime (`server/claude.ts`).
- Codex data comes from the `threads` table through the `sqlite3` CLI (no native sqlite dependency).
- Status for a live Claude session comes from `~/.claude/sessions/<pid>.json` (`status: idle` means waiting for the user). Fall back to transcript mtime.
- Packaging: `electron/main.cjs` starts `dist/server.cjs` with `utilityProcess.fork`, so it runs from inside `app.asar` on Electron's Node. node-pty is `asarUnpack`ed; everything else in `files` is inside the asar. The build is ad-hoc signed (`identity: "-"`).
- Ports: with `MS_PORT` unset the server listens on port 0, reports the chosen port to the main process via `process.parentPort`, and the main process stores it in `userData/server.json` so the packaged app keeps the same origin (and localStorage) between launches. If that port is busy the server falls back to a free one. `npm run dev` / `npm start` pin `MS_PORT=4310`.
- A non-packaged build (`!app.isPackaged`) calls itself "Tower Dev" with its own userData folder, so its single-instance lock and window state never collide with the installed app.
- macOS lifecycle: closing the window keeps the app and its server alive; Dock click reopens; Cmd+Q kills the utility process. The tmux server and agent sessions are independent processes and survive quit.
- UI state: workspaces (grid of panes) live in `ui/src/App.tsx` and persist to localStorage key `ms.workspaces`. Pane identity is the tmux name; a Codex pane starts as `ms-codex-new-*` and is renamed by the reconcile effect.
