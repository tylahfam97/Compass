import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Section heading for rule-and-space layouts: a 15px sans title, an optional hint under
 * it, and a right-hand slot for the section's controls. Uses the existing
 * .workspace-heading layout so sections line up with page headings.
 */
interface SectionHeadingProps {
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}

export default function SectionHeading({ title, hint, children, as = "h2", className }: SectionHeadingProps) {
  const Tag = as;
  return (
    <div className={cn("workspace-heading", className)}>
      <div className="min-w-0">
        <Tag className={cn("font-semibold leading-tight", as === "h3" ? "text-[13px] text-[hsl(var(--muted-foreground))]" : "text-[15px]")}>{title}</Tag>
        {hint != null && hint !== false && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
