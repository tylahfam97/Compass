import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render/commit errors anywhere in its subtree so a single bad render (e.g. a
 * chart resize edge case) can't blank the whole app and force a full restart - shows a
 * small recoverable fallback instead. Wrapped around the routed page content in App.tsx
 * so the sidebar/nav always survive even if a page crashes.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error("[ErrorBoundary] caught a render error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 py-24 text-center px-6">
          <AlertTriangle size={32} className="text-amber-500" />
          <div>
            <p className="font-semibold text-base">Something went wrong displaying this page</p>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              Your data is safe - this is just a display glitch. Try again below.
            </p>
          </div>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-full
                       border hover:bg-[hsl(var(--muted))] transition-colors"
          >
            <RotateCcw size={14} />
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
