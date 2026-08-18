import { create } from "zustand";

const MOTION_KEY = "compass_motion_pref";

/** "system" follows the OS reduce-motion setting; "reduced" forces it on regardless. There's
 *  deliberately no "always animate" - overriding someone's accessibility setting isn't ours to do. */
export type MotionPref = "system" | "reduced";

interface SettingsState {
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
