/**
 * Brand loading indicator: a compass needle that swings past north and settles, then
 * seeks again (keyframes in index.css as `.needle-spinner`). Honest feedback for
 * in-flight work; the reduced-motion rules slow it to 2.4s rather than stopping it,
 * the same treatment Tailwind's animate-spin gets.
 */
interface NeedleSpinnerProps {
  size?: number;
  className?: string;
  /** Accessible label; omit only when adjacent text already says what is loading. */
  label?: string;
}

export default function NeedleSpinner({ size = 16, className = "", label }: NeedleSpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.2" />
      <g className="needle-spinner">
        <path d="M12 2.5 L13.6 12 L12 12 Z" fill="hsl(var(--primary))" />
        <path d="M12 2.5 L10.4 12 L12 12 Z" fill="hsl(var(--primary))" fillOpacity="0.55" />
        <path d="M12 21.5 L10.4 12 L13.6 12 Z" fill="currentColor" fillOpacity="0.35" />
      </g>
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}
