import { memo, useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import type { Snapshot, Session, Agent, Project } from '../../../shared/types';
import { relTime, useNow } from '../api';
import { statusWord } from './StatusStrip';
import { ALL, MachineFilterBar, MachineTag, inMachine, machineColor, machineState, type MachineFilter } from './Machine';
import { splitHost } from '../../../shared/hosts';

export function Sidebar({ snapshot, machine, onMachine, view, onView, search, onSearch, searchRef, selectedKey, onSelect, onNew, onSettings }: {
  snapshot: Snapshot | null;
  machine: MachineFilter;
  onMachine: (m: MachineFilter) => void;
  view: 'project' | 'recent';
  onView: (v: 'project' | 'recent') => void;
  search: string;
  onSearch: (s: string) => void;
  searchRef: RefObject<HTMLInputElement>;
  selectedKey: string | null;
  onSelect: (s: Session) => void;
  onNew: (cwd?: string, agent?: Agent) => void;
  onSettings: () => void;
}) {
  const now = useNow();
  // The parent's handler changes with every snapshot; a stable wrapper lets unchanged rows skip rendering.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const select = useCallback((s: Session) => onSelectRef.current(s), []);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('ms.collapsed') || '[]')));
  const toggle = (cwd: string) => setCollapsed((c) => {
    const n = new Set(c); n.has(cwd) ? n.delete(cwd) : n.add(cwd);
    localStorage.setItem('ms.collapsed', JSON.stringify([...n]));
    return n;
  });

  const sessions = snapshot?.sessions ?? [];
  const byKey = useMemo(() => new Map(sessions.map((s) => [s.key, s])), [sessions]);
  const q = search.trim().toLowerCase();
  const matches = (s: Session) => !q || [s.title, s.firstPrompt, s.lastPrompt, s.project, s.cwd, s.gitBranch, s.agentName, s.agent].some((t) => t?.toLowerCase().includes(q));

  if (!snapshot) return <aside className="sidebar"><div className="sidebar-loading">Reading sessions…</div></aside>;

  const hosts = snapshot.hosts ?? [];
  const filtered = sessions.filter((s) => inMachine(machine, s) && matches(s));
  const machineOfProject = (p: Project) => splitHost(p.cwd)?.host ?? '';

  const projectSection = (p: Project) => {
    const rows = p.sessions.map((k) => byKey.get(k)!).filter((s) => s && matches(s));
    if (q && rows.length === 0) return null;
    const open = q ? true : !collapsed.has(p.cwd);
    const live = rows.filter((s) => s.live && s.status !== 'ended');
    return (
      <section key={p.cwd} className="project">
        <div className="project-head">
          <button className="project-toggle" onClick={() => toggle(p.cwd)} title={p.cwd}>
            <span className={`caret ${open ? 'open' : ''}`}>▸</span>
            <span className="project-name">{p.name}</span>
            <span className="project-count">{live.length > 0 && <span className="live-count">{live.length} live</span>}{rows.length}</span>
          </button>
          <button className="project-new" title={`New session in ${p.name}`} onClick={() => onNew(p.cwd)}>+</button>
        </div>
        {open && rows.map((s) => <Row key={s.key} s={s} now={now} selected={selectedKey === s.key} onSelect={select} />)}
      </section>
    );
  };

  // With hosts and no machine picked, each machine gets a section of its own projects.
  const machines = machine === ALL && hosts.length ? ['', ...hosts.map((h) => h.name)] : [machine === ALL ? '' : machine];
  const byMachine = (m: string) => snapshot.projects.filter((p) => (machine === ALL && !hosts.length) || machineOfProject(p) === m);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <input ref={searchRef} className="search" placeholder="Search sessions  ⌘K" value={search} onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { onSearch(''); (e.target as HTMLInputElement).blur(); } }} />
        {hosts.length > 0 && <MachineFilterBar hosts={hosts} sessions={sessions} value={machine} onChange={onMachine} />}
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={view === 'project'} className={view === 'project' ? 'on' : ''} onClick={() => onView('project')}>Projects</button>
          <button role="tab" aria-selected={view === 'recent'} className={view === 'recent' ? 'on' : ''} onClick={() => onView('recent')}>Recent</button>
        </div>
      </div>

      <div className="list">
        {view === 'recent' ? (
          filtered.slice(0, 200).map((s) => <Row key={s.key} s={s} now={now} showProject selected={selectedKey === s.key} onSelect={select} />)
        ) : (
          machines.map((m) => {
            const projects = byMachine(m);
            const body = projects.map(projectSection);
            if (machines.length === 1) return body;
            const h = hosts.find((x) => x.name === m);
            const key = `machine:${m}`;
            const open = q ? true : !collapsed.has(key);
            const live = sessions.filter((x) => (x.host ?? '') === m && x.live && x.status !== 'ended').length;
            if (q && !body.some(Boolean)) return null;
            return (
              <div key={key} className={`machine ${m ? '' : 'local'} ${h && !h.online ? 'offline' : ''}`} style={m ? { ['--machine' as any]: machineColor(m) } : undefined}>
                <div className="machine-head">
                  <button className="machine-toggle" onClick={() => toggle(key)} title={h?.url}>
                    <span className={`caret ${open ? 'open' : ''}`}>▸</span>
                    <span className={`machine-dot ${m ? '' : 'local'} ${h && !h.online ? 'offline' : ''}`} />
                    <span className="machine-name">{m || 'This Mac'}</span>
                    <span className="machine-state">{m ? machineState(h, now) : ''}</span>
                    <span className="project-count">{live > 0 && <span className="live-count">{live} live</span>}</span>
                  </button>
                  {m && <button className="project-new" title={`New session on ${m}`} onClick={() => onNew(`@${m}:~`)}>+</button>}
                </div>
                {open && (body.some(Boolean) ? body : <div className="list-empty small">No sessions on {m || 'this Mac'} yet.</div>)}
              </div>
            );
          })
        )}
        {filtered.length === 0 && (q ? <div className="list-empty">No sessions match “{search}”.</div> : view === 'recent' && <div className="list-empty">No sessions on {machine || 'this Mac'} yet.</div>)}
      </div>

      <div className="sidebar-foot">
        <button className="btn primary" onClick={() => onNew()}>New session</button>
        <button className="btn ghost" onClick={onSettings} title="Settings  ⌘,">⚙</button>
      </div>
    </aside>
  );
}

