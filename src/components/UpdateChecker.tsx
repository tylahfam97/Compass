import { useState, useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

interface Props {
  /** When true, silently checks for updates on mount and prompts via modal if one is found. */
  autoCheck?: boolean;
}

type State =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; update: Update }
  | { phase: "prompt"; update: Update }       // auto-check found an update — shows modal
  | { phase: "downloading"; percent: number }
  | { phase: "restart" }
  | { phase: "error"; message: string };

export default function UpdateChecker({ autoCheck = false }: Props) {
  const [state, setState] = useState<State>({ phase: "idle" });

  // Silent background check on launch — never changes the sidebar UI on failure
  // or when already up-to-date, so it's invisible unless an update is found.
  useEffect(() => {
    if (!autoCheck) return;
    const timer = setTimeout(async () => {
      try {
        const update = await check();
        if (update) setState({ phase: "prompt", update });
      } catch {
        // Silently swallow — user can still check manually from the sidebar.
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCheck() {
    setState({ phase: "checking" });
    try {
      const update = await check();
      if (update) {
        setState({ phase: "available", update });
      } else {
        setState({ phase: "up-to-date" });
        setTimeout(() => setState({ phase: "idle" }), 3000);
      }
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    }
  }

  async function handleInstall(update: Update) {
    setState({ phase: "downloading", percent: 0 });
    let contentLength = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const pct = contentLength > 0
            ? Math.round((downloaded / contentLength) * 100)
            : 0;
          setState({ phase: "downloading", percent: pct });
        } else if (event.event === "Finished") {
          setState({ phase: "restart" });
        }
      });
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    }
  }

  const base =
    "w-full text-xs px-3 py-2 rounded-md border transition-colors";
  const normal = `${base} hover:bg-[hsl(var(--border))]`;
  const muted = "text-[hsl(var(--muted-foreground))]";

  // ── Auto-check modal prompt ──────────────────────────────────────────────
  if (state.phase === "prompt") {
    const { update } = state;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-[hsl(var(--background))] border rounded-xl p-6 w-80 shadow-xl space-y-4">
          <div>
            <p className="font-semibold text-sm">Update available</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
              Compass v{update.version} is ready to install.
            </p>
            {update.body && (
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-3 border-t pt-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
                {update.body}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleInstall(update)}
              className="flex-1 px-3 py-2 text-xs font-medium bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg hover:opacity-90 transition-opacity"
            >
              Install now
            </button>
            <button
              onClick={() => setState({ phase: "idle" })}
              className="flex-1 px-3 py-2 text-xs border rounded-lg hover:bg-[hsl(var(--muted))] transition-colors"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Sidebar states ───────────────────────────────────────────────────────
  if (state.phase === "idle") {
    return (
      <button onClick={handleCheck} className={normal}>
        Check for updates
      </button>
    );
  }

  if (state.phase === "checking") {
    return (
      <p className={`text-xs px-3 py-2 ${muted}`}>Checking…</p>
    );
  }

  if (state.phase === "up-to-date") {
    return (
      <p className={`text-xs px-3 py-2 ${muted}`}>Up to date ✓</p>
    );
  }

  if (state.phase === "available") {
    const { update } = state;
    return (
      <div className="space-y-1">
        <p className="text-xs px-3 text-[hsl(var(--foreground))]">
          v{update.version} available
        </p>
        <button
          onClick={() => handleInstall(update)}
          className={`${base} bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent hover:opacity-90`}
        >
          Install update
        </button>
        <button onClick={() => setState({ phase: "idle" })} className={normal}>
          Later
        </button>
      </div>
    );
  }

  if (state.phase === "downloading") {
    return (
      <p className={`text-xs px-3 py-2 ${muted}`}>
        Downloading… {state.percent > 0 ? `${state.percent}%` : ""}
      </p>
    );
  }

  if (state.phase === "restart") {
    return (
      <button
        onClick={() => relaunch()}
        className={`${base} bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent hover:opacity-90`}
      >
        Restart to apply
      </button>
    );
  }

  // error
  return (
    <div className="space-y-1">
      <p className={`text-xs px-3 py-1 ${muted} break-all`}>
        {state.message}
      </p>
      <button onClick={() => setState({ phase: "idle" })} className={normal}>
        Dismiss
      </button>
    </div>
  );
}

