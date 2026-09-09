import { useSyncExternalStore } from "react";
import { useSettingsStore } from "@/stores/settingsStore";

function subscribe(listener: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

const snapshot = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useAppReducedMotion(): boolean {
  const systemPrefers = useSyncExternalStore(subscribe, snapshot, () => false);
  const motionPref = useSettingsStore((s) => s.motionPref);
  return motionPref === "reduced" || systemPrefers === true;
}
