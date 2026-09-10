/**
 * Profile / Global scope switch shared by Overview, Trends, Budgets and Insights.
 *
 * Gold is the app's "your hand is on the instrument" color, so the track goes gold when
 * the wider Global scope is switched on and rests on a neutral when it is off - the two
 * states must never share a hue or the switch stops reading as a switch.
 */
interface ScopeToggleProps {
  isGlobal: boolean;
  onToggle: () => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}

export default function ScopeToggle({ isGlobal, onToggle, size = "md", ariaLabel }: ScopeToggleProps) {
  const trackW = size === "sm" ? 40 : 52;
  const trackH = size === "sm" ? 22 : 28;
  const thumbS = size === "sm" ? 16 : 22;
  const travel = trackW - 6 - thumbS;
  return (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel}
      aria-checked={isGlobal}
      onClick={onToggle}
      style={{
        width: trackW,
        height: trackH,
        borderRadius: trackH / 2,
        padding: 3,
        backgroundColor: isGlobal ? "hsl(var(--primary))" : "hsl(var(--neutral) / 0.55)",
        transition: "background-color 0.3s",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        border: "none",
        flexShrink: 0,
        boxShadow: "inset 0 1px 2px hsl(var(--shadow-ink) / 0.25)",
      }}
    >
      <span
        style={{
          width: thumbS,
          height: thumbS,
          borderRadius: thumbS / 2,
          backgroundColor: "hsl(var(--surface))",
          transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
          transform: isGlobal ? `translateX(${travel}px)` : "translateX(0)",
          boxShadow: "var(--shadow-panel)",
          flexShrink: 0,
        }}
      />
    </button>
  );
}
