import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Agent, Session, Snapshot, TodoScan, WorkspaceSummary, WorkspaceOpRequest } from '../../../shared/types';
import { placementTarget, applyWorkspaceOp } from '../../../shared/snapshot';
import { api, relTime, useNow, useSnapshot, usePresent, useViewing, type LaunchBody } from '../api';
import { statusWord } from './StatusStrip';
import { ContextBadge } from './ContextBadge';
import { LoopBadge } from './LoopBadge';
import { Transcript } from './Transcript';
import { TerminalPane } from './Terminal';
import { useDragScroll } from './dragScroll';
import { useVisualViewportHeight } from './viewport';
import { NewSession } from './NewSession';
import { TodoPanel } from './TodoPanel';

/**
 * The phone layout: a list of sessions with the ones waiting for you on top, and a single-session view
 * with the conversation, the pane's live screen, or a full terminal, plus a composer and a row of keys
 * for menus and permission prompts. The session being viewed lives in the URL hash so the iOS back
 * swipe works. On a tablet the two sit side by side: the list on the left, the session on the right.
 */

const LAYOUT_KEY = 'ms.layout';
const TAB_KEY = 'ms.mobileTab';
const FILTER_KEY = 'ms.mobileWorkspace';
const RECENT_PAGE = 12;
/** The hash key of the todo screen; session keys never start with a colon. */
const TODOS = ':todos';

function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  }, [query]);
  return on;
}

/** Touch layout by default on a narrow screen outside Electron; either can be forced per device. */
export function useMobileLayout(): [boolean, (v: 'mobile' | 'desktop') => void] {
  const [pref, setPref] = useState(() => localStorage.getItem(LAYOUT_KEY));
  const narrow = useMedia('(max-width: 760px)');
  const set = (v: 'mobile' | 'desktop') => { localStorage.setItem(LAYOUT_KEY, v); setPref(v); };
  if (window.multisession) return [false, set];
  return [pref ? pref === 'mobile' : narrow, set];
}

/** Room for the list beside the session (an iPad set to the touch layout), but not a phone on its side or an iPad in Split View. */
const useSplit = () => useMedia('(min-width: 761px) and (min-height: 600px)');

let pushedHash = false;

