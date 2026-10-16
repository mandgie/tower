import { useEffect, useRef, useState } from 'react';
import type { Session, Todo, TodoScan, TodoStatus } from '../../../shared/types';
import { api, relTime } from '../api';

/**
 * The active workspace's todos, beside the grid. The finder (server/todos.ts) proposes; the user accepts
 * or rejects, and ticks accepted ones off. Finished and rejected ones stay one click away.
 */
export function TodoPanel({ workspace, todos, scan, byKey, byTmux, focus, onToggle, onOpenSession, onStart, onClose }: {
  workspace: { id: string; name: string; todos?: boolean };
  focus?: { id: string; at: number } | null;  // a todo to scroll to and flash (from a session's Todo badge)
  todos: Todo[]; scan?: TodoScan; byKey: Map<string, Session>; byTmux: Map<string, Session>;
  onToggle: (on: boolean) => void; onOpenSession: (s: Session) => void; onStart: (t: Todo) => Promise<void>; onClose: () => void;
}) {
  const [starting, setStarting] = useState<string | null>(null);
  const start = async (t: Todo) => {
    setStarting(t.id);
    try { await onStart(t); } catch (e) { setErr((e as Error).message); } finally { setStarting(null); }
  };
  /** The session started for a todo, while it runs: the key is known at launch; the tmux name follows renames. */
  const runner = (t: Todo) => (t.startedIn ? byKey.get(t.startedIn.key) ?? byTmux.get(t.startedIn.tmux) : undefined);
  const [showOld, setShowOld] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    const t = todos.find((x) => x.id === focus.id);
    if (t && (t.status === 'done' || t.status === 'rejected')) setShowOld(true);
    // After the list renders (the finished list may just have opened).
    const r = requestAnimationFrame(() => {
      const el = body.current?.querySelector<HTMLElement>(`[data-todo="${focus.id}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    });
    return () => cancelAnimationFrame(r);
  }, [focus?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState<string | null>(null);
  const set = (t: Todo, status: TodoStatus) => api.setTodo(t.id, status).catch((e) => setErr((e as Error).message));
  const proposed = todos.filter((t) => t.status === 'proposed').sort((a, b) => b.createdAt - a.createdAt);
  const accepted = todos.filter((t) => t.status === 'accepted').sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0));
  const old = todos.filter((t) => t.status === 'done' || t.status === 'rejected').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  const source = (t: Todo) => {
    const s = byKey.get(t.session);
    return (
      <button className="todo-source" disabled={!s} onClick={() => s && onOpenSession(s)} title={s ? 'Open the session' : 'The session is gone'}>
        <span className={`dot ${s ? `status-${s.status}` : 'status-ended'}`} />
        <span className="todo-source-title">{t.sessionTitle}</span>
      </button>
    );
  };

  return (
    <aside className="todos" aria-label="Todos">
      <header className="todos-head">
        <div>
          <div className="todos-title">Todos</div>
          <div className="todos-sub">{workspace.name}</div>
        </div>
        {workspace.todos && (
          <label className="switch" title="Find todos in this workspace's Claude sessions">
            <input type="checkbox" checked onChange={() => onToggle(false)} /><span />
          </label>
        )}
        <button className="todos-close" onClick={onClose} title="Hide todos">×</button>
      </header>

      {!workspace.todos ? (
        <div className="todos-off">
          <p>Tower can read the Claude sessions in this workspace and propose the work they leave open: a skipped test, a failed build, a “later” from you.</p>
          <p className="muted small">It reads a session after it has been quiet for 3 minutes, with <code>claude -p</code>. It never types into a session. You accept or reject each todo.</p>
          <button className="btn primary" onClick={() => onToggle(true)}>Find todos in this workspace</button>
        </div>
      ) : (
        <>
          <div className="todos-scan">
            {scan?.running ? <span className="todos-spin">Reading sessions…</span>
              : <span className="muted">{scan?.lastAt ? `Read ${relTime(scan.lastAt)}` : 'Not read yet'}</span>}
            <button className="btn ghost small" disabled={scan?.running} onClick={() => api.scanTodos(workspace.id).catch((e) => setErr((e as Error).message))}>Scan now</button>
          </div>
          {(scan?.error || err) && <div className="todos-error">{err || scan?.error}</div>}

          <div className="todos-body" ref={body}>
            {proposed.length > 0 && <section>
              <h3>Proposed <span className="todos-n">{proposed.length}</span></h3>
              {proposed.map((t) => (
                <article key={t.id} data-todo={t.id} className="todo-card">
                  <div className="todo-title">{t.title}</div>
                  {t.detail && <div className="todo-detail">{t.detail}</div>}
                  <blockquote className="todo-quote">{t.quote}</blockquote>
                  <div className="todo-foot">
                    {source(t)}
                    <span className="todo-age">{relTime(t.createdAt)}</span>
                  </div>
                  <div className="todo-actions">
                    <button className="btn small primary" onClick={() => set(t, 'accepted')}>Accept</button>
                    <button className="btn small ghost" onClick={() => set(t, 'rejected')}>Reject</button>
                  </div>
                </article>
              ))}
            </section>}

            <section>
              <h3>To do <span className="todos-n">{accepted.length}</span></h3>
              {accepted.length === 0 && <p className="todos-empty">{proposed.length ? 'Accept a proposal to put it here.' : 'Nothing open. Proposals show up here after a session goes quiet.'}</p>}
              {accepted.map((t) => (
                <div key={t.id} data-todo={t.id} className="todo-row">
                  <button className="todo-check" title="Mark done" onClick={() => set(t, 'done')} />
                  <div className="todo-row-main">
                    <div className="todo-title">{t.title}</div>
                    {t.detail && <div className="todo-detail">{t.detail}</div>}
                    <div className="todo-foot">{source(t)}</div>
                    {t.startedIn?.worktree && (
                      <div className="todo-branch" title={`Worktree: ${t.startedIn.worktree.path}\nMade from ${t.startedIn.worktree.base}`}>
                        Branch <code>{t.startedIn.worktree.branch}</code>
                      </div>
                    )}
                    {t.finished && !t.finished.dismissed && (
                      <div className="todo-finished">
                        <div className="todo-finished-head">The session reports that it is done <span className="todo-age">{relTime(t.finished.at)}</span></div>
                        {t.finished.text && <div className="todo-finished-text">{t.finished.text}</div>}
                        <div className="todo-actions">
                          <button className="btn small primary" onClick={() => set(t, 'done')}>Mark done</button>
                          <button className="btn small ghost" onClick={() => api.dismissFinish(t.id).catch((e) => setErr((e as Error).message))}>Not yet</button>
                        </div>
                      </div>
                    )}
                    {(() => {
                      const r = runner(t);
                      if (r && r.live && r.status !== 'ended') return (
                        <button className="todo-runner" onClick={() => onOpenSession(r)} title="Open the session that works on this todo">
                          <span className={`dot status-${r.status}`} /><span>Session {r.status === 'working' ? 'working' : r.status === 'done' ? 'finished a turn' : 'open'}</span>
                        </button>
                      );
                      return (
                        <button className="btn small todo-start" disabled={starting === t.id} onClick={() => start(t)}
                          title="Start a Claude session with the todo as its first prompt, in its own git worktree when the folder is a git repository">
                          {starting === t.id ? 'Starting…' : t.startedIn ? 'Start again' : '▶ Start session'}
                        </button>
                      );
                    })()}
                  </div>
                  <button className="todo-x" title="Remove (reject)" onClick={() => set(t, 'rejected')}>×</button>
                </div>
              ))}
            </section>

            {old.length > 0 && <section>
              <button className="todos-old-toggle" onClick={() => setShowOld((v) => !v)}>
                {showOld ? 'Hide' : 'Show'} finished and rejected <span className="todos-n">{old.length}</span>
              </button>
              {showOld && old.map((t) => (
                <div key={t.id} data-todo={t.id} className={`todo-row old ${t.status}`}>
                  <span className={`todo-check ${t.status === 'done' ? 'on' : 'off'}`} />
                  <div className="todo-row-main"><div className="todo-title">{t.title}</div></div>
                  <button className="btn ghost small" onClick={() => set(t, t.status === 'done' ? 'accepted' : 'proposed')}>Undo</button>
                </div>
              ))}
            </section>}
          </div>
        </>
      )}
    </aside>
  );
}
