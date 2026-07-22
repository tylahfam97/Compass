import { useRef } from "react";
import { motion, useMotionValue, useTransform, animate, type MotionValue } from "motion/react";
import type { Insight } from "@/lib/types";
import InsightCard from "@/components/InsightCard";

interface Props {
  items: Insight[];
  onApply: (insight: Insight) => void;
}

const SPACING = 260; // px between card centers - generous so neighbors never overlap
const CARD_WIDTH = 264;
const MAX_VISIBLE_OFFSET = 3.4; // cards beyond this are display:none (perf + avoids stray edges)
// Rotation saturates fast (reaches its max within about one slot of travel) rather than
// growing forever with distance - each card's tilt is a function of ITS OWN position only,
// so a card that's already fully tilted stays put (doesn't keep "spinning") while you keep
// dragging; only the card actually crossing through the center actively rotates, unwinding
// toward flat as it arrives and winding back up as it leaves on the far side.
const TILT_MAX_DEG = 58;
const TILT_SLOPE = 95;

/**
 * A "coverflow"-style 3D carousel: drag anywhere in the box (no visible scrollbar/slider) to
 * spin through insight cards. The centered card is flat and at full size/opacity; cards to
 * either side shrink, fade, and tilt away in 3D (via rotateY) as if receding from the viewer -
 * more so the further they are from center. Releasing the drag snaps to the nearest card
 * (factoring in flick velocity) and the carousel eases there on its own.
 */
export default function InsightCarousel({ items, onApply }: Props) {
  // Committed position (settles on an integer index between/after gestures - a plain number
  // during the ease-to-target animation as it eases toward its destination).
  // Starts on the MIDDLE item rather than the first, so the very first render already shows
  // a visually balanced spread of cards on both sides instead of everything bunched to one
  // side with empty space opposite it (the previous default of 0 left nothing to the left
  // of the active card when there were 3+ items).
  const initialIndex = Math.floor((items.length - 1) / 2);
  const activeIndexMV = useMotionValue(initialIndex);
  // Live pointer offset (px) for the drag currently in progress; 0 when not dragging.
  const dragXMV = useMotionValue(0);
  // Continuous fractional "which card is centered" position combining both of the above -
  // every card's transform is derived from this single source of truth.
  const positionMV = useTransform([activeIndexMV, dragXMV], (latest) => {
    const ai = latest[0] as number;
    const dx = latest[1] as number;
    return ai - dx / SPACING;
  });

  const dragState = useRef<{ dragging: boolean; startX: number; lastX: number; lastT: number; v: number } | null>(null);

  const clampIndex = (i: number) => Math.max(0, Math.min(items.length - 1, i));

  const snapTo = (targetIndexRaw: number, fromContinuous: number) => {
    const target = clampIndex(Math.round(targetIndexRaw));
    // Jump the committed value to the exact spot the drag left off (no visual jump, since
    // dragXMV resets to 0 in the same tick - fromContinuous - 0 === the pre-release position)
    // then ease the rest of the way to the snapped target on its own - slow and deliberate,
    // not a snappy flick, so the carousel reads as smooth/premium rather than twitchy.
    activeIndexMV.set(fromContinuous);
    dragXMV.set(0);
    animate(activeIndexMV, target, { duration: 0.62, ease: [0.22, 1, 0.36, 1] });
  };

  const endDrag = () => {
    const s = dragState.current;
    if (!s || !s.dragging) return;
    s.dragging = false;
    const rawOffset = dragXMV.get();
    const continuousPos = activeIndexMV.get() - rawOffset / SPACING;
    // Project a bit further based on flick velocity so a fast swipe can carry past one card,
    // like the carousel has real momentum rather than stopping dead where the pointer let go.
    const projected = continuousPos - (s.v * 140) / SPACING;
    snapTo(projected, continuousPos);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (items.length <= 1) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragState.current = { dragging: true, startX: e.clientX, lastX: e.clientX, lastT: performance.now(), v: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = dragState.current;
    if (!s || !s.dragging) return;
    const now = performance.now();
    const dt = now - s.lastT;
    if (dt > 0) s.v = (e.clientX - s.lastX) / dt; // px/ms, smoothed by only using the latest sample
    s.lastX = e.clientX;
    s.lastT = now;
    dragXMV.set(e.clientX - s.startX);
  };
  const onPointerUp = () => endDrag();
  const onPointerLeave = () => { if (dragState.current?.dragging) endDrag(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") { e.preventDefault(); snapTo(activeIndexMV.get() + 1, activeIndexMV.get()); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); snapTo(activeIndexMV.get() - 1, activeIndexMV.get()); }
  };

  return (
    <div
      role="group"
      aria-label="Insight carousel - drag to browse"
      tabIndex={0}
      className="relative select-none outline-none mx-auto"
      style={{ height: 200, perspective: 1200, touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <CarouselCard key={item.id} item={item} index={i} positionMV={positionMV} onApply={onApply} />
      ))}
    </div>
  );
}

function CarouselCard({
  item, index, positionMV, onApply,
}: {
  item: Insight;
  index: number;
  positionMV: MotionValue<number>;
  onApply: (insight: Insight) => void;
}) {
  // `offset` is this card's continuous distance from dead-center, in card-slots (0 = front).
  // Every visual property below is a pure function of THIS card's own offset, so as one card
  // eases toward the center another eases away - each animates independently and continuously,
  // never in a fixed "large card vs. small cards" binary tied to which one was front when a
  // drag began.
  const offset = useTransform(positionMV, (pos) => index - pos);
  const x = useTransform(offset, (o) => o * SPACING);
  const scale = useTransform(offset, (o) => Math.max(0.5, 1 - Math.abs(o) * 0.22));
  const opacity = useTransform(offset, (o) => Math.max(0, 1 - Math.abs(o) * 0.42));
  // Saturating tilt (see TILT_SLOPE/TILT_MAX_DEG above) - flat at dead-center, quickly winds
  // up to a fixed max the moment it's off to either side, with opposite sign per side.
  const rotateY = useTransform(offset, (o) => Math.max(-TILT_MAX_DEG, Math.min(TILT_MAX_DEG, o * -TILT_SLOPE)));
  const zIndex = useTransform(offset, (o) => Math.round(100 - Math.abs(o) * 10));
  const display = useTransform(offset, (o) => (Math.abs(o) > MAX_VISIBLE_OFFSET ? "none" : "block"));
  // Only the card actually at (or essentially at) dead-center is interactive - this tracks
  // continuously off the live drag position rather than a static "was front when drag started"
  // flag, so Apply/Dismiss always work on whichever card is really centered right now.
  const pointerEvents = useTransform(offset, (o) => (Math.abs(o) < 0.5 ? "auto" : "none"));

  return (
    <motion.div
      style={{
        position: "absolute", top: "50%", left: "50%", width: CARD_WIDTH,
        x, y: "-50%", scale, opacity, rotateY, zIndex, display, pointerEvents,
        marginLeft: -CARD_WIDTH / 2,
        transformStyle: "preserve-3d",
      }}
    >
      <InsightCard insight={item} onApply={onApply} variant="card" />
    </motion.div>
  );
}
