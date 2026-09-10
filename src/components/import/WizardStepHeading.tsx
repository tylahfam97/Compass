import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Step heading for the import wizard: a muted 20px icon, a plain question, an optional hint. */
interface WizardStepHeadingProps {
  icon: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "warning";
  className?: string;
}

export default function WizardStepHeading({ icon, title, hint, tone = "default", className }: WizardStepHeadingProps) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span
        className="shrink-0 mt-0.5 inline-flex w-5 h-5 items-center justify-center"
        style={{ color: tone === "warning" ? "hsl(var(--warning))" : "hsl(var(--muted-foreground))" }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold leading-tight">{title}</h2>
        {hint != null && hint !== false && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{hint}</p>}
      </div>
    </div>
  );
}
