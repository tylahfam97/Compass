import { useRef, useState } from "react";
import { motion, useMotionValue, useTransform, animate, type MotionValue } from "motion/react";
import type { Insight } from "@/lib/types";
import InsightCard from "@/components/InsightCard";

interface Props {
  items: Insight[];
  onApply: (insight: Insight) => void;
}

const SPACING = 190; // px between card centers
const CARD_WIDTH = 264;
const MAX_VISIBLE_OFFSET = 3.4; // cards beyond this are display:none (perf + avoids stray edges)

/**
 * A "coverflow"-style 3D carousel: drag anywhere in the box (no visible scrollbar/slider) to
 * spin through insight cards. The centered card is flat and at full size/opacity; cards to
 * either side shrink, fade, and tilt away in 3D (via rotateY) as if receding from the viewer -
 * more of that the further they are from center. Releasing the drag snaps to the nearest card
 * (factoring in flick velocity) and the carousel eases there on its own via a spring animation.
 */
export default function InsightCarousel({ items, onApply }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  // Committed position (settles on an integer index between/after gestures - a plain number
  // during a spring animation as it eases toward its target).
  const activeIndexMV = useMotionValue(0);
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
    // then let it spring the rest of the way to the snapped target on its own.
    activeIndexMV.set(fromContinuous);
    dragXMV.set(0);
    animate(activeIndexMV, target, { type: "spring", stiffness: 300, damping: 32, mass: 0.9 });
    setActiveIndex(target);
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
      className="relative select-none outline-none"
      style={{ height: 220, perspective: 1200, touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <CarouselCard
          key={item.id}
          item={item}
          index={i}
          positionMV={positionMV}
          onApply={onApply}
          isFront={i === activeIndex}
        />
      ))}
    </div>
  );
}

function CarouselCard({
  item, index, positionMV, onApply, isFront,
}: {
  item: Insight;
  index: number;
  positionMV: MotionValue<number>;
  onApply: (insight: Insight) => void;
  isFront: boolean;
}) {
  // `offset` is this card's continuous distance from dead-center, in card-slots (0 = front).
  const offset = useTransform(positionMV, (pos) => index - pos);
  const x = useTransform(offset, (o) => o * SPACING);
  const scale = useTransform(offset, (o) => Math.max(0.62, 1 - Math.abs(o) * 0.16));
  const opacity = useTransform(offset, (o) => Math.max(0, 1 - Math.abs(o) * 0.42));
  // Tilts away from the viewer in 3D - opposite sign left vs. right, flat (0) at dead-center.
  const rotateY = useTransform(offset, (o) => Math.max(-42, Math.min(42, o * -26)));
  const zIndex = useTransform(offset, (o) => Math.round(100 - Math.abs(o) * 10));
  const display = useTransform(offset, (o) => (Math.abs(o) > MAX_VISIBLE_OFFSET ? "none" : "block"));

  return (
    <motion.div
      style={{
        position: "absolute", top: 0, left: "50%", width: CARD_WIDTH,
        x, scale, opacity, rotateY, zIndex, display,
        marginLeft: -CARD_WIDTH / 2,
        pointerEvents: isFront ? "auto" : "none",
        transformStyle: "preserve-3d",
      }}
    >
      <InsightCard insight={item} onApply={onApply} variant="card" compact={!isFront} />
    </motion.div>
  );
}
