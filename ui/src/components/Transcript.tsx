import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Session, Message, Block, SessionStats } from '../../../shared/types';
import { api } from '../api';

const PAGE = 300;

export function Transcript({ session }: { session: Session }) {
  const [data, setData] = useState<{ messages: Message[]; stats: SessionStats } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [showTools, setShowTools] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll bookkeeping: jump to the newest message on load, keep position when older ones are prepended.
  const pendingRef = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number; top: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null); setError(null); setLimit(PAGE);
    pendingRef.current = { kind: 'bottom' };
    api.transcript(session.agent, session.id).then((r) => { if (alive) setData(r); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [session.agent, session.id, session.updatedAt]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const p = pendingRef.current;
    if (!el || !p || !data) return;
    if (p.kind === 'bottom') el.scrollTop = el.scrollHeight;
    else el.scrollTop = p.top + (el.scrollHeight - p.height);
    pendingRef.current = null;
  });

  const showEarlier = () => {
    const el = scrollRef.current;
    if (el) pendingRef.current = { kind: 'keep', height: el.scrollHeight, top: el.scrollTop };
    setLimit((l) => l + PAGE);
  };

  if (error) return <div className="transcript"><div className="notice">Could not read transcript: {error}</div></div>;
  if (!data) return <div className="transcript"><div className="notice muted">Reading transcript…</div></div>;

  const { messages, stats } = data;
  const visible = showTools ? messages : messages.filter((m) => m.blocks.some((b) => b.type === 'text' || b.type === 'thinking'));
  const start = Math.max(0, visible.length - limit);
  const slice = visible.slice(start);

  return (
    <>
      <div className="stats-wrap"><StatsStrip stats={stats} agent={session.agent} /></div>
      <div className="transcript" ref={scrollRef}>
      <div className="transcript-bar">
        <span className="muted">{messages.length} entries</span>
        <label className="check"><input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> Show tool calls</label>
      </div>
      {start > 0 && <button className="btn ghost wide" onClick={showEarlier}>Show {Math.min(PAGE, start)} earlier</button>}
      {slice.map((m, i) => <Msg key={start + i} m={m} agent={session.agent} />)}
      {messages.length === 0 && <div className="notice muted">This session has no messages yet.</div>}
      </div>
    </>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
function fmtBytes(b: number): string {
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}
function fmtSpan(a?: number, b?: number): string {
  if (!a || !b) return '';
  const same = new Date(a).toDateString() === new Date(b).toDateString();
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return same ? new Date(a).toLocaleDateString(undefined, opts) : `${new Date(a).toLocaleDateString(undefined, opts)} to ${new Date(b).toLocaleDateString(undefined, opts)}`;
}

function StatsStrip({ stats, agent }: { stats: SessionStats; agent: Session['agent'] }) {
  const ctx = stats.contextTokens;
  const win = stats.contextWindow;
  const pct = ctx && win ? Math.min(100, Math.round((ctx / win) * 100)) : null;
  const level = pct == null ? '' : pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
  const facts: { label: string; value: string; title?: string }[] = [];
  facts.push({ label: 'turns', value: String(stats.turns), title: 'Prompts you sent' });
  facts.push({ label: 'tool calls', value: String(stats.toolCalls) });
  if (stats.filesTouched) facts.push({ label: 'files edited', value: String(stats.filesTouched) });
  if (stats.subagents) facts.push({ label: 'sub-agents', value: String(stats.subagents) });
  if (stats.compactions) facts.push({ label: stats.compactions === 1 ? 'compaction' : 'compactions', value: String(stats.compactions), title: 'Times the conversation was summarized to free context' });
  if (stats.outputTokens) facts.push({ label: 'generated', value: `${fmtTokens(stats.outputTokens)} tok`, title: 'Output tokens across the whole session' });
  if (stats.activeMs) facts.push({ label: 'active', value: fmtDuration(stats.activeMs), title: 'Time between messages, ignoring breaks over 30 minutes' });
  if (stats.bytes) facts.push({ label: 'on disk', value: fmtBytes(stats.bytes) });
  const span = fmtSpan(stats.firstAt, stats.lastAt);

  return (
    <div className={`stats agent-${agent}`}>
      <div className="stats-context">
        {ctx != null && win ? (
          <>
            <div className="stats-context-head">
              <span className="stats-label">Context on resume</span>
              <span className={`stats-value ${level}`}>{fmtTokens(ctx)} <span className="muted">of {fmtTokens(win)}{stats.contextEstimated ? ' est.' : ''} · {pct}%</span></span>
            </div>
            <div className="stats-bar" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <span className={`stats-fill ${level}`} style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : (
          <div className="stats-context-head"><span className="stats-label">Context on resume</span><span className="muted">unknown</span></div>
        )}
      </div>
      <div className="stats-facts">
        {facts.map((f) => (
          <span key={f.label} className="fact" title={f.title}><b>{f.value}</b> {f.label}</span>
        ))}
        {span && <span className="fact muted">{span}</span>}
      </div>
    </div>
  );
}

function Msg({ m, agent }: { m: Message; agent: Session['agent'] }) {
  const onlyTools = m.blocks.every((b) => b.type === 'tool_use' || b.type === 'tool_result');
  return (
    <div className={`msg role-${m.role} ${onlyTools ? 'tools-only' : ''} agent-${agent}`}>
      {!onlyTools && <div className="msg-role">{m.role === 'user' ? 'You' : m.role === 'assistant' ? (agent === 'claude' ? 'Claude' : 'Codex') : 'System'}{m.ts ? <time>{new Date(m.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : null}</div>}
      {m.blocks.map((b, i) => <BlockView key={i} b={b} />)}
    </div>
  );
}

function BlockView({ b }: { b: Block }) {
  const [open, setOpen] = useState(false);
  if (b.type === 'text') return <div className="blk text">{b.text}</div>;
  if (b.type === 'thinking') return (
    <details className="blk thinking"><summary>Thinking</summary><div>{b.text}</div></details>
  );
  if (b.type === 'tool_use') return (
    <div className="blk tool" onClick={() => setOpen((o) => !o)}>
      <span className="tool-name">{b.name}</span>
      <span className={`tool-input ${open ? 'open' : ''}`}>{b.input}</span>
    </div>
  );
  return (
    <details className={`blk result ${b.isError ? 'error' : ''}`}>
      <summary>{b.isError ? 'Error' : 'Result'} <span className="muted">{b.text.length > 200 ? `${b.text.length} chars` : ''}</span></summary>
      <pre>{b.text}</pre>
    </details>
  );
}
