import { useEffect, useState, type DragEvent } from 'react';
import type { Session } from '../../../shared/types';
import { statusWord } from './StatusStrip';
import { PauseIcon, summarizeStatus, type Workspace } from './Workspace';

const PANE_TYPE = 'application/x-tower-pane';
const WS_TYPE = 'application/x-tower-workspace';
const OPEN_KEY = 'ms.wsOpen';
const ACTIVE_SHUT_KEY = 'ms.wsActiveShut';
const PAUSED_SHUT_KEY = 'ms.wsPausedShut';

/** A workspace with panes, all of them paused: it holds an arrangement but runs nothing. */
export const isAsleep = (w: Workspace, paused: Map<string, Session | undefined>) => w.panes.length > 0 && w.panes.every((p) => paused.has(p.tmux));

/** The order the list shows: workspaces that run something (or are empty) first, the fully paused ones after. */
export function listOrder(workspaces: Workspace[], paused: Map<string, Session | undefined>): Workspace[] {
  return [...workspaces.filter((w) => !isAsleep(w, paused)), ...workspaces.filter((w) => isAsleep(w, paused))];
}

/**
 * The workspaces as a list in the sidebar: one row per workspace with its state, the sessions of the open
 * ones under it, and the fully paused workspaces in a section of their own at the end. A session row
 * dragged onto a workspace moves there; a workspace row dragged onto another takes its place.
 */
