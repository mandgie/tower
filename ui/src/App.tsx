import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Agent, DoctorResult, WorkspaceSummary } from '../../shared/types';
import { placementTarget, applyWorkspaceOp } from '../../shared/snapshot';
import { onHost, splitHost } from '../../shared/hosts';
import { api, useSnapshot, usePresent, useViewing, type LaunchBody } from './api';
import { StatusStrip } from './components/StatusStrip';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { WorkspaceList, listOrder } from './components/WorkspaceList';
import { Transcript } from './components/Transcript';
import { SessionHeader } from './components/SessionHeader';
import { NewSession } from './components/NewSession';
import { SettingsPanel } from './components/SettingsPanel';
import { Doctor } from './components/Doctor';
import { WorkspaceBar, isAutoName, PaneGrid, gridColumns, type Workspace, type Pane } from './components/Workspace';
import { TodoPanel } from './components/TodoPanel';
import { useVisualViewportHeight } from './components/viewport';
import { ALL, FILTER_KEY, inMachine, type MachineFilter } from './components/Machine';

declare global {
  interface Window { multisession?: { onCommand: (cb: (cmd: string) => void) => () => void; openExternal?: (url: string) => Promise<boolean>; pathForFile?: (file: File) => string } }
}

const WS_KEY = 'ms.workspaces';
const OLD_TABS_KEY = 'ms.tabs';
const VIEW_KEY = 'ms.view';
const SIDEBAR_KEY = 'ms.sidebar';
const TODOS_KEY = 'ms.todosOpen';
const ACTIVE_KEY = 'ms.activeByMachine';
/** Where the workspaces show: 'side' is a list in the sidebar, 'top' the tab bar above the grid. */
const WS_PLACE_KEY = 'ms.wsPlace';
const WS_LIST_SHOWN_KEY = 'ms.wsListShown';

const newId = () => Math.random().toString(36).slice(2, 10);

/** Session key for a tmux name (`ms-claude-<id>` -> `claude:<id>`), for sessions that are no longer in the snapshot's live map. */
const keyOfTmux = (tmux: string) => tmux.replace(/^(@[^:]+:)?ms-(claude|codex)-/, '$1$2:');

/**
 * Workspaces belong to a machine: this Mac ('') or a host (server/hosts.ts). A host's workspaces are
 * stored on the host and carry `@host:` in their ids and pane names; the Mac's live in localStorage.
 */
const wsHost = (w: { id: string }) => splitHost(w.id)?.host ?? '';
const tmuxHost = (tmux: string) => splitHost(tmux)?.host ?? '';
const agentOfTmux = (tmux: string): Agent => (/(^|:)ms-codex-/.test(tmux) ? 'codex' : 'claude');
const summaryOf = (w: Workspace): WorkspaceSummary => ({ id: w.id, name: w.name, panes: w.panes.map((p) => p.tmux), ...(w.auto ? { auto: true } : {}), ...(w.todos ? { todos: true } : {}), ...(w.cols ? { cols: w.cols } : {}) });
/** A list of workspaces as a host stores it, as one string, to tell whether two lists differ. */
const canon = (list: WorkspaceSummary[]) => JSON.stringify(list.map((w) => [w.id, w.name, w.panes, !!w.auto, !!w.todos, w.cols ?? 0]));
/** Apply `fn` to one machine's workspaces and keep the others; the Mac's come first. */
function withMachine(ws: Workspace[], host: string, fn: (mine: Workspace[]) => Workspace[]): Workspace[] {
  const mine = fn(ws.filter((w) => wsHost(w) === host));
  const others = ws.filter((w) => wsHost(w) !== host);
  return host ? [...others, ...mine] : [...mine, ...others];
}

function loadWorkspaces(): { workspaces: Workspace[]; activeId: string } {
  try {
    const raw = localStorage.getItem(WS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      const mine = Array.isArray(j.workspaces) ? (j.workspaces as Workspace[]).filter((w) => !wsHost(w)) : [];
      if (mine.length) return { workspaces: mine, activeId: j.activeId || mine[0].id };
    }
  } catch { /* fall through */ }
  // Migrate the old tab list: one workspace per tab, named after the tmux tail until the snapshot gives a project name.
  let workspaces: Workspace[] = [];
  try {
    const tabs = JSON.parse(localStorage.getItem(OLD_TABS_KEY) || '[]') as Pane[];
    workspaces = tabs.map((t) => ({ id: newId(), name: t.tmux.replace(/^ms-\w+-/, '').slice(0, 8), auto: true, panes: [{ tmux: t.tmux, agent: t.agent, openedAt: t.openedAt }] }));
    localStorage.removeItem(OLD_TABS_KEY);
  } catch { /* none */ }
  if (!workspaces.length) workspaces = [{ id: newId(), name: 'Workspace 1', auto: true, panes: [] }];
  return { workspaces, activeId: workspaces[0].id };
}

