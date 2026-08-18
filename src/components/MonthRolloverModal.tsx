import { motion, AnimatePresence } from "motion/react";
import calendarFlipGif from "@/assets/CalendarFlip.gif";
import { useMonthRolloverStore, monthLabel } from "@/stores/monthRolloverStore";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { useProfileStore } from "@/stores/profileStore";
import { getMonthInReview, type MonthInReview } from "@/lib/monthReview";
import { formatCurrency } from "@/lib/utils";
import { useEffect, useState } from "react";

/** Only auto-dismisses when there's nothing to read. A recap the user hasn't finished reading
 *  vanishing on a timer is worse than no recap at all. */
const AUTO_DISMISS_MS = 5000;

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">{label}</p>
      <p className="text-lg font-bold tabular-nums mt-0.5" style={tone ? { color: tone } : undefined}>{value}</p>
    </div>
  );
}

function Review({ review }: { review: MonthInReview }) {
  const spendChange = review.spendChangeCents;
  return (
    <>
      <div className="grid grid-cols-3 gap-3 w-full text-left">
        <Stat label="In" value={formatCurrency(review.incomeCents)} tone="hsl(var(--success))" />
        <Stat label="Out" value={formatCurrency(review.expenseCents)} tone="hsl(var(--error))" />
        <Stat
          label="Net"
          value={formatCurrency(review.netCents)}
          tone={review.netCents >= 0 ? "hsl(var(--success))" : "hsl(var(--error))"}
        />
      </div>

      <ul className="text-sm text-[hsl(var(--muted-foreground))] space-y-1.5 text-left w-full">
        {review.savingsRate !== null && (
          <li>
            You kept <span className="font-semibold text-[hsl(var(--foreground))]">{Math.round(review.savingsRate * 100)}%</span> of
            what came in.
          </li>
        )}
        {spendChange !== null && (
          <li>
            You spent{" "}
            <span className="font-semibold text-[hsl(var(--foreground))]">
              {formatCurrency(Math.abs(spendChange))} {spendChange <= 0 ? "less" : "more"}
            </span>{" "}
            than the month before.
          </li>
        )}
        {review.topCategory && (
          <li>
            Most went to{" "}
            <span className="font-semibold text-[hsl(var(--foreground))]">{review.topCategory.name}</span> at{" "}
            {formatCurrency(review.topCategory.totalCents)}.
          </li>
        )}
        {review.budgetsTotal > 0 && (
          <li>
            You held{" "}
            <span className="font-semibold text-[hsl(var(--foreground))]">
              {review.budgetsHeld} of {review.budgetsTotal}
            </span>{" "}
            budgets.
          </li>
        )}
      </ul>
    </>
  );
}

/** Shown the first time Compass is opened in a new calendar month: a page-flip animation and a
 *  short recap of the month that just ended. Renders nothing on every other launch. */
export default function MonthRolloverModal() {
  const justRolledOver = useMonthRolloverStore((s) => s.justRolledOver);
  const modalShown = useMonthRolloverStore((s) => s.modalShown);
  const newMonth = useMonthRolloverStore((s) => s.newMonth);
  const previousMonth = useMonthRolloverStore((s) => s.previousMonth);
  const dismissModal = useMonthRolloverStore((s) => s.dismissModal);
  const profileId = useProfileStore((s) => s.activeProfile?.id);
  const show = justRolledOver && !modalShown;

  const { onBackdropClick, containerRef } = useModalDismiss(dismissModal);
  const [review, setReview] = useState<MonthInReview | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!show || !previousMonth || profileId === undefined) return;
    let cancelled = false;
    getMonthInReview(profileId, previousMonth)
      .then((r) => { if (!cancelled) { setReview(r); setLoaded(true); } })
      // A recap is a nicety - if it can't be built, fall back to the plain welcome message
      // rather than bothering the user with an error on launch.
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [show, previousMonth, profileId]);

  useEffect(() => {
    if (!show || review) return;
    const t = setTimeout(dismissModal, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [show, review, dismissModal]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          onClick={onBackdropClick} ref={containerRef}
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 12 }} transition={{ duration: 0.25, ease: "easeOut" }}
            className={`bg-[hsl(var(--background))] rounded-2xl p-8 max-w-[92vw] shadow-2xl
                        flex flex-col items-center gap-4 text-center select-none ${review ? "w-[30rem]" : "w-96"}`}
            style={{ border: "1px solid var(--gold)", boxShadow: "0 12px 32px rgba(201, 149, 43, 0.3)" }}
            role="status"
          >
            <img src={calendarFlipGif} alt="" className={`object-contain ${review ? "w-24 h-24" : "w-40 h-40"}`} />

            {review && previousMonth ? (
              <>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--gold)" }}>
                    {monthLabel(previousMonth)} in review
                  </p>
                  <h2 className="text-xl font-semibold mt-1">Welcome to {monthLabel(newMonth)}</h2>
                </div>
                <Review review={review} />
              </>
            ) : (
              <>
                <h2 className="text-xl font-semibold" style={{ color: "var(--gold)" }}>Welcome to {monthLabel(newMonth)}</h2>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {loaded
                    ? "Compass has moved your views to the new month - fresh start, clean slate."
                    : "Looking back at last month…"}
                </p>
              </>
            )}

            <button
              onClick={dismissModal}
              className="mt-1 px-6 py-2 rounded-lg text-sm font-semibold text-black transition-opacity hover:opacity-90"
              style={{ backgroundColor: "var(--gold)" }}
            >
              {review ? "Start the month" : "Got it"}
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
