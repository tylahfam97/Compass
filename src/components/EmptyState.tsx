import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CompassOutline } from "@/components/CompassMark";

/**
 * The one empty-state pattern: a quiet monochrome mark, a serif headline, one plain
 * sentence, and the action that fills the screen. Left-aligned, no dashed box.
 */
interface EmptyStateProps {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  mark?: ReactNode;
  className?: string;
}

export default function EmptyState({ title, children, actions, mark, className }: EmptyStateProps) {
  const id = useId();
  return (
    <section className={cn("empty-state", className)} aria-labelledby={id}>
      {mark === undefined ? <CompassOutline size={40} className="text-[hsl(var(--muted-foreground))]" /> : mark}
      <h2 id={id} className="font-serif text-[22px] font-medium leading-tight mt-4">{title}</h2>
      <p className="text-sm text-[hsl(var(--muted-foreground))] mt-2 max-w-[52ch]">{children}</p>
      {actions ? <div className="flex flex-wrap items-center gap-3 mt-5">{actions}</div> : null}
    </section>
  );
}
