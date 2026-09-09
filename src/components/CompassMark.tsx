import { useId } from "react";

/**
 * The Compass mark, inline. Geometry and colors are the app icon
 * (src-tauri/icons/icon.svg) so the sidebar, launch screen and favicon are the same
 * object; rendering it as SVG keeps it crisp at every size and lets the rail show the
 * mark alone. Brand colors are fixed: a navy disc with a brass bezel reads correctly on
 * both the night and the paper theme. The icon's glow filter is dropped here because it
 * muddies the needle below ~48px. Gradient ids come from useId() since the mark renders
 * more than once per page.
 */
interface CompassMarkProps {
  size?: number;
  className?: string;
  /** Set when the mark is the only thing naming the app (e.g. the collapsed rail). */
  title?: string;
}

export default function CompassMark({ size = 28, className, title }: CompassMarkProps) {
  const id = useId().replace(/:/g, "");
  const bg = `${id}-bg`;
  const bezel = `${id}-bezel`;
  const north = `${id}-north`;
  const hub = `${id}-hub`;
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <radialGradient id={bg} cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#1C2E54" />
          <stop offset="100%" stopColor="#070D1E" />
        </radialGradient>
        <linearGradient id={bezel} x1="15%" y1="5%" x2="85%" y2="95%">
          <stop offset="0%" stopColor="#F0D068" />
          <stop offset="40%" stopColor="#C08A1C" />
          <stop offset="100%" stopColor="#7C5208" />
        </linearGradient>
        <linearGradient id={north} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#C08A1C" />
          <stop offset="55%" stopColor="#FFD050" />
          <stop offset="100%" stopColor="#D09820" />
        </linearGradient>
        <radialGradient id={hub} cx="33%" cy="28%" r="70%">
          <stop offset="0%" stopColor="#F0D068" />
          <stop offset="55%" stopColor="#C08A1C" />
          <stop offset="100%" stopColor="#7C5208" />
        </radialGradient>
      </defs>
      <circle cx="256" cy="256" r="256" fill={`url(#${bg})`} />
      <circle cx="256" cy="256" r="244" fill="none" stroke="#C08A1C" strokeWidth="1.5" opacity="0.35" />
      <circle cx="256" cy="256" r="234" fill="none" stroke={`url(#${bezel})`} strokeWidth="6" />
      <g stroke="#F0D068" strokeWidth="5.5" strokeLinecap="round">
        <line x1="256" y1="28" x2="256" y2="43" />
        <line x1="256" y1="469" x2="256" y2="484" />
        <line x1="469" y1="256" x2="484" y2="256" />
        <line x1="28" y1="256" x2="43" y2="256" />
      </g>
      <g stroke="#C08A1C" strokeWidth="3.5" strokeLinecap="round" opacity="0.8">
        <line x1="417" y1="95" x2="409" y2="103" />
        <line x1="417" y1="417" x2="409" y2="409" />
        <line x1="95" y1="417" x2="103" y2="409" />
        <line x1="95" y1="95" x2="103" y2="103" />
      </g>
      <path d="M256,74 L256,256 L238,248 Z" fill="#9C6E0E" />
      <path d="M256,74 L274,248 L256,256 Z" fill={`url(#${north})`} />
      <path d="M256,438 L238,264 L256,256 Z" fill="#1C2E54" />
      <path d="M256,438 L256,256 L274,264 Z" fill="#0A1428" />
      <path d="M416,256 L268,240 L256,256 L268,272 Z" fill="#B07C10" opacity="0.88" />
      <path d="M96,256 L244,240 L256,256 L244,272 Z" fill="#B07C10" opacity="0.88" />
      <circle cx="256" cy="256" r="27" fill="#050C1A" />
      <circle cx="256" cy="256" r="22" fill={`url(#${hub})`} />
      <circle cx="256" cy="256" r="13" fill="#050C1A" />
      <circle cx="256" cy="256" r="7" fill="#F0D068" opacity="0.95" />
    </svg>
  );
}

/**
 * Monochrome outline of the same mark for empty states: strokes only, in currentColor,
 * so it sits quietly in muted text color rather than competing with the content.
 */
export function CompassOutline({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="14"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="256" cy="256" r="234" />
      <line x1="256" y1="28" x2="256" y2="43" />
      <line x1="256" y1="469" x2="256" y2="484" />
      <line x1="469" y1="256" x2="484" y2="256" />
      <line x1="28" y1="256" x2="43" y2="256" />
      <path d="M256,74 L274,248 L256,256 L238,248 Z" />
      <path d="M256,438 L238,264 L256,256 L274,264 Z" />
      <path d="M416,256 L268,240 L256,256 L268,272 Z" />
      <path d="M96,256 L244,240 L256,256 L244,272 Z" />
      <circle cx="256" cy="256" r="22" />
    </svg>
  );
}
