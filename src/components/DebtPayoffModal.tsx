import { useState, useEffect, useMemo } from "react";
import { motion } from "motion/react";
import { X, Scissors, Info, CheckCircle2, Circle, Sparkles, TrendingDown, SlidersHorizontal } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { computeDebtPayoffPlan, simulateCustomDebtPayoff } from "@/lib/agent";
import type { DebtPayoffPlan } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import InfoTooltip from "./InfoTooltip";

interface DebtInput {
  id: number;
  name: string;
  balance_cents: number | null;
  interest_rate_bps: number | null;
  minimum_payment_cents: number | null;
  /** Earliest balance on record for this account (from its balance-history series) - lets the
   *  modal show "X% paid off since you started tracking this" with no extra DB round-trip. */
  firstKnownBalanceCents?: number | null;
}

interface DebtPayoffModalProps {
  profileIds: number[];
  debts: DebtInput[];
  title: string;
  subtitle?: string;
  onClose: () => void;
}

function monthsLabel(months: number | null): string {
  if (months == null) return "Won't pay off";
  const years = Math.floor(months / 12);
  const rem = Math.round(months % 12);
  if (years === 0) return `${rem} mo`;
  if (rem === 0) return `${years} yr`;
  return `${years} yr ${rem} mo`;
}

/** Minimum interest cost gap (in cents) below which we still consider a "quick win" (snowball
 *  closing an account sooner) worth surfacing - either a flat $300 or 10% of the current
 *  scenario's total interest, whichever is larger, so the threshold scales with bigger debts. */
function isModestExtraCost(extraInterestCents: number, baseInterestCents: number): boolean {
  return extraInterestCents <= Math.max(30_000, baseInterestCents * 0.1);
}