const Row = memo(function Row({ s, now, selected, onSelect, showProject }: { s: Session; now: number; selected: boolean; onSelect: (s: Session) => void; showProject?: boolean }) {
  const external = s.live?.kind === 'external';
  return (
    <button className={`row agent-${s.agent} status-${s.status} ${selected ? 'selected' : ''} ${s.live ? 'live' : ''}`} onClick={() => onSelect(s)}
      title={`${s.title}\n${s.firstPrompt}\n\n${s.cwd}`}>
      <span className="rail" />
      <span className="row-main">
        <span className="row-title">{s.title || 'Untitled'}</span>
        <span className="row-meta">
          <span className="agent-tag">{s.agent === 'claude' ? 'Claude' : 'Codex'}</span>
          {showProject && <MachineTag host={s.host} />}
          {showProject && <span className="row-project">{s.project}</span>}
          {s.gitBranch && s.gitBranch !== 'HEAD' && <span className="branch">{s.gitBranch}</span>}
          {s.importedFrom && <span className="imported">imported</span>}
          {s.todo && <span className={`todo-tag ${s.todo.status}`} title={`Started from the todo: ${s.todo.title}`}>{s.todo.status === 'done' ? 'todo ✓' : 'todo'}</span>}
        </span>
      </span>
      <span className="row-side">
        {s.live && <span className={`dot status-${s.status} ${external ? 'external' : ''}`} title={external ? 'Running in another terminal' : statusWord(s.status)} />}
        <span className="row-time">{relTime(s.updatedAt, now)}</span>
      </span>
    </button>
  );
});
