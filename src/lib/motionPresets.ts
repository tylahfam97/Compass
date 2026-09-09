import type { Variants } from "motion/react";

/**
 * Shared entrance animation for top-level cards on data pages. Parent gets
 * `variants={staggerContainer} initial="hidden" animate="show"`, each card gets
 * `variants={riseIn}`. Transform/opacity only, so it stays GPU-cheap, and MotionConfig's
 * reduced-motion setting suppresses it globally.
 */
export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

export const riseIn: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 320, damping: 32 } },
};
