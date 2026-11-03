import { useEffect, useState, type DragEvent } from 'react';
import type { Agent, Session, Status } from '../../../shared/types';
import { TerminalPane } from './Terminal';
import { statusWord } from './StatusStrip';
import { ContextBadge } from './ContextBadge';
import { LoopBadge } from './LoopBadge';
import { MachineTag } from './Machine';

export interface Pane { tmux: string; agent: Agent; openedAt?: number }
/** `auto` marks a generated name that gets replaced by the first session's project. Renaming clears it. */
/** `todos`: the todo finder reads this workspace's Claude sessions (server/todos.ts). */
/** `cols`: the number of columns the user chose for the grid; absent means the grid picks it from the pane count. */
export interface Workspace { id: string; name: string; panes: Pane[]; maximized?: string | null; auto?: boolean; todos?: boolean; cols?: number }
export const isAutoName = (w: Workspace) => w.auto === true || /^Workspace \d+$/.test(w.name) || /^[0-9a-f]{8}$/.test(w.name);

export const COL_CHOICES = [1, 2, 3, 4, 5, 6];

/** Columns for `n` panes. A chosen count never makes more columns than there are panes. */
export function gridColumns(n: number, chosen?: number): number {
  if (chosen) return Math.max(1, Math.min(chosen, n));
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

const RANK: Record<Status, number> = { done: 0, working: 1, waiting: 2, looping: 3, ended: 4, idle: 5 };
export function summarizeStatus(statuses: Status[]): Status | null {
  if (!statuses.length) return null;
  return statuses.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

export function WorkspaceBar({ workspaces, activeId, byTmux, editing, setEditing, onActivate, onCreate, onRename, onClose, todoCounts, todosOpen, onTodos, todosAvailable = true, onLayout }: {
  workspaces: Workspace[]; activeId: string; byTmux: Map<string, Session>;
  editing: string | null; setEditing: (id: string | null) => void;
  onActivate: (id: string) => void; onCreate: () => void; onRename: (id: string, name: string) => void; onClose: (id: string) => void;
  todoCounts: Map<string, { proposed: number; open: number }>; todosOpen: boolean; onTodos: () => void;
  /** False for a host's workspaces: their todos stay on the host. */
  todosAvailable?: boolean;
  onLayout: (id: string, cols: number | undefined) => void;
}) {
  const activeTodos = todoCounts.get(activeId);
  const activeWs = workspaces.find((w) => w.id === activeId);
  const [draft, setDraft] = useState('');
  useEffect(() => { if (editing) setDraft(workspaces.find((w) => w.id === editing)?.name ?? ''); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="wsbar" role="tablist">
      {workspaces.map((w, i) => {
        const st = summarizeStatus(w.panes.map((p) => byTmux.get(p.tmux)?.status ?? 'ended'));
        const active = w.id === activeId;
        return (
          <div key={w.id} role="tab" aria-selected={active} className={`ws ${active ? 'active' : ''}`}
            onClick={() => onActivate(w.id)} onDoubleClick={() => setEditing(w.id)}
            title={w.panes.map((p) => byTmux.get(p.tmux)?.title ?? p.tmux).join('\n') || 'Empty workspace'}>
            {st && <span className={`dot status-${st}`} />}
            {editing === w.id ? (
              <input className="ws-rename" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()}
                placeholder="Workspace name"
                onBlur={() => { onRename(w.id, draft.trim() || w.name); setEditing(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }}
                onClick={(e) => e.stopPropagation()} />
            ) : <span className="ws-name">{w.name}</span>}
            {editing !== w.id && active && (
              <span className="ws-edit" role="button" title="Rename workspace  ⌘⇧R" onClick={(e) => { e.stopPropagation(); setEditing(w.id); }}>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 1.5l2 2L4 10H2V8z" /></svg>
              </span>
            )}
            {w.todos && (todoCounts.get(w.id)?.proposed ?? 0) > 0 && <span className="ws-todo-dot" title="New todo proposals" />}
            <span className="ws-count">{w.panes.length || ''}</span>
            <span className="ws-index">{i < 9 ? i + 1 : ''}</span>
            <span className="ws-close" title="Close workspace (sessions keep running)" onClick={(e) => { e.stopPropagation(); onClose(w.id); }}>×</span>
          </div>
        );
      })}
      <button className="ws-add" onClick={onCreate} title="New workspace">+</button>
      {activeWs && <LayoutMenu workspace={activeWs} onPick={(cols) => onLayout(activeWs.id, cols)} />}
      {todosAvailable && <button className={`ws-todos ${todosOpen ? 'open' : ''} ${activeWs?.todos ? 'on' : ''}`} onClick={onTodos} title="Todos for this workspace  ⌘⇧T">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5l1.2 1.2L5.5 2.4M2 9.5l1.2 1.2 2.3-2.3M7.5 4h4.5M7.5 10h4.5" /></svg>
        Todos
        {activeWs?.todos && (activeTodos?.proposed ?? 0) > 0 && <span className="ws-todos-new">{activeTodos!.proposed}</span>}
        {activeWs?.todos && !(activeTodos?.proposed) && (activeTodos?.open ?? 0) > 0 && <span className="ws-todos-open">{activeTodos!.open}</span>}
      </button>}
    </div>
  );
}

/** A small picture of a grid: `cols` columns, filled row by row with `n` cells. */
function GridIcon({ n, cols }: { n: number; cols: number }) {
  const rows = Math.max(1, Math.ceil(n / cols));
  const W = 22, H = 14, g = 1.5;
  const w = (W - g * (cols - 1)) / cols, h = (H - g * (rows - 1)) / rows;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      {Array.from({ length: Math.max(n, 1) }, (_, i) => (
        <rect key={i} x={(i % cols) * (w + g)} y={Math.floor(i / cols) * (h + g)} width={w} height={h} rx={1.2} fill="currentColor" />
      ))}
    </svg>
  );
}

/** Picks how many columns the active workspace's grid has. Auto follows the pane count. */
function LayoutMenu({ workspace, onPick }: { workspace: Workspace; onPick: (cols: number | undefined) => void }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const n = workspace.panes.length;
  const current = gridColumns(n, workspace.cols);
  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => { if (!(e.target as Element).closest?.('.layout-menu, .ws-layout')) setAt(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', esc); window.addEventListener('resize', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); window.removeEventListener('resize', close); };
  }, [at]);
  const pick = (cols: number | undefined) => { onPick(cols); setAt(null); };
  const rowsOf = (c: number) => Math.max(1, Math.ceil(n / gridColumns(n, c)));
  return (
    <>
      <button className={`ws-layout ${at ? 'open' : ''}`} title="Grid layout for this workspace"
        onClick={(e) => {
          if (at) { setAt(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
        }}>
        <GridIcon n={Math.max(n, 1)} cols={current} />
        {workspace.cols ? `${current} × ${Math.max(1, Math.ceil(n / current))}` : 'Auto'}
      </button>
      {at && (
        <div className="layout-menu" role="menu" style={{ top: at.top, right: at.right }}>
          <button role="menuitemradio" aria-checked={!workspace.cols} className={!workspace.cols ? 'on' : ''} onClick={() => pick(undefined)}>
            <GridIcon n={Math.max(n, 1)} cols={gridColumns(n)} />
            <span>Auto</span><small>picks from the pane count</small>
          </button>
          {COL_CHOICES.map((c) => (
            <button key={c} role="menuitemradio" aria-checked={workspace.cols === c} className={workspace.cols === c ? 'on' : ''} onClick={() => pick(c)}>
              <GridIcon n={Math.max(n, 1)} cols={gridColumns(Math.max(n, 1), c)} />
              <span>{c} {c === 1 ? 'column' : 'columns'}</span>
              <small>{n > 1 ? `${gridColumns(n, c)} × ${rowsOf(c)}` : ''}</small>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Marks a session that was started from a todo; a click shows that todo in the Todos panel. */
export function TodoBadge({ todo, onClick }: { todo: NonNullable<Session['todo']>; onClick: () => void }) {
  return (
    <button className={`todo-badge ${todo.status}`} title={`Started from the todo: ${todo.title}\nClick to show it in Todos`}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {todo.status === 'done' ? <path d="M2.5 6.2l2.3 2.3 4.7-5" /> : <rect x="2" y="2" width="8" height="8" rx="2" />}
      </svg>
      Todo
    </button>
  );
}

export function PaneGrid({ workspace, byTmux, lost, resumeErrors, onResumeLost, focused, visible, onFocus, onSwap, onMaximize, onRemove, onKill, onAdd, onTodo }: {
  workspace: Workspace; byTmux: Map<string, Session>; lost: Set<string>; resumeErrors: Record<string, string>; onResumeLost: (tmux: string) => void;
  focused: string | null; visible: boolean;
  onFocus: (tmux: string) => void; onSwap: (a: string, b: string) => void; onMaximize: (tmux: string | null) => void;
  onRemove: (tmux: string) => void; onKill: (tmux: string) => void; onAdd: () => void; onTodo: (id: string) => void;
}) {
  const panes = workspace.panes;
  const max = workspace.maximized && panes.some((p) => p.tmux === workspace.maximized) ? workspace.maximized : null;
  const cols = max ? 1 : gridColumns(panes.length, workspace.cols);
  // Cells the last row leaves empty; they always sit in that row, so one tile spans them.
  const spare = max || !panes.length ? 0 : (cols - (panes.length % cols)) % cols;
  // Same source as ⌘D: the focused pane, else the first pane with a known session.
  const src = (focused && panes.some((p) => p.tmux === focused) && byTmux.get(focused)) || panes.map((p) => byTmux.get(p.tmux)).find(Boolean);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  return (
    <div className={`grid ${visible ? '' : 'hidden-grid'}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} aria-hidden={!visible}>
      {panes.length === 0 && visible && (
        <div className="grid-empty"><p>Empty workspace. Pick a live session on the left, or start one with <kbd>⌘N</kbd>.</p></div>
      )}
      {panes.map((p) => {
        const s = byTmux.get(p.tmux);
        const hidden = !!max && max !== p.tmux;
        return (
          <PaneView key={p.tmux} pane={p} session={s} lost={lost.has(p.tmux)} resumeError={resumeErrors[p.tmux]} onResume={() => onResumeLost(p.tmux)} focused={focused === p.tmux && visible} hidden={hidden} maximized={max === p.tmux}
            dragging={dragging === p.tmux} over={over === p.tmux}
            onFocus={() => onFocus(p.tmux)} onMaximize={() => onMaximize(max === p.tmux ? null : p.tmux)}
            onRemove={() => onRemove(p.tmux)} onKill={() => onKill(p.tmux)} onTodo={onTodo}
            onDragStart={() => setDragging(p.tmux)} onDragEnd={() => { setDragging(null); setOver(null); }}
            onDragOver={(e) => { if (dragging && dragging !== p.tmux) { e.preventDefault(); setOver(p.tmux); } }}
            onDragLeave={() => setOver((o) => (o === p.tmux ? null : o))}
            onDrop={(e) => { e.preventDefault(); if (dragging && dragging !== p.tmux) onSwap(dragging, p.tmux); setDragging(null); setOver(null); }}
          />
        );
      })}
      {spare > 0 && (
        <button className="grid-add" style={{ gridColumn: `span ${spare}` }} onClick={onAdd}
          title={src ? `New ${src.agent === 'claude' ? 'Claude' : 'Codex'} session in ${src.project}  ⌘D` : 'New session  ⌘D'}>
          <span className="grid-add-plus" aria-hidden>+</span>
          <span className="grid-add-label">{src ? `New ${src.agent === 'claude' ? 'Claude' : 'Codex'} in ${src.project}` : 'New session'} <kbd>⌘D</kbd></span>
        </button>
      )}
    </div>
  );
}

function PaneView({ pane, session: s, lost, resumeError, onResume, focused, hidden, maximized, dragging, over, onFocus, onMaximize, onRemove, onKill, onTodo, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }: {
  pane: Pane; session?: Session; lost: boolean; resumeError?: string; onResume: () => void; focused: boolean; hidden: boolean; maximized: boolean; dragging: boolean; over: boolean;
  onFocus: () => void; onMaximize: () => void; onRemove: () => void; onKill: () => void; onTodo: (id: string) => void;
  onDragStart: () => void; onDragEnd: () => void; onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(t); }, [confirm]);
  const status = s?.status ?? 'ended';
  const ended = status === 'ended';
  const killClick = () => { if (ended || confirm) { setConfirm(false); onKill(); } else setConfirm(true); };
  return (
    <section className={`pane agent-${pane.agent} status-${status} ${focused ? 'focused' : ''} ${hidden ? 'pane-hidden' : ''} ${dragging ? 'dragging' : ''} ${over ? 'drop-target' : ''}`}
      onMouseDown={onFocus} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="pane-head" draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', pane.tmux); onDragStart(); }} onDragEnd={onDragEnd}
        title={s ? `${s.title}\n${s.cwd}\nDrag onto another pane to swap` : pane.tmux}>
        <span className="dot" />
        <MachineTag host={s?.host} />
        <span className="pane-project">{s?.project ?? pane.tmux.replace(/^(@[^:]+:)?ms-\w+-/, '')}</span>
        {s?.todo && <TodoBadge todo={s.todo} onClick={() => onTodo(s.todo!.id)} />}
        {s?.spawn && <span className="spawn-badge" title={`Agent "${s.spawn.name}", started by ${s.spawn.parentTitle ? `"${s.spawn.parentTitle}"` : 'another session'} with tower spawn`}>↳ {s.spawn.name}</span>}
        <span className="pane-title">{s?.title ?? ''}</span>
        {s && <LoopBadge session={s} />}
        {s && <ContextBadge session={s} />}
        <span className="pane-status">{statusWord(status)}</span>
        <span className="pane-actions">
          <button title={maximized ? 'Restore grid (Esc)' : 'Maximize (⌘⇧⏎)'} onClick={(e) => { e.stopPropagation(); onMaximize(); }}>{maximized ? '⤡' : '⤢'}</button>
          <button title="Remove from workspace (session keeps running)  ⌘W" onClick={(e) => { e.stopPropagation(); onRemove(); }}>−</button>
          <button className={`kill ${confirm ? 'armed' : ''}`} title="Kill the process and its tmux session" onClick={(e) => { e.stopPropagation(); killClick(); }}>{ended ? 'close' : confirm ? 'confirm kill' : 'kill'}</button>
        </span>
      </header>
      <div className="pane-body">
        {lost ? (
          <div className="pane-lost">
            {resumeError ? <p>Could not resume this session: {resumeError}</p> : <p>This session stopped when the Mac shut down. Resuming…</p>}
            {resumeError && <button onClick={(e) => { e.stopPropagation(); onResume(); }}>Try again</button>}
          </div>
        ) : <TerminalPane tmux={pane.tmux} active={focused && !hidden} agent={pane.agent} />}
      </div>
    </section>
  );
}
