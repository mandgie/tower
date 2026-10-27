import { useEffect, useRef, type RefObject } from 'react';
import { api } from '../api';

/**
 * Turns vertical touch drags and wheel input on `ref` into pane scroll steps, since a touch screen never
 * sends the wheel events a full-screen agent scrolls on. With `edges`, the element scrolls natively
 * first and only a drag past its top or bottom goes to the pane.
 */
export function useDragScroll(ref: RefObject<HTMLElement>, tmux: string, opts: { active: boolean; edges: boolean; wheel?: boolean; after?: (lines: number) => void; step?: () => number }) {
  const after = useRef(opts.after);
  after.current = opts.after;
  const step = useRef(opts.step);
  step.current = opts.step;
  useEffect(() => {
    const el = ref.current;
    if (!el || !opts.active) return;
    let lastX = 0, lastY = 0, acc = 0, pending = 0;
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
      // px of drag per pane line, so the text keeps up with the finger
      const STEP = step.current?.() || 14;
      acc += dy;
      while (Math.abs(acc) >= STEP) { const d = Math.sign(acc); pending += d; acc -= d * STEP; }
      if (pending && !timer) timer = setTimeout(flush, 30);
      return true;
    };
    const onStart = (e: TouchEvent) => { lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; acc = 0; };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const dx = x - lastX, dy = y - lastY; lastX = x; lastY = y;
      // A sideways drag scrolls a wide table, not the pane.
      if (Math.abs(dx) > Math.abs(dy)) return;
      if (drag(dy) && e.cancelable) e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => { if (drag(-e.deltaY)) { e.preventDefault(); e.stopPropagation(); } };
    // Capture phase, so xterm never sees the gesture as a selection or its own scroll.
    el.addEventListener('touchstart', onStart, { passive: true, capture: true });
    el.addEventListener('touchmove', onMove, { passive: false, capture: true });
    if (opts.wheel !== false) el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener('touchstart', onStart, { capture: true });
      el.removeEventListener('touchmove', onMove, { capture: true });
      el.removeEventListener('wheel', onWheel, { capture: true });
      clearTimeout(timer);
    };
  }, [ref, tmux, opts.active, opts.edges, opts.wheel]);
}
