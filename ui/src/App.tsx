import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Agent } from '../../shared/types';
import { api, useSnapshot } from './api';
import { StatusStrip } from './components/StatusStrip';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import { SessionHeader } from './components/SessionHeader';
import { NewSession } from './components/NewSession';
import { SettingsPanel } from './components/SettingsPanel';
import { WorkspaceBar, isAutoName, PaneGrid, gridColumns, type Workspace, type Pane } from './components/Workspace';

declare global {
  interface Window { multisession?: { onCommand: (cb: (cmd: string) => void) => () => void } }
}

const WS_KEY = 'ms.workspaces';
const OLD_TABS_KEY = 'ms.tabs';
const VIEW_KEY = 'ms.view';
const SIDEBAR_KEY = 'ms.sidebar';

const newId = () => Math.random().toString(36).slice(2, 10);

function loadWorkspaces(): { workspaces: Workspace[]; activeId: string } {
  try {
    const raw = localStorage.getItem(WS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (Array.isArray(j.workspaces) && j.workspaces.length) return { workspaces: j.workspaces, activeId: j.activeId || j.workspaces[0].id };
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
  const [view, setView] = useState<'project' | 'recent'>(() => (localStorage.getItem(VIEW_KEY) as any) || 'project');
  const [search, setSearch] = useState('');
  const [newOpen, setNewOpen] = useState<{ cwd?: string; agent?: Agent } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== '0');
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0'); }, [sidebarOpen]);

  useEffect(() => { localStorage.setItem(WS_KEY, JSON.stringify({ workspaces, activeId })); }, [workspaces, activeId]);
  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);

  const sessions = snapshot?.sessions ?? [];
  const byKey = useMemo(() => new Map(sessions.map((s) => [s.key, s])), [sessions]);
  const byTmux = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) if (s.live?.kind === 'tmux') m.set(s.live.tmux, s);
    return m;
  }, [sessions]);

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  const findPane = useCallback((tmux: string) => workspaces.find((w) => w.panes.some((p) => p.tmux === tmux)), [workspaces]);

  const updateWs = useCallback((fn: (ws: Workspace[], activeId: string) => { workspaces: Workspace[]; activeId?: string }) => {
    setWs((cur) => {
      const r = fn(cur.workspaces, cur.activeId);
      let list = r.workspaces;
      if (!list.length) list = [{ id: newId(), name: 'Workspace 1', auto: true, panes: [] }];
      const id = r.activeId && list.some((w) => w.id === r.activeId) ? r.activeId : (list.some((w) => w.id === cur.activeId) ? cur.activeId : list[0].id);
      return { workspaces: list, activeId: id };
    });
  }, []);

  // Reconcile after a Codex launch gets renamed to its real thread id, and drop panes whose tmux session is gone.
  useEffect(() => {
    if (!snapshot) return;
    const liveNames = new Set(byTmux.keys());
    const cutoff = Date.now() - 6000;
    let changed = false;
    let focusMoved: string | null | undefined;
    const inPanes = new Set(workspaces.flatMap((w) => w.panes.map((p) => p.tmux)));
    const next = workspaces.map((w) => {
      const panes = w.panes.map((p) => {
        if (liveNames.has(p.tmux)) return p;
        const candidates = [...liveNames].filter((n) => !inPanes.has(n) && n.startsWith(`ms-${p.agent}-`));
        // The pane was renamed (Codex id resolved, or a Claude process moved to a new session id).
        if (candidates.length === 1) {
          changed = true; inPanes.add(candidates[0]);
          if (focused === p.tmux) focusMoved = candidates[0];
          return { ...p, tmux: candidates[0] };
        }
        return p;
      }).filter((p) => {
        const keep = liveNames.has(p.tmux) || (p.openedAt ?? 0) > cutoff;
        if (!keep) { changed = true; if (focused === p.tmux) focusMoved = null; }
        return keep;
      });
      // An auto-named workspace takes the project of its first session once the snapshot knows it.
      let name = w.name;
      if (isAutoName(w) && panes[0]) { const s = byTmux.get(panes[0].tmux); if (s && s.project !== name) { name = s.project; changed = true; } }
      return panes === w.panes && name === w.name ? w : { ...w, panes, name, auto: name !== w.name ? true : w.auto, maximized: w.maximized && panes.some((p) => p.tmux === w.maximized) ? w.maximized : null };
    });
    const pruned = next.filter((w) => w.panes.length > 0 || w.id === activeId || next.length === 1 || w.panes.length === (workspaces.find((x) => x.id === w.id)?.panes.length ?? 0));
    if (pruned.length !== next.length) changed = true;
    if (changed) {
      updateWs(() => ({ workspaces: pruned }));
      if (focusMoved !== undefined) setFocused(focusMoved);
    }
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;

  /** Show a live tmux session in a pane, adding it to the active workspace if it is not open anywhere. */
  const openTerminal = useCallback((tmux: string, agent: Agent, key?: string) => {
    const home = findPane(tmux);
    if (home) updateWs((ws) => ({ workspaces: ws, activeId: home.id }));
    else updateWs((ws, id) => ({ workspaces: ws.map((w) => {
      if (w.id !== id) return w;
      const known = byTmux.get(tmux);
      const name = w.panes.length === 0 && isAutoName(w) && known ? known.project : w.name;
      return { ...w, name, panes: [...w.panes, { tmux, agent, openedAt: Date.now() }], maximized: null };
    }) }));
    setFocused(tmux);
    if (key) setSelectedKey(key);
    else { const s = byTmux.get(tmux); if (s) setSelectedKey(s.key); }
  }, [byTmux, findPane, updateWs]);

  const select = useCallback((s: Session) => {
    setSelectedKey(s.key);
    if (s.live?.kind === 'tmux') openTerminal(s.live.tmux, s.agent, s.key);
    else setFocused(null);
  }, [openTerminal]);

  const removePane = useCallback((tmux: string) => {
    updateWs((ws, id) => {
      const list = ws.map((w) => (w.panes.some((p) => p.tmux === tmux) ? { ...w, panes: w.panes.filter((p) => p.tmux !== tmux), maximized: w.maximized === tmux ? null : w.maximized } : w));
      // Auto-delete a workspace that just lost its last pane, unless it is the only one.
      const emptied = list.filter((w) => w.panes.length === 0 && ws.find((x) => x.id === w.id)!.panes.length > 0);
      const kept = list.length > 1 ? list.filter((w) => !emptied.includes(w)) : list;
      return { workspaces: kept, activeId: kept.some((w) => w.id === id) ? id : kept[0]?.id };
    });
    setFocused((f) => (f === tmux ? null : f));
  }, [updateWs]);

  const killPane = useCallback(async (tmux: string) => {
    try { await api.kill(tmux); } catch (e) { setError((e as Error).message); }
    removePane(tmux);
  }, [removePane]);

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

  const createWorkspace = useCallback(() => {
    const id = newId();
    updateWs((ws) => ({ workspaces: [...ws, { id, name: `Workspace ${ws.length + 1}`, auto: true, panes: [] }], activeId: id }));
    setFocused(null); setSelectedKey(null);
  }, [updateWs]);

  const closeWorkspace = useCallback((id: string) => {
    updateWs((ws, cur) => {
      const idx = ws.findIndex((w) => w.id === id);
      const list = ws.filter((w) => w.id !== id);
      return { workspaces: list, activeId: cur === id ? list[Math.max(0, idx - 1)]?.id : cur };
    });
  }, [updateWs]);

  const activateWorkspace = useCallback((id: string) => {
    updateWs((ws) => ({ workspaces: ws, activeId: id }));
    const w = workspaces.find((x) => x.id === id);
    const first = w?.panes[0]?.tmux ?? null;
    const keep = w?.panes.some((p) => p.tmux === focused) ? focused : first;
    setFocused(keep);
    const s = keep ? byTmux.get(keep) : undefined;
    setSelectedKey(s ? s.key : null);
  }, [updateWs, workspaces, focused, byTmux]);

  const resume = useCallback(async (s: Session, fork = false) => {
    try {
      const r = await api.resume(s.agent, s.id, { fork });
      openTerminal(r.tmux, s.agent, fork ? undefined : s.key);
    } catch (e) { setError((e as Error).message); }
  }, [openTerminal]);

  const launch = useCallback(async (body: { agent: Agent; cwd: string; prompt?: string; skipPermissions?: boolean }) => {
    const r = await api.launch(body);
    setNewOpen(null);
    openTerminal(r.tmux, body.agent, r.key);
  }, [openTerminal]);

  const moveFocus = useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
    const panes = active?.panes ?? [];
    if (!panes.length) return;
    const i = Math.max(0, panes.findIndex((p) => p.tmux === focused));
    const cols = active.maximized ? 1 : gridColumns(panes.length);
    let j = i;
    if (dir === 'left') j = i - 1; else if (dir === 'right') j = i + 1; else if (dir === 'up') j = i - cols; else j = i + cols;
    if (j < 0 || j >= panes.length) return;
    setFocused(panes[j].tmux);
    const s = byTmux.get(panes[j].tmux); if (s) setSelectedKey(s.key);
  }, [active, focused, byTmux]);

  // Cmd+D: a fresh session in the same folder and with the same agent as the focused pane, beside it.
  const duplicate = useCallback(async () => {
    // Fall back to the first pane of the active workspace, since focus is not restored after a reload.
    const paneTmux = focused ?? active?.panes[0]?.tmux;
    const src = (paneTmux && byTmux.get(paneTmux)) || selected;
    if (!src) { setNewOpen({}); return; }
    try { await launch({ agent: src.agent, cwd: src.cwd, skipPermissions: localStorage.getItem('ms.skipPerms') !== '0' }); }
    catch (e) { setError((e as Error).message); }
  }, [focused, active, byTmux, selected, launch]);

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
      else if (cmd === 'rename-workspace') setRenaming(activeId);
      else if (cmd === 'settings') setSettingsOpen((v) => !v);
      else if (cmd.startsWith('workspace:')) { const w = workspaces[Number(cmd.slice(10)) - 1]; if (w) activateWorkspace(w.id); }
      else if (cmd === 'next-workspace' || cmd === 'prev-workspace') {
        if (workspaces.length < 2) return;
        const i = workspaces.findIndex((w) => w.id === activeId);
        activateWorkspace(workspaces[(i + (cmd === 'next-workspace' ? 1 : workspaces.length - 1)) % workspaces.length].id);
      }
      else if (cmd.startsWith('focus:')) moveFocus(cmd.slice(6) as any);
    };
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) {
        if (e.key === 'Escape') {
          setNewOpen(null); setSettingsOpen(false);
          // Restore the grid without letting ESC reach the agent (Claude treats ESC as interrupt).
          if (active?.maximized && !newOpen && !settingsOpen) { e.preventDefault(); e.stopPropagation(); setMaximized(null); }
        }
        return;
      }
      if (e.altKey && e.key.startsWith('Arrow')) { e.preventDefault(); run(`focus:${e.key.slice(5).toLowerCase()}`); }
      else if (e.key === 'n') { e.preventDefault(); run('new'); }
      else if (e.key === 'b') { e.preventDefault(); run('toggle-sidebar'); }
      else if (e.key === 'd' && !e.shiftKey) { e.preventDefault(); run('duplicate'); }
      else if (e.key === 'k' || e.key === 'p') { e.preventDefault(); run('search'); }
      else if (e.key === ',') { e.preventDefault(); run('settings'); }
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
  }, [selected, focused, active, workspaces, activeId, newOpen, settingsOpen, removePane, setMaximized, createWorkspace, activateWorkspace, moveFocus, duplicate]);

  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(null), 6000); return () => clearTimeout(t); }, [error]);

  // Transcript mode: an idle (or external) session is selected. The grid stays mounted underneath.
  const transcriptMode = !!selected && selected.live?.kind !== 'tmux';
  const showEmpty = !transcriptMode && (active?.panes.length ?? 0) === 0 && workspaces.length === 1;

  return (
    <div className="app">
      <StatusStrip sessions={sessions} connected={connected} onPick={select} activeKey={selectedKey}
        sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div className="body">
        {sidebarOpen && <Sidebar
          snapshot={snapshot}
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
          {(workspaces.length > 1 || (active?.panes.length ?? 0) > 0) && (
            <WorkspaceBar workspaces={workspaces} activeId={activeId} byTmux={byTmux}
              onActivate={activateWorkspace} onCreate={createWorkspace} onClose={closeWorkspace}
              editing={renaming} setEditing={setRenaming}
              onRename={(id, name) => updateWs((ws) => ({ workspaces: ws.map((w) => (w.id === id ? { ...w, name, auto: false } : w)) }))} />
          )}
          <div className="stage">
            {workspaces.map((w) => (
              <PaneGrid key={w.id} workspace={w} byTmux={byTmux} focused={focused} visible={!transcriptMode && w.id === activeId}
                onFocus={(tmux) => { setFocused(tmux); const s = byTmux.get(tmux); if (s) setSelectedKey(s.key); }}
                onSwap={swapPanes} onMaximize={setMaximized} onRemove={removePane} onKill={killPane} />
            ))}
            {transcriptMode && selected && (
              <div className="transcript-view">
                <SessionHeader session={selected} onResume={() => resume(selected)} onFork={() => resume(selected, true)} />
                <Transcript key={selected.key} session={selected} />
              </div>
            )}
            {showEmpty && (
              <div className="empty">
                <div className="empty-inner">
                  <h1>Nothing open</h1>
                  <p>Pick a session on the left, or start one.</p>
                  <button className="btn primary" onClick={() => setNewOpen({})}>New session <kbd>⌘N</kbd></button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      {newOpen && <NewSession preset={newOpen} projects={snapshot?.projects ?? []} onClose={() => setNewOpen(null)} onLaunch={launch} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {error && <div className="toast" role="alert">{error}</div>}
    </div>
  );
}
