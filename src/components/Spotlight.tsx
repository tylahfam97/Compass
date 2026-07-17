import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { ONBOARDING_STEPS } from "@/lib/onboardingSteps";

const MAX_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 80;

type Align = "flex-start" | "center" | "flex-end";

/**
 * Renders the currently-active onboarding step: either a centered modal (Welcome/Finish,
 * or any step whose target element can't be found on screen) or a real spotlight - a
 * dimmed backdrop with a cutout box over the target element, plus a callout card nearby.
 *
 * The callout is positioned with plain CSS flexbox alignment (justify/align on a
 * `fixed inset-0` container) rather than manual pixel math - flexbox physically cannot
 * place a child outside its container, so the card can never render off-screen, no
 * matter what the target's on-page position, scroll offset, or window size is.
 */
export default function Spotlight() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeStepId = useOnboardingStore((s) => s.activeStepId);
  const markVisited = useOnboardingStore((s) => s.markVisited);
  const closeSpotlight = useOnboardingStore((s) => s.closeSpotlight);

  // Tagged with the step id it was measured for, so a stale rect/searching value from a
  // previous step can never briefly get applied to the new step while effects settle.
  const [targetState, setTargetState] = useState<{ stepId: string; rect: DOMRect | null; searching: boolean }>(
    { stepId: "", rect: null, searching: true }
  );

  const step = activeStepId ? ONBOARDING_STEPS.find((s) => s.id === activeStepId) ?? null : null;
  const isCurrent = !!step && targetState.stepId === step.id;
  const rect = isCurrent ? targetState.rect : null;
  const searching = isCurrent ? targetState.searching : !!step?.target;

  // Navigate to the step's route first, if it lives on a different page.
  useEffect(() => {
    if (!step?.route) return;
    if (location.pathname !== step.route) {
      navigate(step.route);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  // Poll for the target element (routes render asynchronously), then measure it. Every
  // update is tagged with this step's id up front so stale data from the previous step
  // is never mistaken for this one.
  useEffect(() => {
    if (!step) return;
    if (!step.target) {
      setTargetState({ stepId: step.id, rect: null, searching: false });
      return;
    }
    setTargetState({ stepId: step.id, rect: null, searching: true });
    let cancelled = false;
    let found = false;
    const start = performance.now();

    // Re-measures the already-found target - used for resize/scroll follow-up, never
    // triggers another scroll (would otherwise fight the user's own scrolling).
    const remeasure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) setTargetState({ stepId: step.id, rect: el.getBoundingClientRect(), searching: false });
    };

    const tick = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        found = true;
        // The target may be scrolled out of view (e.g. lower on a long page) - scroll it
        // into the viewport first, then measure once the scroll has settled.
        el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
        requestAnimationFrame(() => {
          if (cancelled) return;
          setTargetState({ stepId: step.id, rect: el.getBoundingClientRect(), searching: false });
        });
        return;
      }
      if (performance.now() - start > MAX_WAIT_MS) {
        setTargetState({ stepId: step.id, rect: null, searching: false }); // give up - falls back to a centered card, no highlight
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();

    const onResizeOrScroll = () => { if (found) remeasure(); };
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
    markVisited(step.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id, searching]);

  if (!step) return null;

  const showHighlight = !!rect;

  // Coarse quadrant-based alignment (no pixel math, so no way to overflow the screen).
  // Pick which edge of the viewport the card should hug, based on where the target
  // actually is right now - falls back to dead-center when there's no target.
  let justify: Align = "center";
  let align: Align = "center";
  if (rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const horizontal = step.placement === "left" || step.placement === "right";

    if (horizontal) {
      justify = cx < vw / 2 ? "flex-start" : "flex-end";
      align = cy < vh / 3 ? "flex-start" : cy > (vh * 2) / 3 ? "flex-end" : "center";
    } else {
      align = cy < vh / 2 ? "flex-start" : "flex-end";
      justify = cx < vw / 3 ? "flex-start" : cx > (vw * 2) / 3 ? "flex-end" : "center";
    }
  }

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

      {/* Callout card - flexbox alignment guarantees it stays fully within the viewport. */}
      <div
        className="fixed inset-0 z-[101] flex p-6"
        style={{ justifyContent: justify, alignItems: align }}
      >
        <div className="w-80 max-w-[90vw] max-h-[80vh] overflow-y-auto bg-[hsl(var(--background))] border rounded-2xl shadow-2xl p-5">
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
    </div>
  );
}
