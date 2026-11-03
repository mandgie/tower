import type { Session } from '../../../shared/types';

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function contextLevel(pct: number): 'low' | 'mid' | 'high' {
  return pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
}

/** Where Claude Code's idle compaction point sits on the bar, in percent, or null when it does not apply. */
export function idleMark(at: number | undefined, window: number): number | null {
  return at && at < window ? (at / window) * 100 : null;
}

export function idleNote(tokens: number, at: number): string {
  return tokens >= at
    ? `Over ${fmtTokens(at)}: Claude Code compacts this conversation after about 54 minutes idle`
    : `The mark at ${fmtTokens(at)} is where Claude Code starts to compact a conversation after about 54 minutes idle`;
}

/** Context window fill after the last turn: a small bar plus percentage, always visible so nobody has to type /context. */
export function ContextBadge({ session: s }: { session: Session }) {
  const c = s.context;
  if (!c || !c.window) return null;
  const pct = Math.min(100, Math.round((c.tokens / c.window) * 100));
  const level = contextLevel(pct);
  const idle = idleMark(c.idleCompactAt, c.window);
  const title = `Context: ${fmtTokens(c.tokens)} of ${fmtTokens(c.window)} tokens (${pct}%)${c.estimated ? '\nWindow estimated from the model name; counts from the last turn' : '\nAs reported by the agent after the last turn'}${idle ? `\n${idleNote(c.tokens, c.idleCompactAt!)}` : ''}`;
  return (
    <span className={`ctx ${level}${idle && c.tokens >= c.idleCompactAt! ? ' idle-due' : ''}`} title={title} role="progressbar" aria-label="Context used" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="ctx-bar"><span className="ctx-fill" style={{ width: `${pct}%` }} />{idle && <span className="ctx-mark" style={{ left: `${idle}%` }} />}</span>
      <span className="ctx-text">{fmtTokens(c.tokens)} · {pct}%</span>
    </span>
  );
}
