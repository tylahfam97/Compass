import { useSyncExternalStore } from "react";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * Whether the app is currently rendering its dark theme: the Settings choice, or the OS
 * preference when the choice is "system". One place for the rule so App.tsx (which
 * toggles the .dark class) and render sites that pick theme-specific colors (chart
 * palettes, harmonized category colors) can never disagree.
 */
function media(): MediaQueryList {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

function subscribe(onChange: () => void): () => void {
  const m = media();
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return media().matches;
}

export function useIsDark(): boolean {
  const theme = useSettingsStore((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribe, getSnapshot, () => false);
  return theme === "dark" || (theme === "system" && systemDark);
}
