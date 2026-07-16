import { useState } from "react";
import { Info } from "lucide-react";

/**
 * Small "i" info affordance that reveals an explanatory tooltip on hover/focus.
 * Pure CSS/JS, no positioning library - the bubble is anchored to the icon and
 * flips to a centered layout on narrow containers via Tailwind's responsive
 * translate utilities.
 */
export default function InfoTooltip({ text, className = "" }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-label="More information"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[hsl(var(--muted-foreground))]
                   hover:text-[hsl(var(--primary))] transition-colors"
      >
        <Info size={13} />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute z-30 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 text-left
                     text-[11px] leading-snug font-normal normal-case tracking-normal
                     px-3 py-2 rounded-lg shadow-lg pointer-events-none"
          style={{
            backgroundColor: "hsl(var(--foreground))",
            color: "hsl(var(--background))",
          }}
        >
          {text}
          <span
            className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 rotate-45"
            style={{ backgroundColor: "hsl(var(--foreground))" }}
          />
        </span>
      )}
    </span>
  );
}
