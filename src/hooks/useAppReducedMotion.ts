import { useReducedMotion } from "motion/react";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * True when animation should be suppressed - either because the OS asks for reduced motion or
 * because the user turned it on in Compass itself. Framer Motion's own `useReducedMotion` only
 * sees the OS media query, so anything driven by JS (the canvas particle effects) needs this
 * combined check rather than that hook directly.
 */
export function useAppReducedMotion(): boolean {
  const systemPrefers = useReducedMotion();
  const motionPref = useSettingsStore((s) => s.motionPref);
  return motionPref === "reduced" || systemPrefers === true;
}
