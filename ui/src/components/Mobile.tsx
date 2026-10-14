import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Agent, Session, Snapshot, WorkspaceSummary, WorkspaceOpRequest } from '../../../shared/types';
import { placementTarget, applyWorkspaceOp } from '../../../shared/snapshot';
import { api, relTime, useNow, useSnapshot, type LaunchBody } from '../api';
import { statusWord } from './StatusStrip';
import { ContextBadge } from './ContextBadge';
import { LoopBadge } from './LoopBadge';
import { Transcript } from './Transcript';
import { TerminalPane } from './Terminal';
import { NewSession } from './NewSession';

/**
 * The phone layout: a list of sessions with the ones waiting for you on top, and a single-session view
 * with the conversation, the pane's live screen, or a full terminal, plus a composer and a row of keys
 * for menus and permission prompts. The session being viewed lives in the URL hash so the iOS back
 * swipe works.
 */

const LAYOUT_KEY = 'ms.layout';
const TAB_KEY = 'ms.mobileTab';
const FILTER_KEY = 'ms.mobileWorkspace';
const RECENT_PAGE = 12;

/** Phone layout by default on a narrow screen outside Electron; either can be forced per device. */
export function useMobileLayout(): [boolean, (v: 'mobile' | 'desktop') => void] {
  const query = '(max-width: 760px)';
  const [pref, setPref] = useState(() => localStorage.getItem(LAYOUT_KEY));
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const set = (v: 'mobile' | 'desktop') => { localStorage.setItem(LAYOUT_KEY, v); setPref(v); };
  if (window.multisession) return [false, set];
  return [pref ? pref === 'mobile' : narrow, set];
}

let pushedHash = false;

