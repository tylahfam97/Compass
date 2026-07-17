import { useEffect } from "react";

/**
 * Standard modal dismiss behavior shared by every modal in the app: pressing Escape closes it,
 * and clicking the dimmed backdrop (but not the card itself) closes it too. Clicking inside the
 * card never closes it, since that click's target is a descendant, not the backdrop element.
 *
 * Usage:
 *   const { onBackdropClick } = useModalDismiss(onClose);
 *   <div onClick={onBackdropClick} className="fixed inset-0 ...">
 *     <div onClick={(e) => e.stopPropagation()} className="...card...">...</div>
 *   </div>
 */
export function useModalDismiss(onClose: () => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return { onBackdropClick };
}
