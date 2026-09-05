# Tower

Air-traffic control for your coding agents. A personal desktop app for Claude Code and Codex sessions. Every project you have worked in,
every session, and every live agent in one window. Sessions run inside a dedicated tmux
server, so they survive app restarts and can be attached from any terminal.

## Run

```sh
npm install        # also rebuilds node-pty for Electron
npm start          # build UI + server, open the app
```

Development (hot reload for the UI, restart server on change):

```sh
npm run dev
```

The server listens on http://127.0.0.1:4310 and also works in a normal browser.

## What it reads

- Claude Code transcripts in `~/.claude/projects/*/*.jsonl` (title, first prompt, model, branch, last activity).
- Claude Code live registry in `~/.claude/sessions/*.json` (which sessions are running, in which terminal, idle or working).
- Codex threads from `~/.codex/state_*.sqlite` via the `sqlite3` CLI, and rollouts from `~/.codex/sessions`.
- Codex threads imported from Claude are hidden by default (toggle in Settings).

## How sessions run

- tmux socket `multisession`, one tmux session per agent session, named `ms-claude-<id>` or `ms-codex-<id>`.
- New Claude sessions get a pre-generated `--session-id`, so the transcript maps immediately.
- New Codex sessions start as `ms-codex-new-<stamp>` and are renamed once Codex writes the thread id.
- Panes keep their output after the process exits (`remain-on-exit`), so you can read why something ended.
- Attach from a terminal at any time: `tmux -L multisession attach -t ms-claude-<id>`.

Options live in `~/.multisession/tmux.conf` and `~/.multisession/settings.json`.

## Workspaces

The main area is a workspace: a grid of live terminals. One pane fills the window, two sit side by
side, three or four make a 2x2, up to nine make a 3x3. Each workspace is a tab in the bar above the
grid. Selecting a live session in the sidebar adds it to the current workspace; selecting one that is
already open somewhere switches to that workspace. Drag a pane header onto another pane to swap them.
Closing a workspace or removing a pane only hides it; the session keeps running in tmux.

## Before you resume

Selecting a past session opens its transcript at the latest message, with a summary above it:
context tokens the model will carry on resume (measured for Codex, estimated for Claude from the
last turn's usage), prompt count, tool calls, files edited, sub-agents, compactions, generated tokens,
active time, and transcript size on disk.

## Keys

| Key | Action |
| --- | --- |
| ⌘N | New session |
| ⌘D | New session here: same folder and agent as the focused pane, opened beside it |
| ⌘K | Search sessions (shows the list if hidden) |
| ⌘B | Show or hide the session list |
| ⌘⇧R | Rename workspace (or double-click its name) |
| ⌘T | New workspace |
| ⌘1–9 | Switch workspace |
| ⌘⇧] / ⌘⇧[ | Next / previous workspace |
| ⌘W | Remove focused pane from workspace (session keeps running) |
| ⌘⇧⏎ | Maximize / restore focused pane (Esc also restores) |
| ⌘⌥Arrows | Move focus between panes |
| ⌘, | Settings |

## Layout

```
server/    Node backend: scanners, tmux, pty bridge, HTTP + WebSocket API
ui/        Vite + React front end, xterm.js terminals, workspace grid (components/Workspace.tsx)
electron/  Window shell and menu; spawns the server bundle
shared/    Types shared by server and UI
```
