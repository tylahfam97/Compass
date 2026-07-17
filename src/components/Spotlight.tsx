import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { ONBOARDING_STEPS } from "@/lib/onboardingSteps";

const MAX_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 80;
const CALLOUT_GAP = 14;
const VIEWPORT_MARGIN = 12;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Renders the currently-active onboarding step: either a centered modal (Welcome/Finish,
 * or any step whose target element can't be found on screen) or a real spotlight - a
 * dimmed backdrop with a cutout box positioned exactly over the target element, plus a
 * callout card explaining that feature. Marks the step "visited" as soon as it's shown,
 * regardless of which button the user eventually clicks to close it.
 */
export default function Spotlight() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeStepId = useOnboardingStore((s) => s.activeStepId);
  const markVisited = useOnboardingStore((s) => s.markVisited);
  const closeSpotlight = useOnboardingStore((s) => s.closeSpotlight);

  const [rect, setRect] = useState<DOMRect | null>(null);
  const [searching, setSearching] = useState(true);
  const markedRef = useRef<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardStyle, setCardStyle] = useState<React.CSSProperties>({
    top: "50%", left: "50%", transform: "translate(-50%, -50%)",
  });

  const step = activeStepId ? ONBOARDING_STEPS.find((s) => s.id === activeStepId) ?? null : null;

  // Navigate to the step's route first, if it lives on a different page.
  useEffect(() => {
    if (!step?.route) return;
    if (location.pathname !== step.route) {
      navigate(step.route);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  // Poll for the target element (routes render asynchronously), then measure it.
  useEffect(() => {
    setRect(null);
    if (!step || !step.target) { setSearching(false); return; }
    setSearching(true);
    let cancelled = false;
    const start = performance.now();

    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        setRect(el.getBoundingClientRect());
        setSearching(false);
        return true;
      }
      return false;
    };

    const tick = () => {
      if (cancelled) return;
      if (measure()) return;
      if (performance.now() - start > MAX_WAIT_MS) {
        setSearching(false); // give up - falls back to a centered card, no highlight
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();

    const onResizeOrScroll = () => measure();
    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, true);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
    };
  }, [step, location.pathname]);

  // Mark the step visited as soon as it's actually shown (target found, or we've given up
  // searching and are showing the fallback centered card either way).
  useEffect(() => {
    if (!step) return;
    if (step.target && searching) return; // still looking - don't mark yet
    if (markedRef.current === step.id) return;
    markedRef.current = step.id;
    markVisited(step.id);
  }, [step, searching, markVisited]);

  const showHighlight = !!rect;

  // Compute the callout's position from the card's own measured size, then clamp it to
  // stay fully within the viewport - prevents the card (and its buttons) from rendering
  // partially or fully off-screen when the target sits near a screen edge.
  useLayoutEffect(() => {
    const recalc = () => {
      const cardEl = cardRef.current;
      if (!cardEl) return;
      const cw = cardEl.offsetWidth;
      const ch = cardEl.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (!rect) {
        setCardStyle({ top: "50%", left: "50%", transform: "translate(-50%, -50%)" });
        return;
      }

      let top: number;
      let left: number;
      switch (step?.placement) {
        case "left":
          top = rect.top + rect.height / 2 - ch / 2;
          left = rect.left - CALLOUT_GAP - cw;
          break;
        case "top":
          top = rect.top - CALLOUT_GAP - ch;
          left = rect.left + rect.width / 2 - cw / 2;
          break;
        case "bottom":
          top = rect.bottom + CALLOUT_GAP;
          left = rect.left + rect.width / 2 - cw / 2;
          break;
        default: // right
          top = rect.top + rect.height / 2 - ch / 2;
          left = rect.right + CALLOUT_GAP;
          break;
      }

      top = clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vh - ch - VIEWPORT_MARGIN));
      left = clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vw - cw - VIEWPORT_MARGIN));
      setCardStyle({ top, left, transform: "none" });
    };

    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, [rect, step]);

  if (!step) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop - only a flat dim when there's no real target to cut out around */}
      {!showHighlight && <div className="absolute inset-0 bg-black/50" />}

      {/* Highlight cutout - a transparent box exactly over the target, whose box-shadow
          darkens everything else in the viewport in one paint (no clip-path/mask needed). */}
      {showHighlight && rect && (
        <div
          className="fixed rounded-lg pointer-events-none transition-all duration-200"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            border: "2px solid var(--gold)",
          }}
        />
      )}

      {/* Callout card */}
      <div
        ref={cardRef}
        className="fixed z-[101] w-80 max-w-[90vw] bg-[hsl(var(--background))] border rounded-2xl shadow-2xl p-5 transition-all duration-200"
        style={cardStyle}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="font-semibold text-base leading-snug">{step.title}</h3>
          <button
            onClick={closeSpotlight}
            aria-label="Close"
            className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] leading-relaxed mb-4">
          {step.description}
        </p>
        <div className="flex gap-2 justify-end">
          {step.actionLabel && step.actionRoute && (
            <button
              onClick={() => { navigate(step.actionRoute!); closeSpotlight(); }}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white hover:opacity-90 transition-opacity"
              style={{ backgroundColor: "var(--gold)" }}
            >
              {step.actionLabel}
            </button>
          )}
          <button
            onClick={closeSpotlight}
            className="px-4 py-1.5 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
