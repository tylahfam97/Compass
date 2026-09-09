import { create } from "zustand";

const MOTION_KEY = "compass_motion_pref";

/** "system" follows the OS reduce-motion setting; "reduced" forces it on regardless. There's
 *  deliberately no "always animate" - overriding someone's accessibility setting isn't ours to do. */
export type MotionPref = "system" | "reduced";

interface SettingsState {
  theme: "system" | "light" | "dark";
  setTheme: (theme: "system" | "light" | "dark") => void;
  motionPref: MotionPref;
  setMotionPref: (pref: MotionPref) => void;
}

function loadMotionPref(): MotionPref {
  try {
    return localStorage.getItem(MOTION_KEY) === "reduced" ? "reduced" : "system";
  } catch {
    return "system";
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: (() => {
    try { const theme = localStorage.getItem("compass_theme"); return theme === "light" || theme === "dark" ? theme : "system"; } catch { return "system"; }
  })(),
  setTheme: (theme) => {
    set({ theme });
    try { localStorage.setItem("compass_theme", theme); } catch { return; }
  },
  motionPref: loadMotionPref(),
  setMotionPref: (pref) => {
    try {
      localStorage.setItem(MOTION_KEY, pref);
    } catch {
      // Preference just won't survive a restart; not worth an error for a display setting.
    }
    set({ motionPref: pref });
  },
}));
