import { useEffect, useState, type DragEvent } from 'react';
import type { Agent, Session, Status } from '../../../shared/types';
import { TerminalPane } from './Terminal';
import { statusWord } from './StatusStrip';

export interface Pane { tmux: string; agent: Agent; openedAt?: number }
/** `auto` marks a generated name that gets replaced by the first session's project. Renaming clears it. */
export interface Workspace { id: string; name: string; panes: Pane[]; maximized?: string | null; auto?: boolean }
export const isAutoName = (w: Workspace) => w.auto === true || /^Workspace \d+$/.test(w.name) || /^[0-9a-f]{8}$/.test(w.name);

export function gridColumns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

const RANK: Record<Status, number> = { waiting: 0, working: 1, ended: 2, idle: 3 };
export function summarizeStatus(statuses: Status[]): Status | null {
  if (!statuses.length) return null;
  return statuses.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

export function WorkspaceBar({ workspaces, activeId, byTmux, editing, setEditing, onActivate, onCreate, onRename, onClose }: {
  workspaces: Workspace[]; activeId: string; byTmux: Map<string, Session>;
  editing: string | null; setEditing: (id: string | null) => void;
  onActivate: (id: string) => void; onCreate: () => void; onRename: (id: string, name: string) => void; onClose: (id: string) => void;
}) {
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
            <span className="ws-count">{w.panes.length || ''}</span>
            <span className="ws-index">{i < 9 ? i + 1 : ''}</span>
            <span className="ws-close" title="Close workspace (sessions keep running)" onClick={(e) => { e.stopPropagation(); onClose(w.id); }}>×</span>
          </div>
        );
      })}
      <button className="ws-add" onClick={onCreate} title="New workspace">+</button>
    </div>
  );
}

export function PaneGrid({ workspace, byTmux, focused, visible, onFocus, onSwap, onMaximize, onRemove, onKill }: {
  workspace: Workspace; byTmux: Map<string, Session>; focused: string | null; visible: boolean;
  onFocus: (tmux: string) => void; onSwap: (a: string, b: string) => void; onMaximize: (tmux: string | null) => void;
  onRemove: (tmux: string) => void; onKill: (tmux: string) => void;
}) {
  const panes = workspace.panes;
  const max = workspace.maximized && panes.some((p) => p.tmux === workspace.maximized) ? workspace.maximized : null;
  const cols = max ? 1 : gridColumns(panes.length);
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
          <PaneView key={p.tmux} pane={p} session={s} focused={focused === p.tmux && visible} hidden={hidden} maximized={max === p.tmux}
            dragging={dragging === p.tmux} over={over === p.tmux}
            onFocus={() => onFocus(p.tmux)} onMaximize={() => onMaximize(max === p.tmux ? null : p.tmux)}
            onRemove={() => onRemove(p.tmux)} onKill={() => onKill(p.tmux)}
            onDragStart={() => setDragging(p.tmux)} onDragEnd={() => { setDragging(null); setOver(null); }}
            onDragOver={(e) => { if (dragging && dragging !== p.tmux) { e.preventDefault(); setOver(p.tmux); } }}
            onDragLeave={() => setOver((o) => (o === p.tmux ? null : o))}
            onDrop={(e) => { e.preventDefault(); if (dragging && dragging !== p.tmux) onSwap(dragging, p.tmux); setDragging(null); setOver(null); }}
          />
        );
      })}
    </div>
  );
}

function PaneView({ pane, session: s, focused, hidden, maximized, dragging, over, onFocus, onMaximize, onRemove, onKill, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }: {
  pane: Pane; session?: Session; focused: boolean; hidden: boolean; maximized: boolean; dragging: boolean; over: boolean;
  onFocus: () => void; onMaximize: () => void; onRemove: () => void; onKill: () => void;
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
        <span className="pane-project">{s?.project ?? pane.tmux.replace(/^ms-\w+-/, '')}</span>
        <span className="pane-title">{s?.title ?? ''}</span>
        <span className="pane-status">{statusWord(status)}</span>
        <span className="pane-actions">
          <button title={maximized ? 'Restore grid (Esc)' : 'Maximize (⌘⇧⏎)'} onClick={(e) => { e.stopPropagation(); onMaximize(); }}>{maximized ? '⤡' : '⤢'}</button>
          <button title="Remove from workspace (session keeps running)  ⌘W" onClick={(e) => { e.stopPropagation(); onRemove(); }}>−</button>
          <button className={`kill ${confirm ? 'armed' : ''}`} title="Kill the process and its tmux session" onClick={(e) => { e.stopPropagation(); killClick(); }}>{ended ? 'close' : confirm ? 'confirm kill' : 'kill'}</button>
        </span>
      </header>
      <div className="pane-body">
        <TerminalPane tmux={pane.tmux} active={focused && !hidden} agent={pane.agent} />
      </div>
    </section>
  );
}
