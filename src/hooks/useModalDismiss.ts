import { useEffect, useRef } from "react";

/** Elements that can receive keyboard focus, used to work out where Tab should wrap. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Standard modal behavior shared by every modal in the app: pressing Escape closes it, clicking
 * the dimmed backdrop (but not the card itself) closes it too, and keyboard focus is trapped
 * inside while it's open then restored to whatever was focused before once it closes.
 *
 * Usage - put BOTH returned values on the backdrop element:
 *   const { onBackdropClick, containerRef } = useModalDismiss(onClose);
 *   <div onClick={onBackdropClick} ref={containerRef} className="fixed inset-0 ...">
 *     <div onClick={(e) => e.stopPropagation()} className="...card...">...</div>
 *   </div>
 */
export function useModalDismiss(onClose: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Held in a ref so the effect below can run exactly once. Callers almost always pass an
  // inline arrow, so depending on `onClose` would re-run the effect - and therefore re-run
  // focus restoration - on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;

    // Respect an existing autoFocus (PinModal's PIN field, for one) rather than yanking focus
    // to whichever element happens to come first in the DOM.
    if (container && !container.contains(document.activeElement)) {
      container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !container) return;

      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCloseRef.current();
  };

  return { onBackdropClick, containerRef };
}
