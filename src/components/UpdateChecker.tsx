import { useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type State =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; update: Update }
  | { phase: "downloading"; percent: number }
  | { phase: "restart" }
  | { phase: "error"; message: string };

export default function UpdateChecker() {
  const [state, setState] = useState<State>({ phase: "idle" });

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
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Progress") {
          const pct = event.data.chunkLength && event.data.contentLength
            ? Math.round((event.data.chunkLength / event.data.contentLength) * 100)
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
