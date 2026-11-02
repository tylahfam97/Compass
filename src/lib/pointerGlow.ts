/**
 * Moves the hover light on clickable cards (.chart-clickable, .insight-card-hover) to follow
 * the pointer by setting --glow-x/--glow-y on the card under it. One passive listener for the
 * whole app, at most one style write per frame, and only on the hovered card. Touch input and
 * reduced motion leave the light at its resting spot (top centre).
 */
const SELECTOR = ".chart-clickable, .insight-card-hover";

export function installPointerGlow(): () => void {
  let frame = 0;
  let target: HTMLElement | null = null;
  let x = 0;
  let y = 0;
  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  const paint = () => {
    frame = 0;
    if (!target || !target.isConnected) return;
    const box = target.getBoundingClientRect();
    target.style.setProperty("--glow-x", `${Math.round(x - box.left)}px`);
    target.style.setProperty("--glow-y", `${Math.round(y - box.top)}px`);
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (reducedQuery.matches || document.documentElement.classList.contains("reduce-motion")) return;
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>(SELECTOR) : null;
    if (!card) return;
    target = card;
    x = event.clientX;
    y = event.clientY;
    if (!frame) frame = window.requestAnimationFrame(paint);
  };

  document.addEventListener("pointermove", onMove, { passive: true });
  return () => {
    document.removeEventListener("pointermove", onMove);
    if (frame) window.cancelAnimationFrame(frame);
  };
}