function useHashKey(): [string | null, (key: string | null) => void] {
  const read = () => { const m = location.hash.match(/^#\/s\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; };
  const [key, setKey] = useState(read);
  useEffect(() => {
    const on = () => setKey(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // Back pops the entry the app pushed, so the browser's own back gesture and the ‹ button agree.
  const go = (k: string | null) => {
    if (k) { pushedHash = true; location.hash = `#/s/${encodeURIComponent(k)}`; }
    else if (pushedHash) { pushedHash = false; history.back(); }
    else { history.replaceState(null, '', location.pathname + location.search); setKey(null); }
  };
  return [key, go];
}

/**
 * iOS keeps the layout viewport when the keyboard opens; size the app to the visible part instead, and say so
 * with `kb-open` so the dock can drop the home-bar inset the keyboard covers.
 */
function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    // A Home Screen app shrinks innerHeight with the keyboard too, so compare against the tallest height seen
    // at this width instead (reset on rotation). Pinch zoom shrinks vv.height as well; scale undoes that.
    let full = 0, width = 0;
    const on = () => {
      if (vv.width * vv.scale !== width) { width = vv.width * vv.scale; full = 0; }
      full = Math.max(full, window.innerHeight, vv.height * vv.scale);
      const kb = vv.height * vv.scale < full - 80;
      root.classList.toggle('kb-open', kb);
      if (kb) root.style.setProperty('--vvh', `${vv.height}px`);
      else root.style.removeProperty('--vvh');
      if (vv.offsetTop) window.scrollTo(0, 0);
    };
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => {
      vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on);
      root.classList.remove('kb-open'); root.style.removeProperty('--vvh');
    };
  }, []);
}

const skipPerms = () => localStorage.getItem('ms.skipPerms') !== '0';

export function MobileApp({ onDesktop }: { onDesktop: () => void }) {
  const { snapshot, connected } = useSnapshot();
  const [key, go] = useHashKey();
  const [newOpen, setNewOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [filter, setFilterState] = useState(() => localStorage.getItem(FILTER_KEY) || 'all');
  const setFilter = (f: string) => { localStorage.setItem(FILTER_KEY, f); setFilterState(f); };
  useVisualViewportHeight();

  const sessions = snapshot?.sessions ?? [];
  const waiting = sessions.filter((s) => s.live && s.status === 'waiting').length;
  useEffect(() => { document.title = waiting ? `(${waiting}) Tower` : 'Tower'; }, [waiting]);

  const session = key ? sessions.find((s) => s.key === key) : undefined;
  const scopes = useMemo(() => workspaceScopes(snapshot), [snapshot]);
  const scope = scopes.find((x) => x.id === filter) ?? null;

  const workspaces = scopes.filter((x) => x.id !== 'other');
  const sheetSession = sheet?.kind === 'session' ? sessions.find((s) => s.key === sheet.key && tmuxOf(s)) : undefined;
  const sheetWorkspace = sheet?.kind === 'workspace' ? workspaces.find((x) => x.id === sheet.id) : undefined;
  const menuFor = (s: Session) => setSheet({ kind: 'session', key: s.key });

  const launch = async (body: LaunchBody) => {
    // Started from a workspace chip, the session joins that workspace on the Mac; from All, the one in its folder.
    // Other means outside every workspace, so it stays there.
    const place = scope?.id === 'other' ? undefined : { workspace: scope?.id };
    const r = await api.launch({ ...body, place });
    setNewOpen(false);
    if (r.key) go(r.key);
  };

  return (
    <div className="m-app">
      {key && session ? <SessionView s={session} connected={connected} onBack={() => go(null)} onMenu={() => menuFor(session)} />
        : key && snapshot ? <div className="m-empty"><p>That session is gone.</p><button className="btn" onClick={() => go(null)}>Back to the list</button></div>
        : <SessionList sessions={sessions} scopes={scopes} scope={scope} onScope={setFilter} loaded={!!snapshot} connected={connected} onOpen={(s) => go(s.key)} onMenu={menuFor} onScopeMenu={(id) => setSheet({ kind: 'workspace', id })} onNew={() => setNewOpen(true)} onDesktop={onDesktop} />}
      {sheetSession && <SessionSheet s={sheetSession} workspaces={workspaces} onClose={() => setSheet(null)}
        onKilled={() => { setSheet(null); if (key === sheetSession.key) go(null); }} />}
      {sheetWorkspace && <WorkspaceSheet w={sheetWorkspace} onClose={() => setSheet(null)} />}
      {newOpen && <NewSession preset={scope?.cwd ? { cwd: scope.cwd } : {}} projects={snapshot?.projects ?? []} onClose={() => setNewOpen(false)} onLaunch={launch} />}
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
  waiting: number;
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
      live: live.length, waiting: live.filter((s) => s.status === 'waiting').length,
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

function ScopeChips({ scopes, scope, total, onScope, onMenu }: { scopes: Scope[]; scope: Scope | null; total: { live: number; waiting: number }; onScope: (id: string) => void; onMenu: (id: string) => void }) {
  if (!scopes.length) return null;
  const chip = (id: string, name: string, live: number, waiting: number, on: boolean) => (
    <Chip key={id} id={id} name={name} live={live} waiting={waiting} on={on} onScope={onScope} onMenu={id === 'all' || id === 'other' ? undefined : onMenu} />
  );
  return (
    <div className="m-chips" role="tablist" aria-label="Workspace">
      {chip('all', 'All', total.live, total.waiting, !scope)}
      {scopes.map((x) => chip(x.id, x.name, x.live, x.waiting, scope?.id === x.id))}
    </div>
  );
}

/** A workspace chip; a long press opens Rename and Close. */
function Chip({ id, name, live, waiting, on, onScope, onMenu }: {
  id: string; name: string; live: number; waiting: number; on: boolean; onScope: (id: string) => void; onMenu?: (id: string) => void;
}) {
  const press = useLongPress(onMenu ? () => onMenu(id) : undefined);
  return (
    <button role="tab" aria-selected={on} className={`m-chip ${on ? 'on' : ''} ${id === 'other' ? 'other' : ''}`} onClick={() => onScope(id)} {...press}>
      {waiting > 0 && <span className="m-chip-wait" aria-label={`${waiting} waiting`} />}
      <span className="m-chip-name">{name}</span>
      {live > 0 && <span className="m-chip-count">{live}</span>}
    </button>
  );
}

// ---- list ------------------------------------------------------------------------------------

function SessionList({ sessions, scopes, scope, onScope, loaded, connected, onOpen, onMenu, onScopeMenu, onNew, onDesktop }: {
  sessions: Session[]; scopes: Scope[]; scope: Scope | null; onScope: (id: string) => void;
  loaded: boolean; connected: boolean; onOpen: (s: Session) => void; onMenu: (s: Session) => void; onScopeMenu: (id: string) => void;
  onNew: () => void; onDesktop: () => void;
}) {
  const now = useNow();
  const [recentShown, setRecentShown] = useState(RECENT_PAGE);
  useEffect(() => setRecentShown(RECENT_PAGE), [scope?.id]);
  const total = useMemo(() => {
    const live = sessions.filter((s) => s.live);
    return { live: live.length, waiting: live.filter((s) => s.status === 'waiting').length };
  }, [sessions]);
  const groups = useMemo(() => {
    const live = sessions.filter((s) => s.live && (!scope || scope.has(s))).sort((a, b) => b.updatedAt - a.updatedAt);
    const recent = sessions.filter((s) => !s.live && (!scope || scope.has(s) || scope.cwds.has(s.cwd)));
    return {
      waiting: live.filter((s) => s.status === 'waiting'),
      working: live.filter((s) => s.status === 'working'),
      looping: live.filter((s) => s.status === 'looping'),
      open: live.filter((s) => s.status !== 'waiting' && s.status !== 'working' && s.status !== 'looping'),
      recent: recent.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }, [sessions, scope]);

  return (
    <div className="m-screen">
      <header className="m-top">
        <span className={`beacon ${connected ? 'on' : 'off'}`} />
        <span className="m-brand">Tower</span>
        <span className="m-top-sum">
          {groups.waiting.length > 0 && <span className="sum-wait">{groups.waiting.length} need{groups.waiting.length === 1 ? 's' : ''} you</span>}
          {groups.working.length > 0 && <span className="sum-work">{groups.working.length} working</span>}
        </span>
        <button className="m-icon-btn" onClick={onNew} aria-label="New session">+</button>
      </header>
      <ScopeChips scopes={scopes} scope={scope} total={total} onScope={onScope} onMenu={onScopeMenu} />
      <div className="m-scroll">
        {!loaded && <div className="m-note">Reading sessions…</div>}
        <Group title="Needs you" rows={groups.waiting} now={now} onOpen={onOpen} onMenu={onMenu} />
        <Group title="Working" rows={groups.working} now={now} onOpen={onOpen} onMenu={onMenu} />
        <Group title="Looping" rows={groups.looping} now={now} onOpen={onOpen} onMenu={onMenu} />
        <Group title="Open" rows={groups.open} now={now} onOpen={onOpen} onMenu={onMenu} />
        {loaded && !groups.waiting.length && !groups.working.length && !groups.looping.length && !groups.open.length && <div className="m-note">{scope ? `Nothing running in ${scope.name}.` : 'No live sessions.'} Resume one below or start a new one with +.</div>}
        <Group title={scope && scope.id !== 'other' ? `Recent in ${scope.name}` : 'Recent'} rows={groups.recent.slice(0, recentShown)} now={now} onOpen={onOpen} onMenu={onMenu} />
        {groups.recent.length > recentShown && <button className="btn ghost wide" onClick={() => setRecentShown((n) => n + RECENT_PAGE * 2)}>Show more</button>}
        <button className="m-layout-link" onClick={onDesktop}>Use the desktop layout</button>
      </div>
    </div>
  );
}

function Group({ title, rows, now, onOpen, onMenu }: { title: string; rows: Session[]; now: number; onOpen: (s: Session) => void; onMenu: (s: Session) => void }) {
  if (!rows.length) return null;
  return (
    <section className="m-group">
      <h3>{title}<span>{rows.length}</span></h3>
      {rows.map((s) => <Row key={s.key} s={s} now={now} onOpen={onOpen} onMenu={tmuxOf(s) ? onMenu : undefined} />)}
    </section>
  );
}

/** A session row; a long press on one running in Tower opens its actions. */
function Row({ s, now, onOpen, onMenu }: { s: Session; now: number; onOpen: (s: Session) => void; onMenu?: (s: Session) => void }) {
  const press = useLongPress(onMenu ? () => onMenu(s) : undefined);
  return (
    <button className={`m-row agent-${s.agent} status-${s.status} ${s.live ? 'live' : ''}`} onClick={() => onOpen(s)} {...press}>
      <span className="rail" />
      <span className="m-row-main">
        <span className="m-row-title">{s.title || 'Untitled'}</span>
        <span className="m-row-meta">
          <span>{s.project}</span>
          {s.gitBranch && s.gitBranch !== 'HEAD' && <span className="branch">{s.gitBranch}</span>}
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

function SessionView({ s, connected, onBack, onMenu }: { s: Session; connected: boolean; onBack: () => void; onMenu: () => void }) {
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
      <header className="m-top m-top-session">
        <button className="m-back" onClick={onBack} aria-label="Back">
          <svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2 2 10l8 8" /></svg>
        </button>
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
        {shown === 'term' && tmux && <TermTab tmux={tmux} agent={s.agent} />}
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
 * Turns vertical touch drags and wheel input on `ref` into pane scroll steps, since a touch screen never
 * sends the wheel events a full-screen agent scrolls on. With `edges`, the element scrolls natively
 * first and only a drag past its top or bottom goes to the pane.
 */
function useDragScroll(ref: RefObject<HTMLElement>, tmux: string, opts: { active: boolean; edges: boolean; after?: (lines: number) => void }) {
  const after = useRef(opts.after);
  after.current = opts.after;
  useEffect(() => {
    const el = ref.current;
    if (!el || !opts.active) return;
    const STEP = 14; // px of drag per line
    let lastY = 0, acc = 0, pending = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const n = pending; pending = 0;
      if (n) api.scroll(tmux, n).then(() => after.current?.(n)).catch(() => {});
    };
    const drag = (dy: number): boolean => {
      if (opts.edges) {
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
        if (!((dy > 0 && atTop) || (dy < 0 && atBottom))) { acc = 0; return false; }
      }
      acc += dy;
      while (Math.abs(acc) >= STEP) { const d = Math.sign(acc); pending += d; acc -= d * STEP; }
      if (pending && !timer) timer = setTimeout(flush, 60);
      return true;
    };
    const onStart = (e: TouchEvent) => { lastY = e.touches[0].clientY; acc = 0; };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = y - lastY; lastY = y;
      if (drag(dy) && e.cancelable) e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => { if (drag(-e.deltaY)) { e.preventDefault(); e.stopPropagation(); } };
    // Capture phase, so xterm (in the Terminal tab) never sees the gesture as a selection or its own scroll.
    el.addEventListener('touchstart', onStart, { passive: true, capture: true });
    el.addEventListener('touchmove', onMove, { passive: false, capture: true });
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener('touchstart', onStart, { capture: true });
      el.removeEventListener('touchmove', onMove, { capture: true });
      el.removeEventListener('wheel', onWheel, { capture: true });
      clearTimeout(timer);
    };
  }, [ref, tmux, opts.active, opts.edges]);
}

/**
 * The pane as it looks right now, polled while visible. Shows menus and permission prompts the transcript
 * cannot. A full-screen agent keeps no tmux scrollback, so dragging past the top scrolls the agent itself.
 */
function Screen({ tmux }: { tmux: string }) {
  const [cap, setCap] = useState<{ text: string; mouse: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api.capture(tmux, 400);
        if (alive) setCap((c) => (c && c.text === r.text && c.mouse === r.mouse ? c : { text: r.text, mouse: r.mouse }));
      } catch { /* keep the last frame */ }
    };
    const tick = async () => {
      if (document.visibilityState === 'visible') await load();
      if (alive) timer = setTimeout(tick, 1000);
    };
    refresh.current = () => { void load(); };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [tmux]);

  // Lines the agent is scrolled back, as far as this view knows, for the "Latest" button.
  const [back, setBack] = useState(0);
  useDragScroll(ref, tmux, { active: !!cap?.mouse, edges: true, after: (n) => { setBack((b) => Math.max(0, b + n)); refresh.current(); } });
  const latest = async () => { setBack(0); await api.scroll(tmux, -200).catch(() => {}); refresh.current(); };
  const text = cap?.text ?? null;

  useLayoutEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [text]);

  if (text == null) return <div className="m-note">Reading the screen…</div>;
  // The pane's empty rows between the output and the input box are noise on a small screen.
  const lines = text.replace(/\s+$/, '').replace(/\n(\s*\n){2,}/g, '\n\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  return (
    <>
    {back > 0 && <button className="m-latest" onClick={latest}>↓ Latest</button>}
    <div className="m-screen-text" ref={ref} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {lines.map((l, i) => /^[\s─━═╌┄-]+$/.test(l) && l.trim().length > 8
        ? <hr key={i} />
        : <div key={i} className="m-line">{l || ' '}</div>)}
    </div>
    </>
  );
}

/** xterm has no touch scrolling, and tmux or the agent owns the scrollback anyway: drags go to the pane. */
function TermTab({ tmux, agent }: { tmux: string; agent: Agent }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref, tmux, { active: true, edges: false });
  return <div className="m-term" ref={ref}><TerminalPane tmux={tmux} agent={agent} active fontSize={11} /></div>;
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
