import type { ReactNode } from "react";
import { motion } from "motion/react";

/**
 * A segmented control whose selection glides between options: one shared pill moves under the
 * pressed button (motion layoutId), so a switch reads as the same instrument changing setting
 * rather than one button lighting up as another goes dark. Reduced motion jumps it instead.
 */
export default function Segmented<T extends string>({ id, label, value, options, onChange, size = "md" }: {
  /** Unique on the page; scopes the gliding pill. */
  id: string;
  label: string;
  value: T;
  options: readonly { id: T; label: ReactNode; icon?: ReactNode }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="seg" data-size={size} role="group" aria-label={label}>
      {options.map((option) => {
        const pressed = option.id === value;
        return (
          <button key={option.id} type="button" aria-pressed={pressed} onClick={() => { if (!pressed) onChange(option.id); }}>
            {pressed && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={{ type: "spring", stiffness: 520, damping: 42 }} />}
            <span className="seg-label">{option.icon}{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
