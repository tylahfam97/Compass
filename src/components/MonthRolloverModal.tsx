import { motion, AnimatePresence } from "motion/react";
import calendarFlipGif from "@/assets/CalendarFlip.gif";
import { useMonthRolloverStore, monthLabel } from "@/stores/monthRolloverStore";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { useEffect } from "react";

const AUTO_DISMISS_MS = 5000;

/** One-shot celebratory overlay shown the first time Compass is opened in a new calendar month -
 *  a page-flip animation plus a "Welcome to <Month>" message, auto-dismissing on its own so it
 *  never blocks anything the user needs to do. Renders nothing on every other launch. */
export default function MonthRolloverModal() {
  const justRolledOver = useMonthRolloverStore((s) => s.justRolledOver);
  const modalShown = useMonthRolloverStore((s) => s.modalShown);
  const newMonth = useMonthRolloverStore((s) => s.newMonth);
  const dismissModal = useMonthRolloverStore((s) => s.dismissModal);
  const show = justRolledOver && !modalShown;
  const { onBackdropClick } = useModalDismiss(dismissModal);

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(dismissModal, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [show, dismissModal]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          onClick={onBackdropClick}
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 12 }} transition={{ duration: 0.25, ease: "easeOut" }}
            className="bg-[hsl(var(--background))] border rounded-2xl p-8 w-96 max-w-[90vw] shadow-2xl
                       flex flex-col items-center gap-4 text-center cursor-pointer select-none"
            style={{ border: "1px solid var(--gold)", boxShadow: "0 12px 32px rgba(201, 149, 43, 0.3)" }}
            onClick={dismissModal}
            role="status"
          >
            <img src={calendarFlipGif} alt="" className="w-40 h-40 object-contain" />
            <h2 className="text-xl font-semibold" style={{ color: "var(--gold)" }}>Welcome to {monthLabel(newMonth)}</h2>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Compass has moved your views to the new month - fresh start, clean slate.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