export function WorkspaceList({ workspaces, activeId, byTmux, paused, lost, focused, editing, setEditing, todoCounts, onActivate, onCreate, onRename, onClose, onFocusPane, onMovePane, onReorder }: {
  workspaces: Workspace[]; activeId: string; byTmux: Map<string, Session>;
  paused: Map<string, Session | undefined>; lost: Set<string>; focused: string | null;
  editing: string | null; setEditing: (id: string | null) => void;
  todoCounts: Map<string, { proposed: number; open: number }>;
  onActivate: (id: string) => void; onCreate: () => void; onRename: (id: string, name: string) => void; onClose: (id: string) => void;
  onFocusPane: (tmux: string) => void; onMovePane: (tmux: string, to: string) => void; onReorder: (id: string, before: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')));
  const [activeShut, setActiveShut] = useState(() => localStorage.getItem(ACTIVE_SHUT_KEY) === '1');
  const [pausedShut, setPausedShut] = useState(() => localStorage.getItem(PAUSED_SHUT_KEY) === '1');
  const [over, setOver] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => { if (editing) setDraft(workspaces.find((w) => w.id === editing)?.name ?? ''); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t); }, [armed]);
  useEffect(() => { localStorage.setItem(ACTIVE_SHUT_KEY, activeShut ? '1' : '0'); }, [activeShut]);
  useEffect(() => { localStorage.setItem(PAUSED_SHUT_KEY, pausedShut ? '1' : '0'); }, [pausedShut]);

  const toggle = (id: string) => {
    if (id === activeId) { setActiveShut((v) => !v); return; }
    setOpen((cur) => {
      const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id);
      localStorage.setItem(OPEN_KEY, JSON.stringify([...n]));
      return n;
    });
  };
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(PANE_TYPE) || e.dataTransfer.types.includes(WS_TYPE);
  const drop = (e: DragEvent, id: string) => {
    e.preventDefault(); setOver(null);
    const pane = e.dataTransfer.getData(PANE_TYPE), ws = e.dataTransfer.getData(WS_TYPE);
    if (pane) onMovePane(pane, id);
    else if (ws && ws !== id) onReorder(ws, id);
  };

  const ordered = listOrder(workspaces, paused);
  const awake = ordered.filter((w) => !isAsleep(w, paused));
  const asleep = ordered.filter((w) => isAsleep(w, paused));

  const row = (w: Workspace) => {
    const active = w.id === activeId;
    const running = w.panes.filter((p) => !paused.has(p.tmux));
    const nPaused = w.panes.length - running.length;
    const sleeping = nPaused > 0 && !running.length;
    const st = summarizeStatus(running.map((p) => byTmux.get(p.tmux)?.status ?? 'ended'));
    const needs = running.filter((p) => byTmux.get(p.tmux)?.status === 'done').length;
    const shown = w.panes.length > 0 && (active ? !activeShut : open.has(w.id));
    const index = ordered.indexOf(w);
    const proposed = w.todos ? todoCounts.get(w.id)?.proposed ?? 0 : 0;
    return (
      <div key={w.id} className="wl-group">
        <div role="tab" aria-selected={active} className={`wl-ws ${active ? 'active' : ''} ${sleeping ? 'asleep' : ''} ${over === w.id ? 'drop-target' : ''}`}
          draggable={editing !== w.id}
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(WS_TYPE, w.id); }}
          onDragOver={(e) => { if (accepts(e)) { e.preventDefault(); setOver(w.id); } }}
          onDragLeave={() => setOver((o) => (o === w.id ? null : o))}
          onDrop={(e) => drop(e, w.id)}
          onClick={() => onActivate(w.id)} onDoubleClick={() => setEditing(w.id)}
          title={`${w.name}${running.length ? ` · ${running.length} running` : ''}${nPaused ? ` · ${nPaused} paused` : ''}${index < 9 ? `  ⌘${index + 1}` : ''}`}>
          <button className={`wl-caret ${shown ? 'open' : ''}`} disabled={!w.panes.length} aria-label={shown ? 'Hide sessions' : 'Show sessions'}
            onClick={(e) => { e.stopPropagation(); toggle(w.id); }} onDoubleClick={(e) => e.stopPropagation()}>▸</button>
          {sleeping ? <span className="wl-mark"><PauseIcon /></span> : <span className={`dot ${st ? `status-${st}` : 'wl-empty-dot'}`} />}
          {editing === w.id ? (
            <input className="wl-rename" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()}
              placeholder="Workspace name"
              onBlur={() => { onRename(w.id, draft.trim() || w.name); setEditing(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }}
              onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} />
          ) : <span className="wl-name">{w.name}</span>}
          {proposed > 0 && <span className="ws-todo-dot" title="New todo proposals" />}
          {needs > 0 && <span className="wl-needs" title={`${needs} need${needs === 1 ? 's' : ''} you`}>{needs}</span>}
          <span className="wl-count">{nPaused && running.length ? `${running.length}/${w.panes.length}` : w.panes.length || ''}</span>
          <span className="wl-actions">
            <button title="Rename workspace  ⌘⇧R" onClick={(e) => { e.stopPropagation(); setEditing(w.id); }}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 1.5l2 2L4 10H2V8z" /></svg>
            </button>
            <button className={armed === w.id ? 'armed' : ''}
              title={armed === w.id ? 'Click again to delete this workspace' : 'Delete workspace (running sessions keep running)'}
              onClick={(e) => { e.stopPropagation(); if (!w.panes.length || armed === w.id) { setArmed(null); onClose(w.id); } else setArmed(w.id); }}>
              {armed === w.id ? 'delete?' : '×'}
            </button>
          </span>
        </div>
        {shown && w.panes.map((p) => {
          const isPaused = paused.has(p.tmux);
          const s = byTmux.get(p.tmux) ?? paused.get(p.tmux);
          const status = isPaused ? 'idle' : s?.status ?? 'ended';
          const word = isPaused ? 'paused' : lost.has(p.tmux) ? 'stopped' : statusWord(status);
          return (
            <button key={p.tmux} className={`wl-pane agent-${p.agent} status-${status} ${isPaused ? 'paused' : ''} ${active && focused === p.tmux ? 'focused' : ''}`}
              draggable onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(PANE_TYPE, p.tmux); }}
              onClick={() => onFocusPane(p.tmux)} title={s ? `${s.title}\n${s.cwd}\nDrag onto a workspace to move it there` : p.tmux}>
              {isPaused ? <span className="wl-mark small"><PauseIcon /></span> : <span className="dot" />}
              <span className="wl-pane-title">{s?.title || s?.project || 'Session'}</span>
              <span className="wl-pane-status">{word}</span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="wl" role="tablist" aria-label="Workspaces">
      {awake.map(row)}
      {asleep.length > 0 && (
        <>
          <button className="wl-section" onClick={() => setPausedShut((v) => !v)} title="Workspaces where every session is paused. They use no memory.">
            <span className={`caret ${pausedShut ? '' : 'open'}`}>▸</span>
            <span>Paused</span>
            <span className="wl-section-count">{asleep.length}</span>
          </button>
          {!pausedShut && asleep.map(row)}
        </>
      )}
      <button className="wl-add" onClick={onCreate} title="New workspace  ⌘T">+ New workspace</button>
    </div>
  );
}
