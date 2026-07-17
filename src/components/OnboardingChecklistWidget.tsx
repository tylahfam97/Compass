import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, ChevronDown, Sparkles, X } from "lucide-react";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { ONBOARDING_STEPS } from "@/lib/onboardingSteps";

/**
 * Floating "Getting Started" checklist - lets the user open any of the 8 onboarding steps
 * directly, in any order, via Spotlight. Shows a full welcome card the very first time
 * (nothing visited yet), then reappears minimized on later launches until every step has
 * been visited or "Don't show again" is checked.
 */
export default function OnboardingChecklistWidget() {
  const visitedSteps = useOnboardingStore((s) => s.visitedSteps);
  const dismissedForever = useOnboardingStore((s) => s.dismissedForever);
  const activeStepId = useOnboardingStore((s) => s.activeStepId);
  const checklistOpen = useOnboardingStore((s) => s.checklistOpen);
  const isComplete = useOnboardingStore((s) => s.isComplete());
  const markVisited = useOnboardingStore((s) => s.markVisited);
  const dismissForever = useOnboardingStore((s) => s.dismissForever);
  const startStep = useOnboardingStore((s) => s.startStep);
  const setChecklistOpen = useOnboardingStore((s) => s.setChecklistOpen);

  const [minimized, setMinimized] = useState(true);

  if (dismissedForever || isComplete) return null;
  // Hide the widget while a spotlight is actively open so the two don't visually stack.
  if (activeStepId) return null;

  const neverEngaged = visitedSteps.size === 0;
  const visitedCount = visitedSteps.size;
  const total = ONBOARDING_STEPS.length;

  // ── First-run welcome card ──────────────────────────────────────────────
  if (neverEngaged && !checklistOpen) {
    const welcome = ONBOARDING_STEPS[0];
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40">
        <div className="bg-[hsl(var(--background))] border rounded-2xl shadow-2xl w-full max-w-md p-6">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={18} style={{ color: "var(--gold)" }} />
            <h2 className="text-lg font-semibold">{welcome.title}</h2>
          </div>
          <p className="text-sm text-[hsl(var(--muted-foreground))] leading-relaxed mb-6">
            {welcome.description}
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                markVisited("welcome");
                setChecklistOpen(true);
                setMinimized(false);
              }}
              className="px-4 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors"
            >
              Skip for now
            </button>
            <button
              onClick={() => {
                markVisited("welcome");
                startStep(ONBOARDING_STEPS[1].id);
                setMinimized(false);
              }}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90 transition-opacity"
              style={{ backgroundColor: "var(--gold)" }}
            >
              Start Tour
            </button>
          </div>
          <button
            onClick={() => { markVisited("welcome"); dismissForever(); }}
            className="w-full text-center text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] mt-3 transition-colors"
          >
            Don't show this again
          </button>
        </div>
      </div>
    );
  }

  // ── Minimized pill ↔ expanded checklist ──────────────────────────────────
  return (
    <AnimatePresence mode="wait">
      {minimized ? (
        <motion.button
          key="pill"
          initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.15 }}
          onClick={() => setMinimized(false)}
          className="fixed bottom-5 right-5 z-[90] flex items-center gap-2 px-4 py-2.5 rounded-full
                     border shadow-lg bg-[hsl(var(--background))] hover:bg-[hsl(var(--muted))] transition-colors text-sm font-medium"
          style={{ borderColor: "var(--gold)" }}
        >
          <Sparkles size={14} style={{ color: "var(--gold)" }} />
          Getting Started
          <span className="text-[hsl(var(--muted-foreground))]">{visitedCount}/{total}</span>
        </motion.button>
      ) : (
        // NOTE: keep `border`/`rounded-2xl` off this outer `fixed` element - a global decorative-
        // ring rule (index.css) targets `.border.rounded-2xl` with higher specificity than the
        // `.fixed` utility and forces `position: relative` on any element with both classes,
        // silently breaking fixed positioning. That styling lives on the inner div instead.
        <motion.div
          key="panel"
          initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
          className="fixed bottom-5 right-5 z-[90] w-72 overflow-hidden"
        >
          <div className="bg-[hsl(var(--background))] border rounded-2xl shadow-2xl overflow-hidden" style={{ borderColor: "var(--gold)" }}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm flex items-center gap-1.5">
                <Sparkles size={14} style={{ color: "var(--gold)" }} />
                Getting Started
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setMinimized(true)} title="Minimize" className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors">
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>

            <div className="max-h-80 overflow-y-auto py-1">
              {ONBOARDING_STEPS.map((step) => {
                const done = visitedSteps.has(step.id);
                return (
                  <button
                    key={step.id}
                    onClick={() => startStep(step.id)}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-left text-sm hover:bg-[hsl(var(--muted))] transition-colors"
                  >
                    <span
                      className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${done ? "border-transparent" : ""}`}
                      style={done ? { backgroundColor: "var(--gold)" } : undefined}
                    >
                      {done && <Check size={10} className="text-white" />}
                    </span>
                    <span className={done ? "text-[hsl(var(--muted-foreground))] line-through" : ""}>{step.title}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between px-4 py-2.5 border-t">
              <button
                onClick={dismissForever}
                className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors flex items-center gap-1"
              >
                <X size={11} /> Don't show again
              </button>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">{visitedCount}/{total}</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
