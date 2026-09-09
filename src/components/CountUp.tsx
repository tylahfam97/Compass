import { useEffect, useState } from "react";
import { animate, useMotionValue } from "motion/react";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";

/**
 * Animates a number counting up to `value` on change/mount. Render inside an element with
 * `tabular-nums` so the digits don't jiggle mid-count. Jumps straight to the final value under
 * reduced motion.
 */
export default function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const reduced = useAppReducedMotion();
  const mv = useMotionValue(0);
  const [display, setDisplay] = useState(() => format(0));

  useEffect(() => {
    if (reduced) {
      setDisplay(format(value));
      return;
    }
    const controls = animate(mv, value, {
      duration: 0.7, ease: "easeOut",
      onUpdate: (v) => setDisplay(format(v)),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced]);

  return <>{display}</>;
}