export function App() {
  const { snapshot, connected } = useSnapshot();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [{ workspaces, activeId }, setWs] = useState(loadWorkspaces);
  const [focused, setFocused] = useState<string | null>(null);
  const [wsPlace, setWsPlaceState] = useState<'side' | 'top'>(() => (localStorage.getItem(WS_PLACE_KEY) === 'top' ? 'top' : 'side'));
  const [viewPicked, setView] = useState<SidebarView>(() => {
    // The first start with the workspace list opens on it, whatever view was last used.
    if (localStorage.getItem(WS_PLACE_KEY) !== 'top' && !localStorage.getItem(WS_LIST_SHOWN_KEY)) { localStorage.setItem(WS_LIST_SHOWN_KEY, '1'); return 'workspaces'; }
    return (localStorage.getItem(VIEW_KEY) as SidebarView) || 'workspaces';
  });
  const view: SidebarView = wsPlace === 'top' && viewPicked === 'workspaces' ? 'project' : viewPicked;
  const setWsPlace = useCallback((p: 'side' | 'top') => {
    localStorage.setItem(WS_PLACE_KEY, p);
    setWsPlaceState(p);
    if (p === 'side') { setView('workspaces'); setSidebarOpen(true); }
  }, []);
  const [search, setSearch] = useState('');
  const [machine, setMachine] = useState<MachineFilter>(() => localStorage.getItem(FILTER_KEY) ?? ALL);
  const [newOpen, setNewOpen] = useState<{ cwd?: string; agent?: Agent } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== '0');
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0'); }, [sidebarOpen]);
  const [todosOpen, setTodosOpen] = useState(() => localStorage.getItem(TODOS_KEY) === '1');
  const [todoFocus, setTodoFocus] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => { localStorage.setItem(TODOS_KEY, todosOpen ? '1' : '0'); }, [todosOpen]);
  // In Electron the window has no on-screen keyboard to make room for.
  useVisualViewportHeight(!window.multisession);

  // Only the Mac's workspaces live here; a host's come from the host on every start.
  useEffect(() => { localStorage.setItem(WS_KEY, JSON.stringify({ workspaces: workspaces.filter((w) => !wsHost(w)), activeId })); }, [workspaces, activeId]);
  useEffect(() => { localStorage.setItem(VIEW_KEY, viewPicked); }, [viewPicked]);
  useEffect(() => { localStorage.setItem(FILTER_KEY, machine); }, [machine]);
  // A host that was removed in Settings leaves its filter: show everything again.
  const hosts = snapshot?.hosts ?? [];
  const machineShown = machine === ALL || machine === '' || hosts.some((h) => h.name === machine) ? machine : ALL;
  /** The machine whose workspaces are on screen: a host when the filter picks one, else this Mac. */
  const group = machineShown === ALL ? '' : machineShown;
  // Mirror the workspaces to the server: the phone filters by them, and the todo finder reads the ones that have it on.
  const wsMirror = JSON.stringify(workspaces.filter((w) => !wsHost(w)).map((w) => ({ id: w.id, name: w.name, panes: w.panes.map((p) => p.tmux), ...(w.todos ? { todos: true } : {}) })));
  useEffect(() => {
    const t = setTimeout(() => { api.saveWorkspaces(JSON.parse(wsMirror)).catch(() => {}); }, 400);
    return () => clearTimeout(t);
  }, [wsMirror]);

  // First-run setup check: open the doctor when a required tool (or every agent CLI) is missing.
  useEffect(() => {
    api.doctor().then((r) => { setDoctor(r); if (!r.ok) setDoctorOpen(true); }).catch(() => {});
  }, []);

  const sessions = snapshot?.sessions ?? [];
  const byKey = useMemo(() => new Map(sessions.map((s) => [s.key, s])), [sessions]);
  const byTmux = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) if (s.live?.kind === 'tmux') m.set(s.live.tmux, s);
    return m;
  }, [sessions]);

  const groupList = useMemo(() => workspaces.filter((w) => wsHost(w) === group), [workspaces, group]);
  const active: Workspace | undefined = groupList.find((w) => w.id === activeId) ?? groupList[0];
  // The workspace last on screen for each machine, to come back to when the filter picks that machine again.
  const lastActive = useRef<Record<string, string>>((() => { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || '{}'); } catch { return {}; } })());
  useEffect(() => {
    if (!active || lastActive.current[group] === active.id) return;
    lastActive.current = { ...lastActive.current, [group]: active.id };
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(lastActive.current));
  }, [active?.id, group]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Show a machine's workspaces: pick its filter, unless the one picked already shows them. */
  const showMachine = useCallback((host: string) => {
    if (host === group) return;
    setMachine(host || (machine === '' ? '' : ALL));
  }, [group, machine]);
  const todos = snapshot?.todos ?? [];
  const todoCounts = useMemo(() => {
    const m = new Map<string, { proposed: number; open: number }>();
    for (const t of todos) {
      const c = m.get(t.workspace) ?? { proposed: 0, open: 0 };
      // A finish report waits for the user like a proposal does.
      if (t.status === 'proposed' || (t.status === 'accepted' && t.finished && !t.finished.dismissed)) c.proposed++;
      else if (t.status === 'accepted') c.open++;
      m.set(t.workspace, c);
    }
    return m;
  }, [todos]);
  const setWorkspaceTodos = useCallback((id: string, on: boolean) => {
    setWs((cur) => ({ ...cur, workspaces: cur.workspaces.map((w) => (w.id === id ? { ...w, todos: on } : w)) }));
  }, []);
  const findPane = useCallback((tmux: string) => workspaces.find((w) => w.panes.some((p) => p.tmux === tmux)), [workspaces]);

  const updateWs = useCallback((fn: (ws: Workspace[], activeId: string) => { workspaces: Workspace[]; activeId?: string }) => {
    setWs((cur) => {
      const r = fn(cur.workspaces, cur.activeId);
      let list = r.workspaces;
      // The Mac always has a workspace; a host can have none.
      if (!list.some((w) => !wsHost(w))) list = [{ id: newId(), name: 'Workspace 1', auto: true, panes: [] }, ...list];
      const id = r.activeId && list.some((w) => w.id === r.activeId) ? r.activeId : (list.some((w) => w.id === cur.activeId) ? cur.activeId : list[0].id);
      return { workspaces: list, activeId: id };
    });
  }, []);

  /** A session's Todo badge: open the panel on the todo's workspace and flash the todo. */
  const showTodo = useCallback((id: string) => {
    const t = todos.find((x) => x.id === id);
    if (t && workspaces.some((w) => w.id === t.workspace)) { updateWs((ws) => ({ workspaces: ws, activeId: t.workspace })); showMachine(''); }
    setTodosOpen(true);
    setTodoFocus({ id, at: Date.now() });
  }, [todos, workspaces, updateWs, showMachine]);
  // Sessions a shutdown took with it keep their panes until they are resumed (server/sessions.ts trackLost).
  const lostNames = useMemo(() => new Set((snapshot?.lost ?? []).map((l) => l.tmux)), [snapshot?.lost]);
  // Paused panes: the user stopped the process and kept the pane. Each maps to its conversation, when the
  // snapshot still lists it. A session that runs again is live, whatever the list says for a moment.
  const paused = useMemo(() => {
    const m = new Map<string, Session | undefined>();
    for (const l of snapshot?.lost ?? []) {
      if (!l.paused || byTmux.has(l.tmux)) continue;
      const h = splitHost(l.id);
      m.set(l.tmux, byKey.get(h ? onHost(h.host, `${l.agent}:${h.name}`) : `${l.agent}:${l.id}`));
    }
    return m;
  }, [snapshot?.lost, byTmux, byKey]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  /** The workspaces in the order they show, which ⌘1–9 and next/previous follow: the sidebar list puts the fully paused ones last. */
  const shownList = useMemo(() => (wsPlace === 'side' ? listOrder(groupList, paused) : groupList), [wsPlace, groupList, paused]);
  // Follow panes whose tmux session was renamed (a Claude process moved to a new session id after
  // /clear, or a Codex launch learned its thread id), and drop panes whose tmux session is gone.
  useEffect(() => {
    if (!snapshot) return;
    const liveNames = new Set(byTmux.keys());
    const cutoff = Date.now() - 6000;
    let changed = false;
    let focusMoved: string | null | undefined;
    let selectedMoved: string | null | undefined;
    const inPanes = new Set(workspaces.flatMap((w) => w.panes.map((p) => p.tmux)));
    const renamed = snapshot.renamed ?? {};
    const next = workspaces.map((w) => {
      const panes = w.panes.map((p) => {
        if (liveNames.has(p.tmux) || lostNames.has(p.tmux)) return p;
        // The server records every rename it made. Fall back to the one unclaimed live session of the
        // same agent, which covers a rename the server no longer remembers.
        let target = renamed[p.tmux];
        if (!target || !liveNames.has(target) || inPanes.has(target)) {
          const prefix = `${p.tmux.replace(/ms-.*$/, '')}ms-${p.agent}-`;
          const candidates = [...liveNames].filter((n) => !inPanes.has(n) && n.startsWith(prefix));
          target = candidates.length === 1 ? candidates[0] : '';
        }
        if (target) {
          changed = true; inPanes.add(target);
          if (focused === p.tmux) focusMoved = target;
          if (selectedKey && selectedKey === keyOfTmux(p.tmux)) selectedMoved = byTmux.get(target)?.key ?? null;
          return { ...p, tmux: target };
        }
        return p;
      }).filter((p) => {
        const keep = liveNames.has(p.tmux) || lostNames.has(p.tmux) || (p.openedAt ?? 0) > cutoff;
        if (!keep) { changed = true; if (focused === p.tmux) focusMoved = null; }
        return keep;
      });
      // An auto-named workspace takes the project of its first session once the snapshot knows it.
      let name = w.name;
      if (isAutoName(w) && panes[0]) { const s = byTmux.get(panes[0].tmux); if (s && s.project !== name) { name = s.project; changed = true; } }
      return panes === w.panes && name === w.name ? w : { ...w, panes, name, auto: name !== w.name ? true : w.auto, maximized: w.maximized && panes.some((p) => p.tmux === w.maximized) ? w.maximized : null };
    });
    // A workspace the user named stays when its last pane goes; only the user closes it.
    const pruned = next.filter((w) => w.panes.length > 0 || !isAutoName(w) || w.id === activeId || next.length === 1 || w.panes.length === (workspaces.find((x) => x.id === w.id)?.panes.length ?? 0));
    if (pruned.length !== next.length) changed = true;
    if (changed) {
      // Merge into the current list: other effects of this snapshot (a host's workspaces, placements) update it too.
      const before = new Map(workspaces.map((w) => [w.id, w]));
      const edited = new Map(pruned.filter((w) => before.get(w.id) !== w).map((w) => [w.id, w]));
      const dropped = new Set(next.filter((w) => !pruned.includes(w)).map((w) => w.id));
      updateWs((cur) => ({ workspaces: cur.filter((w) => !dropped.has(w.id)).map((w) => edited.get(w.id) ?? w) }));
      if (focusMoved !== undefined) setFocused(focusMoved);
      if (selectedMoved !== undefined) setSelectedKey(selectedMoved);
    }
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resume the lost sessions of the workspace on screen, each once. The others wait until their workspace is opened.
  const resumeAsked = useRef(new Set<string>());
  const [resumeErrors, setResumeErrors] = useState<Record<string, string>>({});
  const resumeLost = useCallback((tmux: string) => {
    resumeAsked.current.add(tmux);
    setResumeErrors(({ [tmux]: _, ...rest }) => rest);
    api.resumeLost(tmux, localStorage.getItem('ms.skipPerms') !== '0')
      .catch((e) => setResumeErrors((cur) => ({ ...cur, [tmux]: (e as Error).message })));
  }, []);
  useEffect(() => {
    const waits = new Set((snapshot?.lost ?? []).filter((l) => l.paused).map((l) => l.tmux));
    for (const p of active?.panes ?? []) if (lostNames.has(p.tmux) && !waits.has(p.tmux) && !resumeAsked.current.has(p.tmux)) resumeLost(p.tmux);
  }, [active, lostNames, resumeLost]); // eslint-disable-line react-hooks/exhaustive-deps

  // A host's workspaces: stored on the host, edited here. `hostSync` holds, per host, the list (as `canon`)
  // known to be on the host. A list from the host that differs from it is a change made elsewhere and
  // replaces ours, unless ours has changes the host has not taken yet; those are written and win.
  const hostSync = useRef(new Map<string, string>());
  useEffect(() => {
    if (!snapshot) return;
    const known = snapshot.hostWorkspaces ?? {};
    const paired = new Set((snapshot.hosts ?? []).map((h) => h.name));
    for (const h of [...hostSync.current.keys()]) if (!paired.has(h)) hostSync.current.delete(h);
    // Decide here, from what is on screen, so the state updates below stay pure.
    const adopt = new Map<string, WorkspaceSummary[]>();
    for (const [h, list] of Object.entries(known)) {
      const theirs = canon(list), last = hostSync.current.get(h), ours = canon(workspaces.filter((w) => wsHost(w) === h).map(summaryOf));
      if (theirs === ours) { hostSync.current.set(h, theirs); continue; }
      if (last !== undefined && (theirs === last || ours !== last)) continue;
      adopt.set(h, list);
      hostSync.current.set(h, theirs);
    }
    const gone = workspaces.some((w) => wsHost(w) && !paired.has(wsHost(w)));
    if (!adopt.size && !gone) return;
    updateWs((ws) => {
      // A host removed in Settings takes its workspaces along.
      let next = ws.filter((w) => !wsHost(w) || paired.has(wsHost(w)));
      for (const [h, list] of adopt) {
        const old = new Map(next.filter((w) => wsHost(w) === h).map((w) => [w.id, w]));
        next = withMachine(next, h, () => list.map((x): Workspace => {
          const o = old.get(x.id);
          const panes = x.panes.map((t) => o?.panes.find((p) => p.tmux === t) ?? { tmux: t, agent: agentOfTmux(t), openedAt: Date.now() });
          return { id: x.id, name: x.name, panes, auto: x.auto, todos: x.todos, cols: x.cols, maximized: o?.maximized && x.panes.includes(o.maximized) ? o.maximized : null };
        }));
      }
      return { workspaces: next };
    });
  }, [snapshot?.hostWorkspaces, snapshot?.hosts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Write a host's workspaces back when they changed here. One write at a time, in order.
  const hostWrites = useRef<Promise<unknown>>(Promise.resolve());
  const onlineHosts = hosts.filter((h) => h.online).map((h) => h.name);
  const hostState = JSON.stringify(Object.keys(snapshot?.hostWorkspaces ?? {}).map((h) => [h, onlineHosts.includes(h), canon(workspaces.filter((w) => wsHost(w) === h).map(summaryOf))]));
  useEffect(() => {
    const t = setTimeout(() => {
      for (const h of Object.keys(snapshot?.hostWorkspaces ?? {})) {
        const list = workspaces.filter((w) => wsHost(w) === h).map(summaryOf);
        const c = canon(list);
        const last = hostSync.current.get(h);
        if (last === undefined || c === last || !onlineHosts.includes(h)) continue;
        hostWrites.current = hostWrites.current
          .then(() => api.saveHostWorkspaces(h, list))
          .then(() => { hostSync.current.set(h, c); }, (e) => setError(`The workspaces on ${h} were not saved: ${(e as Error).message}`));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [hostState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sessions started on the phone (or by an agent) join a workspace here, without taking focus or switching
  // workspace. A host's placements join the host's workspaces; an agent joins its parent's, on either machine.
  useEffect(() => {
    const ready = (snapshot?.placements ?? []).filter((p) => byTmux.has(p.tmux));
    if (!ready.length) return;
    updateWs((ws) => {
      let next = ws;
      for (const p of ready) {
        if (next.some((w) => w.panes.some((x) => x.tmux === p.tmux))) continue;
        const own = next.filter((w) => wsHost(w) === (p.host ?? ''));
        const id = (p.after && next.find((w) => w.panes.some((x) => x.tmux === p.after))?.id)
          || placementTarget(p, own.map((w) => ({ id: w.id, name: w.name, panes: w.panes.map((x) => x.tmux) })), (t) => byTmux.get(t)?.cwd);
        if (!id) continue;
        const pane = { tmux: p.tmux, agent: byTmux.get(p.tmux)!.agent, openedAt: Date.now() };
        // An agent goes after its parent and the parent's earlier agents; anything else at the end.
        const near = (w: Workspace) => p.after ? w.panes.reduce((at, x, i) => (x.tmux === p.after || byTmux.get(x.tmux)?.spawn?.parentTmux === p.after ? i : at), -1) : -1;
        next = next.map((w) => {
          if (w.id !== id) return w;
          const i = near(w);
          return { ...w, panes: i < 0 ? [...w.panes, pane] : [...w.panes.slice(0, i + 1), pane, ...w.panes.slice(i + 1)] };
        });
      }
      return { workspaces: next };
    });
    for (const p of ready) api.clearPlacement(p.tmux).catch(() => {});
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Workspace changes made on the phone, in the order they were made. A move waits until its session runs.
  // The Mac's queue changes the Mac's workspaces; a host's queue (ids under `@host:`) changes the host's.
  useEffect(() => {
    const ready = [...(snapshot?.workspaceOps ?? []), ...(snapshot?.hostWorkspaceOps ?? [])].filter((op) => op.op !== 'move' || byTmux.has(op.tmux));
    if (!ready.length) return;
    // A workspace closed on the phone: its paused panes have no process to keep, so drop the server's note of them.
    for (const op of ready) {
      if (op.op !== 'close') continue;
      for (const p of workspaces.find((w) => w.id === op.workspace)?.panes ?? []) if (pausedRef.current.has(p.tmux)) api.kill(p.tmux).catch(() => {});
    }
    updateWs((ws) => {
      let next = ws;
      for (const op of ready) {
        // The machine of the workspace the change names: a phone on the Mac can change a host's workspace too.
        const target = op.op === 'move' ? op.to ?? op.tmux : op.workspace;
        const host = splitHost(target)?.host ?? splitHost(op.id)?.host ?? '';
        next = withMachine(next, host, (mine) => {
          let list = applyWorkspaceOp<Pane, Workspace>(mine, op, {
            tmuxOf: (p) => p.tmux,
            pane: (tmux) => { const s = byTmux.get(tmux); return s && (!host || tmuxHost(tmux) === host) ? { tmux, agent: s.agent, openedAt: Date.now() } : null; },
            create: (id, name) => ({ id, name, auto: false, panes: [] }),
          });
          // A name given on the phone is the user's, so the first session's project must not replace it.
          if (op.op === 'rename') list = list.map((w) => (w.id === op.workspace ? { ...w, auto: false } : w));
          return list;
        });
      }
      return { workspaces: next };
    });
    for (const op of ready) api.clearWorkspaceOp(op.id).catch(() => {});
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;

  /**
   * Show a live tmux session in a pane, adding it to the active workspace if it is not open anywhere.
   * The Mac's workspaces take any session; a host's only the host's own, so a session from elsewhere
   * goes to its machine's last workspace (a new one if it has none) and the filter follows it.
   */
  const openTerminal = useCallback((tmux: string, agent: Agent, key?: string) => {
    const home = findPane(tmux);
    if (home) { updateWs((ws) => ({ workspaces: ws, activeId: home.id })); showMachine(wsHost(home)); }
    else {
      const host = group === '' ? '' : tmuxHost(tmux);
      const target = host === group ? active
        : workspaces.find((w) => w.id === lastActive.current[host] && wsHost(w) === host) ?? workspaces.find((w) => wsHost(w) === host);
      const known = byTmux.get(tmux);
      const pane = { tmux, agent, openedAt: Date.now() };
      if (target) updateWs((ws) => ({ activeId: target.id, workspaces: ws.map((w) => {
        if (w.id !== target.id) return w;
        const name = w.panes.length === 0 && isAutoName(w) && known ? known.project : w.name;
        return { ...w, name, panes: [...w.panes, pane], maximized: null };
      }) }));
      else {
        const id = host ? onHost(host, newId()) : newId();
        updateWs((ws) => ({ activeId: id, workspaces: [...ws, { id, name: known?.project ?? 'Workspace 1', auto: true, panes: [pane] }] }));
      }
      showMachine(host);
    }
    setFocused(tmux);
    if (key) setSelectedKey(key);
    else { const s = byTmux.get(tmux); if (s) setSelectedKey(s.key); }
  }, [byTmux, findPane, updateWs, showMachine, group, active, workspaces]);

  /** Bring a pane on screen, running or paused: its workspace, the focus, and the selection that goes with it. */
  const focusPane = useCallback((tmux: string) => {
    const home = findPane(tmux);
    if (!home) return;
    updateWs((ws) => ({ workspaces: ws, activeId: home.id }));
    showMachine(wsHost(home));
    setFocused(tmux);
    setSelectedKey(byTmux.get(tmux)?.key ?? null);
  }, [findPane, updateWs, showMachine, byTmux]);

  const select = useCallback((s: Session) => {
    // A paused session has a pane: show that, with its Resume button, rather than the transcript.
    const pausedAt = s.live ? undefined : [...paused].find(([t, x]) => x?.key === s.key && findPane(t))?.[0];
    if (pausedAt) { focusPane(pausedAt); return; }
    setSelectedKey(s.key);
    if (s.live?.kind === 'tmux') openTerminal(s.live.tmux, s.agent, s.key);
    else setFocused(null);
  }, [openTerminal, paused, findPane, focusPane]);

  /** Move a pane to another workspace of the same machine, at the end. */
  const movePane = useCallback((tmux: string, to: string) => {
    updateWs((ws, id) => {
      const from = ws.find((w) => w.panes.some((p) => p.tmux === tmux)), target = ws.find((w) => w.id === to);
      if (!from || !target || from === target || wsHost(from) !== wsHost(target)) return { workspaces: ws };
      const pane = from.panes.find((p) => p.tmux === tmux)!;
      const list = ws.map((w) => (w === from ? { ...w, panes: w.panes.filter((p) => p.tmux !== tmux), maximized: w.maximized === tmux ? null : w.maximized }
        : w === target ? { ...w, panes: [...w.panes, pane], maximized: null } : w))
        // As when a pane is removed: a workspace the user never named goes with its last pane.
        .filter((w) => !(w.id === from.id && w.panes.length === 0 && isAutoName(w)));
      return { workspaces: list, activeId: list.some((w) => w.id === id) ? id : to };
    });
  }, [updateWs]);

  /** Put a workspace where another one of its machine is. */
  const reorderWorkspace = useCallback((id: string, at: string) => {
    updateWs((ws) => {
      const w = ws.find((x) => x.id === id);
      if (!w) return { workspaces: ws };
      return { workspaces: withMachine(ws, wsHost(w), (mine) => {
        const i = mine.findIndex((x) => x.id === id), j = mine.findIndex((x) => x.id === at);
        if (i < 0 || j < 0 || i === j) return mine;
        const next = [...mine];
        next.splice(j, 0, next.splice(i, 1)[0]);
        return next;
      }) };
    });
  }, [updateWs]);

  const removePane = useCallback((tmux: string) => {
    // A paused pane has no process; removing it also drops the server's note of it.
    if (pausedRef.current.has(tmux)) api.kill(tmux).catch(() => {});
    // The pane that inherits focus and selection: the next one in the same workspace, else the previous.
    const home = workspaces.find((w) => w.panes.some((p) => p.tmux === tmux));
    let heir: string | null = null;
    if (home) {
      const i = home.panes.findIndex((p) => p.tmux === tmux);
      const rest = home.panes.filter((p) => p.tmux !== tmux);
      heir = rest[Math.min(i, rest.length - 1)]?.tmux ?? null;
    }
    updateWs((ws, id) => {
      const list = ws.map((w) => (w.panes.some((p) => p.tmux === tmux) ? { ...w, panes: w.panes.filter((p) => p.tmux !== tmux), maximized: w.maximized === tmux ? null : w.maximized } : w));
      // Auto-delete a workspace that just lost its last pane, unless the user named it or it is the only one of its machine.
      const emptied = list.filter((w) => w.panes.length === 0 && isAutoName(w) && ws.find((x) => x.id === w.id)!.panes.length > 0 && list.filter((x) => wsHost(x) === wsHost(w)).length > 1);
      const kept = list.filter((w) => !emptied.includes(w));
      return { workspaces: kept, activeId: kept.some((w) => w.id === id) ? id : kept[0]?.id };
    });
    setFocused((f) => (f === tmux ? heir : f));
    // Never leave the removed session selected: once the snapshot marks it ended, a selected
    // non-live session switches the whole window to its transcript with a Resume button.
    setSelectedKey((k) => {
      const cur = k ? byKey.get(k) : undefined;
      if (cur && cur.live?.kind === 'tmux' && cur.live.tmux !== tmux) return k;
      const s = heir ? byTmux.get(heir) : undefined;
      return s ? s.key : null;
    });
  }, [updateWs, workspaces, byKey, byTmux]);

  const killPane = useCallback(async (tmux: string) => {
    // Drop the pane first so the grid reflows immediately; the kill itself can take a moment.
    removePane(tmux);
    try { await api.kill(tmux); } catch (e) { setError((e as Error).message); }
  }, [removePane]);

  /** Stop the processes of these panes and keep the panes (server pauseTmux). */
  const pausePanes = useCallback(async (names: string[]) => {
    const keys = new Set(names.map((t) => byTmux.get(t)?.key));
    // A selected session that is not live switches the window to its transcript; a paused pane must not.
    setSelectedKey((k) => (k && keys.has(k) ? null : k));
    const failed: string[] = [];
    await Promise.all(names.map((t) => api.pause(t).catch((e) => { failed.push((e as Error).message); })));
    if (failed.length) setError(names.length === 1 ? failed[0] : `${failed.length} of ${names.length} sessions were not paused: ${failed[0]}`);
  }, [byTmux]);

  const swapPanes = useCallback((a: string, b: string) => {
    updateWs((ws) => ({ workspaces: ws.map((w) => {
      const ia = w.panes.findIndex((p) => p.tmux === a), ib = w.panes.findIndex((p) => p.tmux === b);
      if (ia < 0 || ib < 0) return w;
      const panes = [...w.panes]; [panes[ia], panes[ib]] = [panes[ib], panes[ia]];
      return { ...w, panes };
    }) }));
  }, [updateWs]);

  const setMaximized = useCallback((tmux: string | null) => {
    updateWs((ws, id) => ({ workspaces: ws.map((w) => (w.id === id ? { ...w, maximized: tmux } : w)) }));
    if (tmux) setFocused(tmux);
  }, [updateWs]);

  const renameWorkspace = useCallback((id: string, name: string) => {
    updateWs((ws) => ({ workspaces: ws.map((w) => (w.id === id ? { ...w, name, auto: false } : w)) }));
  }, [updateWs]);

  /** A new workspace on the machine on screen. */
  const createWorkspace = useCallback(() => {
    const id = group ? onHost(group, newId()) : newId();
    updateWs((ws) => ({ workspaces: [...ws, { id, name: `Workspace ${ws.filter((w) => wsHost(w) === group).length + 1}`, auto: true, panes: [] }], activeId: id }));
    setFocused(null); setSelectedKey(null);
  }, [updateWs, group]);

  const closeWorkspace = useCallback((id: string) => {
    // Its paused panes have no process to keep running: drop the server's note of them.
    for (const p of workspaces.find((x) => x.id === id)?.panes ?? []) if (pausedRef.current.has(p.tmux)) api.kill(p.tmux).catch(() => {});
    updateWs((ws, cur) => {
      const w = ws.find((x) => x.id === id);
      if (!w) return { workspaces: ws };
      const same = ws.filter((x) => wsHost(x) === wsHost(w));
      const i = same.indexOf(w);
      return { workspaces: ws.filter((x) => x.id !== id), activeId: cur === id ? (same[i - 1] ?? same[i + 1])?.id : cur };
    });
  }, [updateWs, workspaces]);

  const activateWorkspace = useCallback((id: string) => {
    updateWs((ws) => ({ workspaces: ws, activeId: id }));
    const w = workspaces.find((x) => x.id === id);
    if (w) showMachine(wsHost(w));
    const first = w?.panes[0]?.tmux ?? null;
    const keep = w?.panes.some((p) => p.tmux === focused) ? focused : first;
    setFocused(keep);
    const s = keep ? byTmux.get(keep) : undefined;
    setSelectedKey(s ? s.key : null);
  }, [updateWs, workspaces, focused, byTmux, showMachine]);

  /** The machine filter: it also brings that machine's workspaces on screen, at the one last shown. */
  const pickMachine = useCallback((m: MachineFilter) => {
    const host = m === ALL ? '' : m;
    const mine = workspaces.filter((w) => wsHost(w) === host);
    const w = mine.find((x) => x.id === lastActive.current[host]) ?? mine[0];
    if (w) activateWorkspace(w.id);
    else { setFocused(null); setSelectedKey(null); }
    // After activateWorkspace, which can pick a filter of its own: this one is what the user asked for.
    setMachine(m);
  }, [workspaces, activateWorkspace]);

  const resume = useCallback(async (s: Session, fork = false) => {
    try {
      const r = await api.resume(s.agent, s.id, { fork });
      openTerminal(r.tmux, s.agent, fork ? undefined : s.key);
    } catch (e) { setError((e as Error).message); }
  }, [openTerminal]);

  const launch = useCallback(async (body: LaunchBody) => {
    const r = await api.launch(body);
    setNewOpen(null);
    openTerminal(r.tmux, body.agent, r.key);
  }, [openTerminal]);

  const moveFocus = useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
    const panes = active?.panes ?? [];
    if (!panes.length) return;
    const i = Math.max(0, panes.findIndex((p) => p.tmux === focused));
    const cols = active.maximized ? 1 : gridColumns(panes.length, active.cols);
    let j = i;
    if (dir === 'left') j = i - 1; else if (dir === 'right') j = i + 1; else if (dir === 'up') j = i - cols; else j = i + cols;
    if (j < 0 || j >= panes.length) return;
    setFocused(panes[j].tmux);
    const s = byTmux.get(panes[j].tmux); if (s) setSelectedKey(s.key);
  }, [active, focused, byTmux]);

  // Cmd+D: a fresh session in the same folder and with the same agent as the focused pane, beside it.
  const duplicate = useCallback(async () => {
    // Fall back to another pane of the active workspace: focus is not restored after a reload, and a pane
    // launched a moment ago has no session yet.
    const src = (focused && byTmux.get(focused)) || active?.panes.map((p) => byTmux.get(p.tmux) ?? paused.get(p.tmux)).find(Boolean) || selected;
    if (!src) { setNewOpen({}); return; }
    try { await launch({ agent: src.agent, cwd: src.cwd, skipPermissions: localStorage.getItem('ms.skipPerms') !== '0' }); }
    catch (e) { setError((e as Error).message); }
  }, [focused, active, byTmux, paused, selected, launch]);

  // Keyboard shortcuts (also forwarded from the Electron menu).
  useEffect(() => {
    const run = (cmd: string) => {
      if (cmd === 'new') setNewOpen({ cwd: selected?.cwd });
      else if (cmd === 'search') { setSidebarOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (cmd === 'toggle-sidebar') setSidebarOpen((v) => !v);
      else if (cmd === 'duplicate') duplicate();
      else if (cmd === 'close-pane' && focused) removePane(focused);
      else if (cmd === 'maximize' && focused) setMaximized(active?.maximized === focused ? null : focused);
      else if (cmd === 'new-workspace') createWorkspace();
      else if (cmd === 'rename-workspace') setRenaming(active?.id ?? null);
      else if (cmd === 'settings') setSettingsOpen((v) => !v);
      else if (cmd === 'todos') setTodosOpen((v) => !v);
      else if (cmd === 'doctor') setDoctorOpen(true);
      else if (cmd.startsWith('workspace:')) { const w = shownList[Number(cmd.slice(10)) - 1]; if (w) activateWorkspace(w.id); }
      else if (cmd === 'next-workspace' || cmd === 'prev-workspace') {
        if (shownList.length < 2) return;
        const i = shownList.findIndex((w) => w.id === active?.id);
        activateWorkspace(shownList[(i + (cmd === 'next-workspace' ? 1 : shownList.length - 1)) % shownList.length].id);
      }
      else if (cmd.startsWith('focus:')) moveFocus(cmd.slice(6) as any);
    };
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) {
        if (e.key === 'Escape') {
          setNewOpen(null); setSettingsOpen(false); setDoctorOpen(false);
          // Restore the grid without letting ESC reach the agent (Claude treats ESC as interrupt).
          if (active?.maximized && !newOpen && !settingsOpen && !doctorOpen) { e.preventDefault(); e.stopPropagation(); setMaximized(null); }
        }
        return;
      }
      if (e.altKey && e.key.startsWith('Arrow')) { e.preventDefault(); run(`focus:${e.key.slice(5).toLowerCase()}`); }
      else if (e.key === 'n') { e.preventDefault(); run('new'); }
      else if (e.key === 'b') { e.preventDefault(); run('toggle-sidebar'); }
      else if (e.key === 'd' && !e.shiftKey) { e.preventDefault(); run('duplicate'); }
      else if (e.key === 'k' || e.key === 'p') { e.preventDefault(); run('search'); }
      else if (e.key === ',') { e.preventDefault(); run('settings'); }
      else if (e.key === 't' && e.shiftKey) { e.preventDefault(); run('todos'); }
      else if (e.key === 't') { e.preventDefault(); run('new-workspace'); }
      else if (e.key === 'r' && e.shiftKey) { e.preventDefault(); run('rename-workspace'); }
      else if (e.key === 'w') { e.preventDefault(); run('close-pane'); }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); run('maximize'); }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); run(`workspace:${e.key}`); }
      else if (e.key === ']' && e.shiftKey) { e.preventDefault(); run('next-workspace'); }
      else if (e.key === '[' && e.shiftKey) { e.preventDefault(); run('prev-workspace'); }
    };
    window.addEventListener('keydown', onKey, true);
    const off = window.multisession?.onCommand(run);
    return () => { window.removeEventListener('keydown', onKey, true); off?.(); };
  }, [selected, focused, active, shownList, newOpen, settingsOpen, doctorOpen, removePane, setMaximized, createWorkspace, activateWorkspace, moveFocus, duplicate]);

  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(null), 6000); return () => clearTimeout(t); }, [error]);

  // Transcript mode: an idle (or external) session is selected. The grid stays mounted underneath.
  const transcriptMode = !!selected && selected.live?.kind !== 'tmux';
  const showEmpty = !transcriptMode && (active?.panes.length ?? 0) === 0 && groupList.length <= 1;

  // What is on screen counts as read: the transcript, or the panes of the active workspace (only the maximized one).
  const present = usePresent(true);
  const onScreen = transcriptMode ? [selected!.key] : (active?.maximized ? [active.maximized] : active?.panes.map((p) => p.tmux) ?? []).flatMap((t) => byTmux.get(t)?.key ?? []);
  useViewing(onScreen, present);

  // With the workspace list on screen the name is edited there; the bar above the grid edits it otherwise.
  const listShown = wsPlace === 'side' && sidebarOpen && view === 'workspaces' && !search.trim();

  return (
    <div className="app">
      <StatusStrip sessions={sessions.filter((s) => inMachine(machineShown, s))} hosts={hosts} connected={connected} onPick={select} activeKey={selectedKey}
        sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div className="body">
        {sidebarOpen && <Sidebar
          workspaces={wsPlace === 'side' ? (
            <WorkspaceList workspaces={groupList} activeId={active?.id ?? ''} byTmux={byTmux} paused={paused} lost={lostNames} focused={transcriptMode ? null : focused}
              editing={renaming} setEditing={setRenaming} todoCounts={todoCounts}
              onActivate={activateWorkspace} onCreate={createWorkspace} onClose={closeWorkspace}
              onRename={renameWorkspace} onFocusPane={focusPane} onMovePane={movePane} onReorder={reorderWorkspace} />
          ) : undefined}
          snapshot={snapshot}
          machine={machineShown}
          onMachine={pickMachine}
          view={view}
          onView={setView}
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
          selectedKey={selectedKey}
          onSelect={select}
          onNew={(cwd, agent) => setNewOpen({ cwd, agent })}
          onSettings={() => setSettingsOpen(true)}
        />}
        <main className="main">
          {(groupList.length > 1 || (active?.panes.length ?? 0) > 0) && (
            <WorkspaceBar tabs={wsPlace === 'top'} workspaces={groupList} activeId={active?.id ?? ''} byTmux={byTmux} paused={paused} todosAvailable={!group}
              onPause={(id) => pausePanes((workspaces.find((w) => w.id === id)?.panes ?? []).map((p) => p.tmux).filter((t) => byTmux.has(t)))}
              onResumeAll={(id) => { for (const p of workspaces.find((w) => w.id === id)?.panes ?? []) if (paused.has(p.tmux)) resumeLost(p.tmux); }}
              onActivate={activateWorkspace} onCreate={createWorkspace} onClose={closeWorkspace}
              editing={listShown ? null : renaming} setEditing={setRenaming}
              todoCounts={todoCounts} todosOpen={todosOpen} onTodos={() => setTodosOpen((v) => !v)}
              onLayout={(id, cols) => updateWs((ws) => ({ workspaces: ws.map((w) => (w.id === id ? { ...w, cols } : w)) }))}
              onRename={renameWorkspace} />
          )}
          <div className="stage-row">
          <div className="stage">
            {workspaces.map((w) => (
              <PaneGrid key={w.id} workspace={w} byTmux={byTmux} lost={lostNames} paused={paused} onPause={(tmux) => pausePanes([tmux])} resumeErrors={resumeErrors} onResumeLost={resumeLost} focused={focused} visible={!transcriptMode && w.id === active?.id}
                onFocus={(tmux) => { setFocused(tmux); const s = byTmux.get(tmux); if (s) setSelectedKey(s.key); }}
                onSwap={swapPanes} onMaximize={setMaximized} onRemove={removePane} onKill={killPane} onAdd={duplicate} onTodo={showTodo} />
            ))}
            {transcriptMode && selected && (
              <div className="transcript-view">
                <SessionHeader session={selected} onResume={() => resume(selected)} onFork={() => resume(selected, true)} onTodo={showTodo} />
                <Transcript key={selected.key} session={selected} />
              </div>
            )}
            {showEmpty && (
              <div className="empty">
                <div className="empty-inner">
                  <h1>{group ? `Nothing open on ${group}` : 'Nothing open'}</h1>
                  <p>Pick a session on the left, or start one.</p>
                  <button className="btn primary" onClick={() => setNewOpen(group ? { cwd: `@${group}:~` } : {})}>New session <kbd>⌘N</kbd></button>
                </div>
              </div>
            )}
          </div>
          {todosOpen && active && !group && (
            <TodoPanel workspace={active} todos={todos.filter((t) => t.workspace === active.id)}
              scan={snapshot?.todoScans?.find((s) => s.workspace === active.id)} byKey={byKey} byTmux={byTmux} focus={todoFocus}
              onToggle={(on) => setWorkspaceTodos(active.id, on)} onOpenSession={select} onClose={() => setTodosOpen(false)}
              onStart={async (t) => {
                const r = await api.startTodo(t.id, localStorage.getItem('ms.skipPerms') !== '0');
                openTerminal(r.tmux, 'claude', r.key);
              }} />
          )}
          </div>
        </main>
      </div>
      {newOpen && <NewSession preset={newOpen} projects={snapshot?.projects ?? []} hosts={snapshot?.hosts} onClose={() => setNewOpen(null)} onLaunch={launch} />}
      {settingsOpen && <SettingsPanel wsPlace={wsPlace} onWsPlace={setWsPlace} onClose={() => setSettingsOpen(false)} onDoctor={() => { setSettingsOpen(false); setDoctorOpen(true); }} />}
      {doctorOpen && <Doctor initial={doctor} onClose={() => setDoctorOpen(false)} />}
      {error && <div className="toast" role="alert">{error}</div>}
    </div>
  );
}
