import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * Import wizard stepper: numbered steps with hairline connectors. Completed steps are
 * filled ink, the current step is gold, unreached steps are outlined and disabled.
 */
interface WizardStepperProps {
  steps: { key: string; label: string }[];
  currentIndex: number;
  maxReachedIndex: number;
  onGo: (index: number) => void;
  className?: string;
}

export default function WizardStepper({ steps, currentIndex, maxReachedIndex, onGo, className }: WizardStepperProps) {
  return (
    <ol className={cn("wizard-steps", className)} aria-label="Import steps">
      {steps.map((s, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "todo";
        const reachable = i <= maxReachedIndex;
        return (
          <li key={s.key}>
            <span className="wizard-step">
              <button
                type="button"
                className="wizard-step-btn"
                data-state={state}
                aria-label={`Go to ${s.label} step`}
                aria-current={state === "current" ? "step" : undefined}
                disabled={!reachable}
                onClick={() => reachable && onGo(i)}
              >
                {state === "done" ? <CheckIcon size={12} weight="bold" aria-hidden="true" /> : i + 1}
              </button>
              <span className="wizard-step-label">{s.label}</span>
            </span>
            {i < steps.length - 1 && <span className="wizard-connector" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
