import { useEffect } from 'react';

/**
 * iOS keeps the layout viewport when the keyboard opens; size the app to the visible part instead, and say so
 * with `kb-open` so the dock can drop the home-bar inset the keyboard covers. The desktop layout uses it in a
 * browser too, so a terminal pane on an iPad shrinks above the keyboard and its prompt stays in sight.
 */
export function useVisualViewportHeight(on = true) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !on) return;
    const root = document.documentElement;
    // A Home Screen app shrinks innerHeight with the keyboard too, so compare against the tallest height seen
    // at this width instead (reset on rotation). Pinch zoom shrinks vv.height as well; scale undoes that.
    let full = 0, width = 0;
    const update = () => {
      if (vv.width * vv.scale !== width) { width = vv.width * vv.scale; full = 0; }
      full = Math.max(full, window.innerHeight, vv.height * vv.scale);
      const kb = vv.height * vv.scale < full - 80;
      root.classList.toggle('kb-open', kb);
      if (kb) root.style.setProperty('--vvh', `${vv.height}px`);
      else root.style.removeProperty('--vvh');
      if (vv.offsetTop) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update);
      root.classList.remove('kb-open'); root.style.removeProperty('--vvh');
    };
  }, [on]);
}