export default function DebtPayoffModal({ profileIds, debts, title, subtitle, onClose }: DebtPayoffModalProps) {
  const { onBackdropClick } = useModalDismiss(onClose);
  const [plan, setPlan] = useState<DebtPayoffPlan | null>(null);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<number> | null>(null);
  const [redirectPct, setRedirectPct] = useState(50);
  const [hoveredCategoryId, setHoveredCategoryId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    computeDebtPayoffPlan(profileIds, debts).then((p) => {
      if (cancelled) return;
      setPlan(p);
      setSelectedCategoryIds(new Set(p.discretionaryBreakdown.map((c) => c.categoryId)));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debtNamesById = useMemo(() => new Map(debts.map((d) => [d.id, d.name])), [debts]);

  const selectedTotalCents = useMemo(() => {
    if (!plan || !selectedCategoryIds) return 0;
    return plan.discretionaryBreakdown
      .filter((c) => selectedCategoryIds.has(c.categoryId))
      .reduce((s, c) => s + c.avgMonthlyCents, 0);
  }, [plan, selectedCategoryIds]);

  const extraMonthlyCents = Math.round((selectedTotalCents * redirectPct) / 100);

  const customResult = useMemo(
    () => (plan ? simulateCustomDebtPayoff(plan.simDebts, extraMonthlyCents, "avalanche") : null),
    [plan, extraMonthlyCents]
  );

  // The "quick win" callout (avalanche-vs-snowball comparison) is intentionally driven by a
  // debounced redirect amount, not the live one - it only settles/updates a moment after the
  // user stops dragging the slider, instead of flickering its message (and thus its height) on
  // every tick while the thumb is still moving.
  const [debouncedExtraMonthlyCents, setDebouncedExtraMonthlyCents] = useState(extraMonthlyCents);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedExtraMonthlyCents(extraMonthlyCents), 250);
    return () => clearTimeout(t);
  }, [extraMonthlyCents]);

  const quickWinAvalanche = useMemo(
    () => (plan && plan.simDebts.length > 1 ? simulateCustomDebtPayoff(plan.simDebts, debouncedExtraMonthlyCents, "avalanche") : null),
    [plan, debouncedExtraMonthlyCents]
  );
  const snowballResult = useMemo(
    () => (plan && plan.simDebts.length > 1 ? simulateCustomDebtPayoff(plan.simDebts, debouncedExtraMonthlyCents, "snowball") : null),
    [plan, debouncedExtraMonthlyCents]
  );

  function toggleCategory(categoryId: number) {
    setSelectedCategoryIds((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(categoryId)) next.delete(categoryId); else next.add(categoryId);
      return next;
    });
  }

  // "Progress since you started tracking" - only shown for debts where we actually know an
  // earlier balance and it's genuinely gone down (a debt that grew has nothing to celebrate).
  const debtProgress = debts
    .map((d) => {
      if (d.firstKnownBalanceCents == null || d.firstKnownBalanceCents === 0 || d.balance_cents == null) return null;
      const startAbs = Math.abs(d.firstKnownBalanceCents);
      const currentAbs = Math.abs(d.balance_cents);
      const pct = Math.round(((startAbs - currentAbs) / startAbs) * 100);
      return pct > 0 ? { id: d.id, name: d.name, pct } : null;
    })
    .filter((x): x is { id: number; name: string; pct: number } => x !== null);

  // Quick-win framing: does redirecting the same dollar amount, smallest-balance-first
  // (snowball) instead of highest-rate-first (avalanche), close an account meaningfully sooner
  // for only a modest extra interest cost?
  const quickWin = useMemo(() => {
    if (!quickWinAvalanche || !snowballResult) return null;
    const avalancheFirst = Math.min(...quickWinAvalanche.perDebtMonths.map((p) => p.monthsToPayoff ?? Infinity));
    const snowballFirstEntry = snowballResult.perDebtMonths.reduce<{ id: number; months: number } | null>((best, p) => {
      if (p.monthsToPayoff == null) return best;
      return !best || p.monthsToPayoff < best.months ? { id: p.id, months: p.monthsToPayoff } : best;
    }, null);
    if (!snowballFirstEntry || !Number.isFinite(avalancheFirst)) return null;
    const monthsSooner = avalancheFirst - snowballFirstEntry.months;
    const extraInterestCents = snowballResult.totalInterestCents - quickWinAvalanche.totalInterestCents;
    if (monthsSooner <= 0 || extraInterestCents < 0) return null;
    if (!isModestExtraCost(extraInterestCents, quickWinAvalanche.totalInterestCents)) return null;
    const name = debtNamesById.get(snowballFirstEntry.id);
    if (!name) return null;
    return { name, monthsSooner, extraInterestCents };
  }, [quickWinAvalanche, snowballResult, debtNamesById]);

  const timelineData = useMemo(() => {
    if (!customResult) return [];
    return customResult.perDebtMonths
      .filter((p) => p.monthsToPayoff != null)
      .map((p) => ({ name: debtNamesById.get(p.id) ?? "Debt", months: p.monthsToPayoff as number }))
      .sort((a, b) => a.months - b.months);
  }, [customResult, debtNamesById]);
  const unresolvedDebtNames = useMemo(() => {
    if (!customResult) return [];
    return customResult.perDebtMonths.filter((p) => p.monthsToPayoff == null).map((p) => debtNamesById.get(p.id) ?? "Debt");
  }, [customResult, debtNamesById]);

  const monthsSavedVsBaseline = plan && customResult && plan.baseline.monthsToPayoff != null && customResult.monthsToPayoff != null
    ? plan.baseline.monthsToPayoff - customResult.monthsToPayoff : 0;
  const interestSavedVsBaseline = plan && customResult ? plan.baseline.totalInterestCents - customResult.totalInterestCents : 0;
  const cushionCents = plan ? plan.discretionaryTotalCents - extraMonthlyCents : 0;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[hsl(var(--background))] border rounded-2xl shadow-xl w-full max-w-3xl p-6 max-h-[88vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] shrink-0">
            <X size={18} />
          </button>
        </div>

        {!plan || !customResult ? (
          <div className="py-16 text-center text-sm text-[hsl(var(--muted-foreground))]">Crunching the numbers…</div>
        ) : (
          <div className="space-y-5 mt-4">
            {/* Summary strip */}
            <div className="grid grid-cols-3 gap-3">
              <div className="border rounded-xl p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">Total Debt</p>
                <p className="text-lg font-bold text-[hsl(var(--error))]">{formatCurrency(plan.totalDebtCents)}</p>
              </div>
              <div className="border rounded-xl p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">Avg. Interest Rate</p>
                <p className="text-lg font-bold">{plan.weightedAvgRateBps != null ? `${(plan.weightedAvgRateBps / 100).toFixed(2)}%` : "—"}</p>
              </div>
              <div className="border rounded-xl p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">Minimum Payments</p>
                <p className="text-lg font-bold">{formatCurrency(plan.totalMinPaymentCents)}/mo</p>
              </div>
            </div>

            {!plan.hasRateData && (
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                <Info size={12} className="shrink-0 mt-0.5" />
                No interest rate is on file for these accounts, so the timelines below assume 0% interest as a placeholder.
                Add a rate via "Add a Statement" for an accurate estimate.
              </p>
            )}

            {/* Progress since you started tracking */}
            {debtProgress.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {debtProgress.map((d) => (
                  <span
                    key={d.id}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]"
                  >
                    <TrendingDown size={12} />
                    {d.pct}% paid off on {d.name} since you started tracking it
                  </span>
                ))}
              </div>
            )}

            {/* What can be cut - now interactive: toggle categories in/out of the redirect */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2 flex items-center gap-1.5">
                <Scissors size={13} /> What Can Be Cut
                <InfoTooltip text="Average monthly spend over your recent history in categories that are typically discretionary - entertainment, shopping, subscriptions, personal care, gifts, gambling, and travel. Only counts spending from checking/savings accounts (real cash on hand) - purchases already made on a credit card or loan aren't available to redirect, since that balance is already part of the debt you're paying off. Essentials like housing, groceries, and bills aren't included either. Tap a category to include or exclude it from what you redirect below." />
              </h3>
              {plan.discretionaryBreakdown.length === 0 ? (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  No discretionary spending detected yet in your recent history - the slider below won't have much to work
                  with until there's more data, or you free up cash some other way.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {plan.discretionaryBreakdown.map((c) => {
                    const selected = selectedCategoryIds?.has(c.categoryId) ?? false;
                    return (
                      <div
                        key={c.categoryId}
                        className="relative"
                        onMouseEnter={() => setHoveredCategoryId(c.categoryId)}
                        onMouseLeave={() => setHoveredCategoryId(null)}
                      >
                        <button
                          onClick={() => toggleCategory(c.categoryId)}
                          className={`w-full flex items-center gap-2 text-sm rounded-lg px-1.5 py-1 -mx-1.5 transition-colors ${selected ? "" : "opacity-45"} hover:bg-[hsl(var(--muted))]`}
                        >
                          {selected ? <CheckCircle2 size={14} className="text-[hsl(var(--primary))] shrink-0" /> : <Circle size={14} className="text-[hsl(var(--muted-foreground))] shrink-0" />}
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                          <span className="flex-1 truncate text-left">{c.name}</span>
                          <span className="font-medium">{formatCurrency(c.avgMonthlyCents)}/mo</span>
                        </button>
                        {hoveredCategoryId === c.categoryId && c.exampleItems.length > 0 && (
                          <span
                            role="tooltip"
                            className="absolute z-30 left-6 top-full mt-0.5 text-left text-[11px] leading-snug font-normal normal-case px-3 py-2 rounded-lg shadow-lg pointer-events-none whitespace-nowrap"
                            style={{ backgroundColor: "hsl(var(--foreground))", color: "hsl(var(--background))" }}
                          >
                            e.g. {c.exampleItems.join(", ")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 text-sm pt-1.5 border-t font-semibold">
                    <span className="flex-1">Selected - available to redirect</span>
                    <span>{formatCurrency(selectedTotalCents)}/mo</span>
                  </div>
                </div>
              )}
            </div>

            {/* Live redirect slider */}
            <div className="border rounded-xl p-4 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] flex items-center gap-1.5">
                <SlidersHorizontal size={13} /> Redirect Toward Debt
              </h3>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={redirectPct}
                  onChange={(e) => setRedirectPct(Number(e.target.value))}
                  disabled={selectedTotalCents === 0}
                  className="flex-1 accent-[hsl(var(--primary))] disabled:opacity-40"
                />
                <span className="text-sm font-bold tabular-nums w-12 text-right">{redirectPct}%</span>
              </div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Redirecting <span className="font-semibold text-[hsl(var(--foreground))]">{formatCurrency(extraMonthlyCents)}/mo</span> on
                top of minimum payments, keeping <span className="font-semibold text-[hsl(var(--foreground))]">{formatCurrency(cushionCents)}/mo</span> as
                breathing room.
              </p>

              <div className="grid grid-cols-2 gap-3 pt-2 border-t">
                <div>
                  <p className="text-2xl font-black tabular-nums">{monthsLabel(customResult.monthsToPayoff)}</p>
                  <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                    {customResult.payoffDate ? `Debt-free by ${customResult.payoffDate}` : "at this pace"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black tabular-nums">{formatCurrency(customResult.totalInterestCents)}</p>
                  <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Total interest paid</p>
                </div>
              </div>

              {/* Always rendered (space reserved even with nothing to show) so this row appearing/
                  disappearing doesn't shift the modal's height while dragging the slider. */}
              <div className={`flex justify-between text-xs text-[hsl(var(--success))] pt-2 border-t ${monthsSavedVsBaseline > 0 || interestSavedVsBaseline > 0 ? "" : "invisible"}`}>
                <span>vs. Stay the Course ({monthsLabel(plan.baseline.monthsToPayoff)}, {formatCurrency(plan.baseline.totalInterestCents)} interest)</span>
                <span className="font-medium text-right">
                  {monthsSavedVsBaseline > 0 ? `${monthsLabel(monthsSavedVsBaseline)} faster` : ""}
                  {monthsSavedVsBaseline > 0 && interestSavedVsBaseline > 0 ? " · " : ""}
                  {interestSavedVsBaseline > 0 ? `${formatCurrency(interestSavedVsBaseline)} saved` : ""}
                </span>
              </div>
            </div>

            {/* Quick-win framing - always visible (never mounted/unmounted) with a fixed
                min-height so this box never disappears or resizes while the slider moves; its
                content is also debounced (see quickWinAvalanche/snowballResult above) so it
                settles a moment after dragging stops instead of flickering mid-drag. */}
            {plan.simDebts.length > 1 && (
              <div className="flex items-center gap-2 text-xs rounded-xl px-3 py-2.5 min-h-[52px] bg-[hsl(var(--primary)/0.06)] border border-[hsl(var(--primary)/0.25)]">
                <Sparkles size={14} className="shrink-0 text-[hsl(var(--primary))]" />
                <p>
                  {quickWin ? (
                    <>
                      Paying off <span className="font-semibold">{quickWin.name}</span> first only costs{" "}
                      {quickWin.extraInterestCents > 0 ? `${formatCurrency(quickWin.extraInterestCents)} more` : "about the same"} in interest,
                      but closes an account <span className="font-semibold">{monthsLabel(quickWin.monthsSooner)} sooner</span> - worth it for
                      the motivation if the math alone isn't the deciding factor.
                    </>
                  ) : (
                    "No snowball quick win at this redirect amount - avalanche and snowball finish about the same either way."
                  )}
                </p>
              </div>
            )}

            {/* Payoff timeline - chart height is keyed off the total debt count (constant),
                not the number currently resolving, and the warning line below is always
                mounted (space reserved), so paying off more/fewer debts as the slider moves
                doesn't shift the modal's height. */}
            {plan.simDebts.length > 1 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2">
                  Payoff Timeline
                </h3>
                {timelineData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={Math.max(60, plan.simDebts.length * 34)}>
                    <BarChart data={timelineData} layout="vertical" margin={{ left: 8, right: 32, top: 4, bottom: 4 }}>
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip formatter={(v) => [monthsLabel(typeof v === "number" ? v : null), "Payoff time"]} labelFormatter={() => ""} />
                      <Bar dataKey="months" radius={[0, 4, 4, 0]}>
                        {timelineData.map((d) => (
                          <Cell key={d.name} fill="#6366f1" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div
                    style={{ height: Math.max(60, plan.simDebts.length * 34) }}
                    className="flex items-center justify-center text-center text-xs text-[hsl(var(--muted-foreground))] border rounded-lg px-4"
                  >
                    No debts pay off within the projection window at this pace - increase the redirect above.
                  </div>
                )}
                <p className={`text-[11px] text-amber-600 dark:text-amber-400 mt-1 ${unresolvedDebtNames.length > 0 ? "" : "invisible"}`}>
                  {unresolvedDebtNames.length > 0 ? `${unresolvedDebtNames.join(", ")} won't pay off at this pace - increase the redirect above.` : "placeholder"}
                </p>
              </div>
            )}

            <p className="text-[11px] text-[hsl(var(--muted-foreground))] flex items-start gap-1.5">
              <Info size={11} className="shrink-0 mt-0.5" />
              Based on the avalanche method (highest interest rate paid down first - once one account is paid off, its
              minimum payment rolls into the next). Actual results will vary with real spending, rate changes, and new
              purchases.
            </p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