function useHashKey(): [string | null, (key: string | null, replace?: boolean) => void] {
  const read = () => {
    if (location.hash === '#/todos') return TODOS;
    const m = location.hash.match(/^#\/s\/(.+)$/); return m ? decodeURIComponent(m[1]) : null;
  };
  const [key, setKey] = useState(read);
  useEffect(() => {
    const on = () => setKey(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // Back pops the entry the app pushed, so the browser's own back gesture and the ‹ button agree.
  // With `replace`, the new key takes the current entry, so switching sessions side by side does not pile up history.
  const go = (k: string | null, replace = false) => {
    const hash = k && (k === TODOS ? '#/todos' : `#/s/${encodeURIComponent(k)}`);
    if (hash && replace) { history.replaceState(null, '', location.pathname + location.search + hash); setKey(k); }
    else if (hash) { pushedHash = true; location.hash = hash; }
    else if (pushedHash) { pushedHash = false; history.back(); }
    else { history.replaceState(null, '', location.pathname + location.search); setKey(null); }
  };
  return [key, go];
}

const skipPerms = () => localStorage.getItem('ms.skipPerms') !== '0';

export function MobileApp({ onDesktop }: { onDesktop: () => void }) {
  const { snapshot, connected } = useSnapshot();
  const [key, go] = useHashKey();
  const split = useSplit();
  const [newOpen, setNewOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [filter, setFilterState] = useState(() => localStorage.getItem(FILTER_KEY) || 'all');
  const setFilter = (f: string) => { localStorage.setItem(FILTER_KEY, f); setFilterState(f); };
  useVisualViewportHeight();

  const sessions = snapshot?.sessions ?? [];
  const done = sessions.filter((s) => s.live && s.status === 'done').length;
  useEffect(() => { document.title = done ? `(${done}) Tower` : 'Tower'; }, [done]);

  const session = key ? sessions.find((s) => s.key === key) : undefined;
  useViewing(session ? [session.key] : [], usePresent(false));
  const scopes = useMemo(() => workspaceScopes(snapshot), [snapshot]);
  const scope = scopes.find((x) => x.id === filter) ?? null;

  const workspaces = scopes.filter((x) => x.id !== 'other');
  const sheetSession = sheet?.kind === 'session' ? sessions.find((s) => s.key === sheet.key && tmuxOf(s)) : undefined;
  const sheetWorkspace = sheet?.kind === 'workspace' ? workspaces.find((x) => x.id === sheet.id) : undefined;
  const menuFor = (s: Session) => setSheet({ kind: 'session', key: s.key });
  const todoView = useMemo(() => todoScope(snapshot, scope), [snapshot, scope]);

  const launch = async (body: LaunchBody) => {
    // Started from a workspace chip, the session joins that workspace on the Mac; from All, the one in its folder.
    // Other means outside every workspace, so it stays there.
    const place = scope?.id === 'other' ? undefined : { workspace: scope?.id };
    const r = await api.launch({ ...body, place });
    setNewOpen(false);
    if (r.key) open(r.key);
  };
  // Side by side, the list stays put and picking another session replaces the one shown.
  const open = (k: string) => go(k, split && !!key);

  const list = (
    <SessionList sessions={sessions} scopes={scopes} scope={scope} onScope={setFilter} loaded={!!snapshot} connected={connected} onOpen={(s) => open(s.key)} onMenu={menuFor} onScopeMenu={(id) => setSheet({ kind: 'workspace', id })} onNew={() => setNewOpen(true)} onDesktop={onDesktop}
      todos={todoView.on.length ? todoView.todos.filter((t) => t.status === 'proposed').length : null} onTodos={() => open(TODOS)} selected={split ? key : null} />
  );
  const detail = key === TODOS ? <TodoScreen view={todoView} sessions={sessions} connected={connected} onOpen={(s) => open(s.key)} onBack={() => go(null)} />
    : key && session ? <SessionView s={session} connected={connected} onBack={split ? undefined : () => go(null)} onMenu={() => menuFor(session)} wide={split} />
    : key && snapshot ? <div className="m-empty"><p>That session is gone.</p><button className="btn" onClick={() => go(null)}>Back to the list</button></div>
    : null;

  return (
    <div className={`m-app ${split ? 'm-split' : ''}`}>
      {split ? (
        <>
          <aside className="m-side">{list}</aside>
          <main className="m-main">{detail ?? <div className="m-empty"><p>{snapshot ? 'Pick a session on the left.' : 'Reading sessions…'}</p></div>}</main>
        </>
      ) : detail ?? list}
      {sheetSession && <SessionSheet s={sheetSession} workspaces={workspaces} onClose={() => setSheet(null)}
        onKilled={() => { setSheet(null); if (key === sheetSession.key) go(null); }} />}
      {sheetWorkspace && <WorkspaceSheet w={sheetWorkspace} onClose={() => setSheet(null)} />}
      {newOpen && <NewSession preset={scope?.cwd ? { cwd: scope.cwd } : {}} projects={snapshot?.projects ?? []} hosts={snapshot?.hosts} onClose={() => setNewOpen(false)} onLaunch={launch} mobile />}
    </div>
  );
}

// ---- workspaces ------------------------------------------------------------------------------

/** A chip on the phone: one of the Mac's workspaces, or "Other" for live sessions in none of them. */
interface Scope {
  id: string;
  name: string;
  has: (s: Session) => boolean;
  /** Projects the workspace works in, so Recent can show closed sessions that belong with it. */
  cwds: Set<string>;
  cwd?: string;        // where a new session from this chip starts: the most recently active member's folder
  live: number;
  done: number;        // live sessions with a turn nobody has read
}

const tmuxOf = (s: Session) => (s.live?.kind === 'tmux' ? s.live.tmux : null);
/** `ms-claude-<id>` -> `claude:<id>`, to match a pane whose session is no longer running. */
const keyOfTmux = (tmux: string) => tmux.replace(/^ms-(claude|codex)-/, '$1:');

function workspaceScopes(snapshot: Snapshot | null): Scope[] {
  if (!snapshot) return [];
  const renamed = snapshot.renamed ?? {};
  const follow = (t: string) => { for (let i = 0; i < 8 && renamed[t]; i++) t = renamed[t]; return t; };
  const sessions = snapshot.sessions;
  // Show a session the phone just started in its workspace now, rather than once the Mac has placed it.
  const cwdOf = new Map(sessions.flatMap((s) => (tmuxOf(s) ? [[tmuxOf(s)!, s.cwd] as const] : [])));
  let all = (snapshot.workspaces ?? []).map((w) => ({ ...w, panes: w.panes.map(follow) }));
  for (const p of snapshot.placements ?? []) {
    if (all.some((w) => w.panes.includes(p.tmux))) continue;
    const id = placementTarget(p, all, (t) => cwdOf.get(t));
    if (id) all = all.map((w) => (w.id === id ? { ...w, panes: [...w.panes, p.tmux] } : w));
  }
  // Likewise for moves, renames and closes made here that the Mac has not applied yet.
  for (const op of snapshot.workspaceOps ?? []) {
    all = applyWorkspaceOp<string, WorkspaceSummary>(all, op, { tmuxOf: (t) => t, pane: (t) => (cwdOf.has(t) ? t : null), create: (id, name) => ({ id, name, panes: [] }) });
  }
  if (!all.some((w) => w.panes.length)) return [];
  const claimed = new Set<string>();
  const make = (id: string, name: string, has: (s: Session) => boolean): Scope => {
    const members = sessions.filter(has).sort((a, b) => b.updatedAt - a.updatedAt);
    const live = members.filter((s) => s.live);
    return {
      id, name, has, cwds: new Set(members.map((s) => s.cwd)), cwd: members[0]?.cwd,
      live: live.length, done: live.filter((s) => s.status === 'done').length,
    };
  };
  const scopes = all.filter((w: WorkspaceSummary) => w.panes.length).map((w) => {
    const tmux = new Set(w.panes.map(follow));
    const keys = new Set([...tmux].map(keyOfTmux));
    const has = (s: Session) => { const t = tmuxOf(s); return t ? tmux.has(t) : keys.has(s.key); };
    for (const s of sessions) if (s.live && has(s)) claimed.add(s.key);
    return make(w.id, w.name, has);
  });
  const other = make('other', 'Other', (s) => !!s.live && !claimed.has(s.key));
  return other.live ? [...scopes, other] : scopes;
}

function ScopeChips({ scopes, scope, total, onScope, onMenu }: { scopes: Scope[]; scope: Scope | null; total: { live: number; done: number }; onScope: (id: string) => void; onMenu: (id: string) => void }) {
  if (!scopes.length) return null;
  const chip = (id: string, name: string, live: number, done: number, on: boolean) => (
    <Chip key={id} id={id} name={name} live={live} done={done} on={on} onScope={onScope} onMenu={id === 'all' || id === 'other' ? undefined : onMenu} />
  );
  return (
    <div className="m-chips" role="tablist" aria-label="Workspace">
      {chip('all', 'All', total.live, total.done, !scope)}
      {scopes.map((x) => chip(x.id, x.name, x.live, x.done, scope?.id === x.id))}
    </div>
  );
}

/** A workspace chip; a long press opens Rename and Close. */
function Chip({ id, name, live, done, on, onScope, onMenu }: {
  id: string; name: string; live: number; done: number; on: boolean; onScope: (id: string) => void; onMenu?: (id: string) => void;
}) {
  const press = useLongPress(onMenu ? () => onMenu(id) : undefined);
  return (
    <button role="tab" aria-selected={on} className={`m-chip ${on ? 'on' : ''} ${id === 'other' ? 'other' : ''}`} onClick={() => onScope(id)} {...press}>
      {done > 0 && <span className="m-chip-wait" aria-label={`${done} need you`} />}
      <span className="m-chip-name">{name}</span>
      {live > 0 && <span className="m-chip-count">{live}</span>}
    </button>
  );
}

// ---- list ------------------------------------------------------------------------------------

function SessionList({ sessions, scopes, scope, onScope, loaded, connected, onOpen, onMenu, onScopeMenu, onNew, onDesktop, todos, onTodos, selected }: {
  sessions: Session[]; scopes: Scope[]; scope: Scope | null; onScope: (id: string) => void;
  loaded: boolean; connected: boolean; onOpen: (s: Session) => void; onMenu: (s: Session) => void; onScopeMenu: (id: string) => void;
  onNew: () => void; onDesktop: () => void;
  todos: number | null;  // proposals waiting in the chip's workspaces; null when no workspace finds todos
  onTodos: () => void;
  selected: string | null;  // the session shown beside the list
}) {
  const now = useNow();
  const [recentShown, setRecentShown] = useState(RECENT_PAGE);
  useEffect(() => setRecentShown(RECENT_PAGE), [scope?.id]);
  const total = useMemo(() => {
    const live = sessions.filter((s) => s.live);
    return { live: live.length, done: live.filter((s) => s.status === 'done').length };
  }, [sessions]);
  const groups = useMemo(() => {
    const live = sessions.filter((s) => s.live && (!scope || scope.has(s))).sort((a, b) => b.updatedAt - a.updatedAt);
    const recent = sessions.filter((s) => !s.live && (!scope || scope.has(s) || scope.cwds.has(s.cwd)));
    return {
      done: live.filter((s) => s.status === 'done'),
      working: live.filter((s) => s.status === 'working'),
      looping: live.filter((s) => s.status === 'looping'),
      open: live.filter((s) => s.status !== 'done' && s.status !== 'working' && s.status !== 'looping'),
      recent: recent.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }, [sessions, scope]);

  return (
    <div className="m-screen">
      <header className="m-top">
        <span className={`beacon ${connected ? 'on' : 'off'}`} />
        <span className="m-brand">Tower</span>
        <span className="m-top-sum">
          {groups.done.length > 0 && <span className="sum-wait">{groups.done.length} need{groups.done.length === 1 ? 's' : ''} you</span>}
          {groups.working.length > 0 && <span className="sum-work">{groups.working.length} working</span>}
        </span>
        {todos !== null && (
          <button className={`m-todos-btn ${selected === TODOS ? 'on' : ''}`} onClick={onTodos} aria-label={todos ? `Todos, ${todos} proposed` : 'Todos'}>
            Todos{todos > 0 && <span className="m-todos-n">{todos}</span>}
          </button>
        )}
        <button className="m-icon-btn" onClick={onNew} aria-label="New session">+</button>
      </header>
      <ScopeChips scopes={scopes} scope={scope} total={total} onScope={onScope} onMenu={onScopeMenu} />
      <div className="m-scroll">
        {!loaded && <div className="m-note">Reading sessions…</div>}
        <Group title="Needs you" rows={groups.done} now={now} selected={selected} onOpen={onOpen} onMenu={onMenu} />
        <Group title="Working" rows={groups.working} now={now} selected={selected} onOpen={onOpen} onMenu={onMenu} />
        <Group title="Looping" rows={groups.looping} now={now} selected={selected} onOpen={onOpen} onMenu={onMenu} />
        <Group title="Open" rows={groups.open} now={now} selected={selected} onOpen={onOpen} onMenu={onMenu} />
        {loaded && !groups.done.length && !groups.working.length && !groups.looping.length && !groups.open.length && <div className="m-note">{scope ? `Nothing running in ${scope.name}.` : 'No live sessions.'} Resume one below or start a new one with +.</div>}
        <Group title={scope && scope.id !== 'other' ? `Recent in ${scope.name}` : 'Recent'} rows={groups.recent.slice(0, recentShown)} now={now} selected={selected} onOpen={onOpen} onMenu={onMenu} />
        {groups.recent.length > recentShown && <button className="btn ghost wide" onClick={() => setRecentShown((n) => n + RECENT_PAGE * 2)}>Show more</button>}
        <button className="m-layout-link" onClick={onDesktop}>Use the desktop layout</button>
      </div>
    </div>
  );
}

function Group({ title, rows, now, selected, onOpen, onMenu }: { title: string; rows: Session[]; now: number; selected: string | null; onOpen: (s: Session) => void; onMenu: (s: Session) => void }) {
  if (!rows.length) return null;
  return (
    <section className="m-group">
      <h3>{title}<span>{rows.length}</span></h3>
      {rows.map((s) => <Row key={s.key} s={s} now={now} on={s.key === selected} onOpen={onOpen} onMenu={tmuxOf(s) ? onMenu : undefined} />)}
    </section>
  );
}

/** A session row; a long press on one running in Tower opens its actions. */
function Row({ s, now, on, onOpen, onMenu }: { s: Session; now: number; on: boolean; onOpen: (s: Session) => void; onMenu?: (s: Session) => void }) {
  const press = useLongPress(onMenu ? () => onMenu(s) : undefined);
  return (
    <button className={`m-row agent-${s.agent} status-${s.status} ${s.live ? 'live' : ''} ${on ? 'on' : ''}`} aria-current={on || undefined} onClick={() => onOpen(s)} {...press}>
      <span className="rail" />
      <span className="m-row-main">
        <span className="m-row-title">{s.title || 'Untitled'}</span>
        <span className="m-row-meta">
          <span>{s.project}</span>
          {s.gitBranch && s.gitBranch !== 'HEAD' && <span className="branch">{s.gitBranch}</span>}
          {s.spawn && <span className="m-tag-todo" title={s.spawn.parentTitle ? `Started by ${s.spawn.parentTitle}` : undefined}>↳ {s.spawn.name}</span>}
          {s.todo && <span className={`m-tag-todo ${s.todo.status === 'done' ? 'done' : ''}`}>{s.todo.status === 'done' ? 'todo ✓' : 'todo'}</span>}
          {s.live && <LoopBadge session={s} />}
          {s.live && <ContextBadge session={s} />}
        </span>
      </span>
      <span className="m-row-side">
        {s.live && <span className={`m-status status-${s.status}`}>{s.live.kind === 'external' ? 'terminal' : statusWord(s.status) || 'idle'}</span>}
        <time>{relTime(s.updatedAt, now)}</time>
      </span>
    </button>
  );
}

// ---- todos ---------------------------------------------------------------------------------

/**
 * The todos the phone shows: the chip's workspace, or every workspace that finds todos when the chip is
 * All or Other (Other is not a workspace, so it has no todos of its own).
 */
interface TodoView {
  one?: WorkspaceSummary;
  on: WorkspaceSummary[];   // the workspaces that find todos, of those shown
  todos: NonNullable<Snapshot['todos']>;
  scan?: TodoScan;
  names: Map<string, string>;
}

function todoScope(snapshot: Snapshot | null, scope: Scope | null): TodoView {
  const all = snapshot?.workspaces ?? [];
  const one = scope && scope.id !== 'other' ? all.find((w) => w.id === scope.id) : undefined;
  const on = (one ? [one] : all).filter((w) => w.todos);
  const ids = new Set((one ? [one] : on).map((w) => w.id));
  const todos = (snapshot?.todos ?? []).filter((t) => ids.has(t.workspace));
  const scans = (snapshot?.todoScans ?? []).filter((x) => ids.has(x.workspace));
  const scan = scans.length <= 1 ? scans[0] : {
    workspace: 'all', running: scans.some((x) => x.running),
    lastAt: Math.max(...scans.map((x) => x.lastAt ?? 0)) || undefined,
    error: scans.map((x) => x.error).filter(Boolean).join('\n') || undefined,
  };
  return { one, on, todos, scan, names: new Map(all.map((w) => [w.id, w.name])) };
}

function TodoScreen({ view, sessions, connected, onOpen, onBack }: {
  view: TodoView; sessions: Session[]; connected: boolean; onOpen: (s: Session) => void; onBack: () => void;
}) {
  const { byKey, byTmux } = useMemo(() => {
    const byKey = new Map<string, Session>(), byTmux = new Map<string, Session>();
    for (const s of sessions) { byKey.set(s.key, s); if (s.live?.kind === 'tmux') byTmux.set(s.live.tmux, s); }
    return { byKey, byTmux };
  }, [sessions]);
  const { one, on } = view;
  const workspace = one ?? { id: 'all', name: 'All workspaces', todos: on.length > 0 };
  return (
    <div className="m-screen">
      <header className="m-top m-top-session">
        <button className="m-back" onClick={onBack} aria-label="Back">
          <svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2 2 10l8 8" /></svg>
        </button>
        <div className="m-title">
          <span className="m-title-main">Todos</span>
          <span className="m-title-sub">{!connected && <span className="m-offline">offline · </span>}{workspace.name}</span>
        </div>
      </header>
      <TodoPanel phone workspace={workspace} todos={view.todos} scan={view.scan} byKey={byKey} byTmux={byTmux}
        onScan={one ? undefined : () => Promise.all(on.map((w) => api.scanTodos(w.id)))}
        workspaceOf={one || on.length < 2 ? undefined : (t) => view.names.get(t.workspace)}
        onOpenSession={onOpen} onClose={onBack}
        onStart={async (t) => {
          const r = await api.startTodo(t.id, localStorage.getItem('ms.skipPerms') !== '0');
          if (r.key) onOpen({ key: r.key } as Session);
        }} />
    </div>
  );
}

// ---- workspace actions -----------------------------------------------------------------------

/**
 * The phone's version of what the desktop does with tabs and panes: move a session between workspaces,
 * start a workspace, rename or close one, kill a session. Workspace changes go to the Mac as requests
 * (see WorkspaceOp); kill goes straight to tmux.
 */
type Sheet = { kind: 'session'; key: string } | { kind: 'workspace'; id: string };

const newWorkspaceId = () => Math.random().toString(36).slice(2, 10);

/** Long press (or right click) calls `onLong`, and the click that ends the press is swallowed. */
function useLongPress(onLong?: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  if (!onLong) return {};
  const cancel = () => { clearTimeout(timer.current); start.current = null; };
  const fire = () => { cancel(); fired.current = true; navigator.vibrate?.(10); onLong(); };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false; start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(fire, ms);
    },
    // A scroll or swipe is not a press.
    onPointerMove: (e: React.PointerEvent) => { const p = start.current; if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel(); },
    onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (!fired.current) fire(); },
    onClickCapture: (e: React.MouseEvent) => { if (fired.current) { e.preventDefault(); e.stopPropagation(); fired.current = false; } },
  };
}

function ActionSheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="m-sheet-back" onClick={onClose}>
      <div className="m-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grip" />
        <div className="m-sheet-head">
          <span className="m-sheet-title">{title}</span>
          {sub && <span className="m-sheet-sub">{sub}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

const Check = () => (
  <svg className="m-sheet-check" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 9.5 3.5 3.5 7.5-8" /></svg>
);

function NameForm({ initial, action, onSubmit }: { initial: string; action: string; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <form className="m-sheet-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}>
      <input ref={ref} value={name} onChange={(e) => setName(e.target.value)} placeholder="Workspace name" maxLength={60} aria-label="Workspace name" />
      <button type="submit" className="btn primary" disabled={!name.trim()}>{action}</button>
    </form>
  );
}

function SessionSheet({ s, workspaces, onClose, onKilled }: { s: Session; workspaces: Scope[]; onClose: () => void; onKilled: () => void }) {
  const tmux = tmuxOf(s)!;
  const current = workspaces.find((w) => w.has(s));
  const [naming, setNaming] = useState(false);
  const [killing, setKilling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, then: () => void) => {
    setErr(null);
    try { await fn(); then(); } catch (e) { setErr((e as Error).message); }
  };
  const move = (to: string | null, name?: string) => run(() => api.workspaceOp({ op: 'move', tmux, to, ...(name ? { name } : {}) }), onClose);

  return (
    <ActionSheet title={s.title || 'Untitled'} sub={`${s.project} · ${current ? current.name : 'in no workspace'}`} onClose={onClose}>
      <h4>Move to</h4>
      {workspaces.map((w) => (
        <button key={w.id} className={`m-sheet-item ${w === current ? 'on' : ''}`} onClick={() => (w === current ? onClose() : move(w.id))}>
          <span className="m-sheet-label">{w.name}</span>
          {w === current && <Check />}
        </button>
      ))}
      {naming
        ? <NameForm initial={s.project} action="Create" onSubmit={(name) => move(newWorkspaceId(), name)} />
        : <button className="m-sheet-item accent" onClick={() => setNaming(true)}>New workspace…</button>}
      {current && <button className="m-sheet-item muted" onClick={() => move(null)}>Remove from {current.name}</button>}
      <div className="m-sheet-sep" />
      {killing ? (
        <div className="m-sheet-confirm">
          <p>Stop this session? The conversation stays under Recent and can be resumed.</p>
          <div className="m-sheet-actions">
            <button className="btn ghost" onClick={() => setKilling(false)}>Cancel</button>
            <button className="btn danger armed" onClick={() => run(() => api.kill(tmux), onKilled)}>Kill session</button>
          </div>
        </div>
      ) : <button className="m-sheet-item danger" onClick={() => setKilling(true)}>Kill session…</button>}
      {err && <p className="m-err m-sheet-err">{err}</p>}
    </ActionSheet>
  );
}

function WorkspaceSheet({ w, onClose }: { w: Scope; onClose: () => void }) {
  const [naming, setNaming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (op: WorkspaceOpRequest) => {
    setErr(null);
    try { await api.workspaceOp(op); onClose(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <ActionSheet title={w.name} sub={`Workspace · ${w.live} running`} onClose={onClose}>
      {naming
        ? <NameForm initial={w.name} action="Rename" onSubmit={(name) => send({ op: 'rename', workspace: w.id, name })} />
        : <button className="m-sheet-item" onClick={() => setNaming(true)}>Rename…</button>}
      {closing ? (
        <div className="m-sheet-confirm">
          <p>Close {w.name}? Its sessions keep running and move to Other.</p>
          <div className="m-sheet-actions">
            <button className="btn ghost" onClick={() => setClosing(false)}>Cancel</button>
            <button className="btn danger armed" onClick={() => send({ op: 'close', workspace: w.id })}>Close workspace</button>
          </div>
        </div>
      ) : <button className="m-sheet-item danger" onClick={() => setClosing(true)}>Close workspace…</button>}
      {err && <p className="m-err m-sheet-err">{err}</p>}
    </ActionSheet>
  );
}

// ---- one session -----------------------------------------------------------------------------

type Tab = 'chat' | 'screen' | 'term';

/** `onBack` is left out beside the list, which is the way back there. */
function SessionView({ s, connected, onBack, onMenu, wide }: { s: Session; connected: boolean; onBack?: () => void; onMenu: () => void; wide: boolean }) {
  const tmux = s.live?.kind === 'tmux' && !s.live.dead ? s.live.tmux : null;
  const [tab, setTab] = useState<Tab>(() => localStorage.getItem(TAB_KEY) === 'screen' ? 'screen' : 'chat');
  const shown: Tab = !tmux && tab !== 'chat' ? 'chat' : tab;
  // Terminal is never remembered: attaching resizes the pane on the Mac, so it takes a deliberate tap.
  const pick = (t: Tab) => { setTab(t); if (t !== 'term') localStorage.setItem(TAB_KEY, t); };
  const [resuming, setResuming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const resume = async () => {
    setResuming(true); setErr(null);
    try { await api.resume(s.agent, s.id, { skipPermissions: skipPerms(), place: {} }); }
    catch (e) { setErr((e as Error).message); }
    finally { setResuming(false); }
  };

  return (
    <div className={`m-screen agent-${s.agent}`}>
      <header className={`m-top m-top-session ${onBack ? '' : 'no-back'}`}>
        {onBack && (
          <button className="m-back" onClick={onBack} aria-label="Back">
            <svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2 2 10l8 8" /></svg>
          </button>
        )}
        <div className="m-title">
          <span className="m-title-main">{s.title || 'Untitled'}</span>
          <span className="m-title-sub">
            {!connected && <span className="m-offline">offline · </span>}
            {s.project}{s.live ? ` · ${s.live.kind === 'external' ? 'in a terminal' : statusWord(s.status) || 'idle'}` : ''}
          </span>
        </div>
        {s.live && <ContextBadge session={s} />}
        {tmuxOf(s) && (
          <button className="m-back m-more" onClick={onMenu} aria-label="Session actions">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><circle cx="4" cy="10" r="1.8" /><circle cx="10" cy="10" r="1.8" /><circle cx="16" cy="10" r="1.8" /></svg>
          </button>
        )}
      </header>
      {tmux && (
        <div className="seg m-tabs" role="tablist">
          {(['chat', 'screen', 'term'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={shown === t} className={shown === t ? 'on' : ''} onClick={() => pick(t)}>
              {t === 'chat' ? 'Chat' : t === 'screen' ? 'Screen' : 'Terminal'}
            </button>
          ))}
        </div>
      )}
      <div className="m-body">
        {shown === 'chat' && <div className="m-chat"><Transcript session={s} compact /></div>}
        {shown === 'screen' && tmux && <Screen tmux={tmux} />}
        {shown === 'term' && tmux && <TermTab tmux={tmux} agent={s.agent} fontSize={wide ? 13 : 11} />}
      </div>
      {tmux ? <Dock tmux={tmux} keysOnly={shown === 'term'} />
        : (
          <div className="m-dock m-dock-resume">
            {s.live?.kind === 'external'
              ? <p className="small muted">Running in a terminal outside Tower, so it can only be read here.</p>
              : <>
                  {err && <p className="small m-err">{err}</p>}
                  <button className="btn primary wide" disabled={resuming} onClick={resume}>{resuming ? 'Resuming…' : `Resume in ${s.agent === 'claude' ? 'Claude Code' : 'Codex'}`}</button>
                </>}
          </div>
        )}
    </div>
  );
}

/**
 * The pane as it looks right now, polled while visible. Shows menus and permission prompts the transcript
 * cannot. A full-screen agent keeps no tmux scrollback, so dragging past the top scrolls the agent itself.
 */
function Screen({ tmux }: { tmux: string }) {
  const [cap, setCap] = useState<{ text: string; mouse: boolean; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let burst: ReturnType<typeof setTimeout>[] = [];
    let sent = 0, shown = 0;
    const load = async () => {
      const seq = ++sent;
      try {
        const r = await api.capture(tmux, 400);
        // Burst captures overlap; an older answer must not replace a newer frame.
        if (seq < shown) return;
        shown = seq;
        if (alive) setCap((c) => (c && c.text === r.text && c.mouse === r.mouse && c.width === r.width ? c : { text: r.text, mouse: r.mouse, width: r.width }));
      } catch { /* keep the last frame */ }
    };
    const tick = async () => {
      if (document.visibilityState === 'visible') await load();
      if (alive) timer = setTimeout(tick, 1000);
    };
    // The agent redraws a moment after a scroll, so look again a few times rather than wait for the next tick.
    refresh.current = () => { burst.forEach(clearTimeout); burst = [0, 50, 120, 250, 500].map((ms) => setTimeout(load, ms)); };
    tick();
    return () => { alive = false; clearTimeout(timer); burst.forEach(clearTimeout); };
  }, [tmux]);

  const text = cap?.text ?? null;
  // Lines the agent is scrolled back, as far as this view knows, for the "Latest" button.
  const [back, setBack] = useState(0);
  // One pane line wraps to several on a phone, so a line of scroll is worth that many px of drag.
  const step = () => { const el = ref.current; const rows = text?.split('\n').length; return el && rows ? Math.min(80, Math.max(14, el.scrollHeight / rows)) : 14; };
  useDragScroll(ref, tmux, { active: !!cap?.mouse, edges: true, step, after: (n) => { setBack((b) => Math.max(0, b + n)); refresh.current(); } });
  const latest = async () => { setBack(0); await api.scroll(tmux, -200).catch(() => {}); refresh.current(); };

  useLayoutEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [text]);

  const blocks = useMemo(() => (text == null ? [] : layoutScreen(text, cap!.width)), [text, cap?.width]);
  if (text == null) return <div className="m-note">Reading the screen…</div>;
  return (
    <>
    {back > 0 && <button className="m-latest" onClick={latest}>↓ Latest</button>}
    <div className="m-screen-text" ref={ref} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {blocks.map((b, i) => b.kind === 'rule' ? <hr key={i} />
        : b.kind === 'table' ? (
          <div key={i} className="m-table" style={{ '--cols': Math.max(...b.lines.map((l) => l.t.length)) } as CSSProperties}>
            {b.lines.map((l, j) => <Fragment key={j}>{j > 0 && '\n'}<Runs line={l} /></Fragment>)}
          </div>
        )
        : <div key={i} className="m-line" style={b.hang ? { paddingLeft: `${b.hang}ch`, textIndent: `-${b.hang}ch` } : undefined}>{b.line.t ? <Runs line={b.line} /> : ' '}</div>)}
    </div>
    </>
  );
}

/** One screen line: its text, and the attribute bits (`ATTR`) and OSC 8 link target of each UTF-16 unit. */
type Styled = { t: string; s: number[]; h: (string | undefined)[] };
type ScreenBlock = { kind: 'rule' } | { kind: 'table'; lines: Styled[] } | { kind: 'line'; line: Styled; hang: number };

const ATTR = { bold: 1, dim: 2, italic: 4, underline: 8, strike: 16 };
const ATTR_CLASS: [number, string][] = [[ATTR.bold, 'sb'], [ATTR.dim, 'sd'], [ATTR.italic, 'si'], [ATTR.underline, 'su'], [ATTR.strike, 'ss']];

function Runs({ line }: { line: Styled }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < line.t.length;) {
    let j = i + 1;
    while (j < line.t.length && line.s[j] === line.s[i] && line.h[j] === line.h[i]) j++;
    const a = line.s[i];
    const href = line.h[i];
    const text = line.t.slice(i, j);
    const run = a ? <span key={i} className={ATTR_CLASS.filter(([bit]) => a & bit).map(([, c]) => c).join(' ')}>{text}</span> : text;
    out.push(href ? <a key={i} href={href} target="_blank" rel="noopener noreferrer">{run}</a> : run);
    i = j;
  }
  return <>{out}</>;
}

// SGR sequences carry the attributes and OSC 8 the links; anything else (cursor moves) is dropped.
const ESCAPE = /\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/g;

function applySgr(a: number, params: string): number {
  const ps = (params || '0').split(';');
  for (let k = 0; k < ps.length; k++) {
    const [head, sub] = ps[k].split(':');
    const n = Number(head || 0);
    if (n === 0) a = 0;
    else if (n === 1) a |= ATTR.bold;
    else if (n === 2) a |= ATTR.dim;
    else if (n === 3) a |= ATTR.italic;
    else if (n === 4) a = sub === '0' ? a & ~ATTR.underline : a | ATTR.underline;
    else if (n === 9) a |= ATTR.strike;
    else if (n === 21) a |= ATTR.underline;
    else if (n === 22) a &= ~(ATTR.bold | ATTR.dim);
    else if (n === 23) a &= ~ATTR.italic;
    else if (n === 24) a &= ~ATTR.underline;
    else if (n === 29) a &= ~ATTR.strike;
    else if ((n === 38 || n === 48 || n === 58) && sub === undefined) k += ps[k + 1] === '5' ? 2 : ps[k + 1] === '2' ? 4 : 0;
  }
  return a;
}

/** Splits `capture-pane -e` output into lines of text with attributes, trailing blanks removed. */
function parseScreen(text: string): Styled[] {
  const lines: Styled[] = [];
  let a = 0;
  let link: string | undefined;
  for (const raw of text.split('\n')) {
    let t = '';
    const s: number[] = [];
    const h: (string | undefined)[] = [];
    let from = 0;
    const add = (chunk: string) => { t += chunk; for (let k = 0; k < chunk.length; k++) { s.push(a); h.push(link); } };
    ESCAPE.lastIndex = 0;
    for (let m; (m = ESCAPE.exec(raw));) {
      add(raw.slice(from, m.index));
      if (m[2] === 'm') a = applySgr(a, m[1]);
      else if (m[0].startsWith('\x1b]8;')) link = linkTarget(m[0]);
      from = ESCAPE.lastIndex;
    }
    add(raw.slice(from));
    t = t.replace(/\s+$/, '');
    s.length = h.length = t.length;
    lines.push({ t, s, h });
  }
  // The pane's empty rows between the output and the input box are noise on a small screen.
  const out = lines.filter((l, i) => l.t.trim() || (i > 0 && lines[i - 1].t.trim()));
  while (out.length && !out[out.length - 1].t.trim()) out.pop();
  return out;
}

/** The URI of an OSC 8 sequence (`ESC ] 8 ; params ; URI ST`), if the phone can open it; '' closes the link. */
function linkTarget(seq: string): string | undefined {
  const uri = seq.replace(/^\x1b\]8;[^;]*;/, '').replace(/(?:\x07|\x1b\\)$/, '');
  return /^(?:https?|mailto):/i.test(uri) ? uri : undefined;
}

const sliceStyled = (l: Styled, from: number): Styled => ({ t: l.t.slice(from), s: l.s.slice(from), h: l.h.slice(from) });

const TABLE_LINE = /^\s*[┌├└│┏┣┗┃╭╰╔╠╚║]/;
// Indent plus a list or message marker; wrapped lines of the item line up after it.
const HANG = /^(\s*)((?:[-*•·●○◦▪▸⏺⎿✻※✓✔✗✘☐☒◼◻→❯>]|\d+[.)])\s+)?/;

/**
 * Undoes the agent's wrapping at the pane width, so a phone can wrap each paragraph or list item again
 * at its own width with a hanging indent. Box tables keep their columns and scroll sideways instead.
 */
function layoutScreen(text: string, width: number): ScreenBlock[] {
  const out: ScreenBlock[] = [];
  let prevRaw = ''; // the last line folded into the open paragraph, or '' when none is open
  for (const line of parseScreen(text)) {
    const l = line.t;
    const last = out[out.length - 1];
    if (/^[\s─━═╌┄-]+$/.test(l) && l.trim().length > 8) { out.push({ kind: 'rule' }); prevRaw = ''; continue; }
    if (TABLE_LINE.test(l)) {
      if (last?.kind === 'table') last.lines.push(line); else out.push({ kind: 'table', lines: [line] });
      prevRaw = '';
      continue;
    }
    const m = HANG.exec(l)!;
    const body = sliceStyled(line, m[0].length);
    // A soft wrap: no marker, indented to the open item's text, and its first word would not have fit.
    if (last?.kind === 'line' && prevRaw && l.trim() && !m[2] && m[1].length === last.hang
      && prevRaw.length + 1 + body.t.split(' ')[0].length > width - 2) {
      const end = last.line.h[last.line.h.length - 1];
      last.line = {
        t: last.line.t + ' ' + body.t,
        s: [...last.line.s, last.line.s[last.line.s.length - 1] & body.s[0], ...body.s],
        h: [...last.line.h, end === body.h[0] ? end : undefined, ...body.h],
      };
      prevRaw = l;
      continue;
    }
    out.push({ kind: 'line', line, hang: m[0].length });
    prevRaw = l.trim() ? l : '';
  }
  return out;
}

/** TerminalPane turns touch drags into pane scrolling itself. */
function TermTab({ tmux, agent, fontSize }: { tmux: string; agent: Agent; fontSize: number }) {
  return <div className="m-term"><TerminalPane tmux={tmux} agent={agent} active fontSize={fontSize} /></div>;
}

const KEYS: { label: string; keys: string[]; title: string }[] = [
  { label: 'Esc', keys: ['Escape'], title: 'Escape: close a menu, stop the agent' },
  { label: '↑', keys: ['Up'], title: 'Up' },
  { label: '↓', keys: ['Down'], title: 'Down' },
  { label: '⏎', keys: ['Enter'], title: 'Enter: confirm' },
  { label: '1', keys: ['1'], title: '1' },
  { label: '2', keys: ['2'], title: '2' },
  { label: '3', keys: ['3'], title: '3' },
  { label: '⇧Tab', keys: ['BTab'], title: 'Shift+Tab: switch mode' },
  { label: 'Tab', keys: ['Tab'], title: 'Tab' },
  { label: '^C', keys: ['C-c'], title: 'Ctrl+C: clear the input, or interrupt' },
];

/** A picture picked on the phone: shown from memory right away, uploaded to the Mac in the background. */
interface Attachment { id: number; url: string; path?: string; error?: string; noPreview?: boolean }
let attachmentIds = 0;

/** Keys and composer. In the Terminal tab only the keys show: the iOS keyboard has no Esc or arrows, and typing goes into xterm. */
function Dock({ tmux, keysOnly }: { tmux: string; keysOnly?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const attsRef = useRef(atts);
  attsRef.current = atts;
  useEffect(() => () => { for (const a of attsRef.current) URL.revokeObjectURL(a.url); }, []);

  // Grow with the text up to about six lines.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const note = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 1200); };
  const attach = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const a: Attachment = { id: ++attachmentIds, url: URL.createObjectURL(f) };
      setAtts((cur) => [...cur, a]);
      api.upload(f)
        .then((r) => setAtts((cur) => cur.map((x) => (x.id === a.id ? { ...x, path: r.path } : x))))
        .catch((e) => setAtts((cur) => cur.map((x) => (x.id === a.id ? { ...x, error: (e as Error).message } : x))));
    }
  };
  const detach = (id: number) => setAtts((cur) => cur.filter((x) => { if (x.id === id) URL.revokeObjectURL(x.url); return x.id !== id; }));
  const uploading = atts.some((a) => !a.path && !a.error);
  const failed = atts.find((a) => a.error);
  const send = async () => {
    if (busy || uploading) return;
    if (failed) { note(failed.error!); return; }
    setBusy(true);
    const files = atts.map((a) => a.path!);
    try {
      await api.send(tmux, text, true, files);
      setText('');
      for (const a of atts) URL.revokeObjectURL(a.url);
      setAtts([]);
      note(text || files.length ? 'Sent' : 'Enter');
    } catch (e) { note((e as Error).message); }
    finally { setBusy(false); }
  };
  const press = async (k: typeof KEYS[number]) => {
    try { await api.keys(tmux, k.keys); note(k.label); } catch (e) { note((e as Error).message); }
  };

  return (
    <div className="m-dock">
      {/* pointerdown is cancelled so a key tap does not take focus from the text box (and close the keyboard). */}
      <div className="m-keys" onPointerDown={(e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }}>
        {KEYS.map((k) => <button key={k.label} type="button" title={k.title} onClick={() => press(k)}>{k.label}</button>)}
      </div>
      {!keysOnly && atts.length > 0 && (
        <div className="m-atts">
          {atts.map((a) => (
            <div key={a.id} className={`m-att ${a.path ? '' : a.error ? 'failed' : 'loading'}`} title={a.error}>
              {a.noPreview
                ? <span className="m-att-none">Photo</span>
                : <img src={a.url} alt="" onError={() => setAtts((cur) => cur.map((x) => (x.id === a.id ? { ...x, noPreview: true } : x)))} />}
              <button type="button" onClick={() => detach(a.id)} aria-label="Remove picture">×</button>
            </div>
          ))}
        </div>
      )}
      {!keysOnly && <form className="m-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <button type="button" className="m-attach" onClick={() => picker.current?.click()} aria-label="Attach pictures">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="2.5" y="4" width="15" height="12" rx="2.5" /><circle cx="7.5" cy="8.5" r="1.5" /><path d="m3 14.5 4.5-4 3.5 3 2.5-2 3.5 3" strokeLinecap="round" /></svg>
        </button>
        <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = ''; }} />
        <textarea ref={ta} rows={1} value={text} placeholder="Message" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
        <button type="submit" className="btn primary m-send" disabled={busy || uploading}>{text.trim() || atts.length ? 'Send' : '⏎'}</button>
      </form>}
      {flash && <div className="m-flash">{flash}</div>}
    </div>
  );
}
