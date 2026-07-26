import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { X, Flame, Shield, Clock, Scissors, Info, type LucideIcon } from "lucide-react";
import { computeDebtPayoffPlan } from "@/lib/agent";
import type { DebtPayoffPlan, DebtPayoffScenario } from "@/lib/types";
import { formatCurrency } from "@/lib/utils";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import InfoTooltip from "./InfoTooltip";

interface DebtInput {
  id: number;
  balance_cents: number | null;
  interest_rate_bps: number | null;
  minimum_payment_cents: number | null;
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

const SCENARIO_ICON: Record<DebtPayoffScenario["key"], LucideIcon> = {
  minimum: Shield,
  balanced: Clock,
  aggressive: Flame,
};
const SCENARIO_DESC: Record<DebtPayoffScenario["key"], string> = {
  minimum: "Keep your budget exactly as-is - pay only the minimums, nothing extra.",
  balanced: "Redirect about half of your discretionary spending toward debt, keeping the other half as breathing room.",
  aggressive: "Redirect all identified discretionary spending toward debt for the fastest, cheapest payoff.",
};

export default function DebtPayoffModal({ profileIds, debts, title, subtitle, onClose }: DebtPayoffModalProps) {
  const { onBackdropClick } = useModalDismiss(onClose);
  const [plan, setPlan] = useState<DebtPayoffPlan | null>(null);

  useEffect(() => {
    let cancelled = false;
    computeDebtPayoffPlan(profileIds, debts).then((p) => { if (!cancelled) setPlan(p); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baseline = plan?.scenarios.find((s) => s.key === "minimum") ?? null;

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

        {!plan ? (
          <div className="py-16 text-center text-sm text-[hsl(var(--muted-foreground))]">Crunching the numbers…</div>
        ) : (
          <div className="space-y-5 mt-4">
            {/* Summary strip */}
            <div className="grid grid-cols-3 gap-3">
              <div className="border rounded-xl p-3 text-center">
                <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">Total Debt</p>
                <p className="text-lg font-bold text-red-500">{formatCurrency(plan.totalDebtCents)}</p>
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

            {/* What can be cut */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2 flex items-center gap-1.5">
                <Scissors size={13} /> What Can Be Cut
                <InfoTooltip text="Average monthly spend over your recent history in categories that are typically discretionary - entertainment, shopping, subscriptions, personal care, gifts, gambling, and travel. Only counts spending from checking/savings accounts (real cash on hand) - purchases already made on a credit card or loan aren't available to redirect, since that balance is already part of the debt you're paying off. Essentials like housing, groceries, and bills aren't included either." />
              </h3>
              {plan.discretionaryBreakdown.length === 0 ? (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  No discretionary spending detected yet in your recent history - the Balanced and Aggressive plans below will
                  look the same as Stay the Course until there's more data, or you free up cash some other way.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {plan.discretionaryBreakdown.map((c) => (
                    <div key={c.categoryId} className="flex items-center gap-2 text-sm">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                      <span className="flex-1 truncate">{c.name}</span>
                      <span className="font-medium">{formatCurrency(c.avgMonthlyCents)}/mo</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 text-sm pt-1.5 border-t font-semibold">
                    <span className="flex-1">Total available to redirect</span>
                    <span>{formatCurrency(plan.discretionaryTotalCents)}/mo</span>
                  </div>
                </div>
              )}
            </div>

            {/* Scenarios */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2 flex items-center gap-1.5">
                <Clock size={13} /> Your Payoff Options
              </h3>
              <div className="grid sm:grid-cols-3 gap-3">
                {plan.scenarios.map((s) => {
                  const Icon = SCENARIO_ICON[s.key];
                  const interestSaved = baseline && s.key !== "minimum" ? baseline.totalInterestCents - s.totalInterestCents : 0;
                  const timeSaved = baseline && s.key !== "minimum" && baseline.monthsToPayoff != null && s.monthsToPayoff != null
                    ? baseline.monthsToPayoff - s.monthsToPayoff : 0;
                  return (
                    <div
                      key={s.key}
                      className={`border rounded-xl p-4 flex flex-col gap-2 ${
                        s.key === "aggressive" ? "border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.04)]" : ""
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon size={15} className={s.key === "aggressive" ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]"} />
                        <span className="text-sm font-semibold">{s.label}</span>
                      </div>
                      <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-snug">{SCENARIO_DESC[s.key]}</p>
                      <div className="mt-1">
                        <p className="text-2xl font-black tabular-nums">{monthsLabel(s.monthsToPayoff)}</p>
                        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                          {s.payoffDate ? `Debt-free by ${s.payoffDate}` : "at current minimums"}
                        </p>
                      </div>
                      <div className="text-xs space-y-1 pt-2 border-t mt-1">
                        <div className="flex justify-between">
                          <span className="text-[hsl(var(--muted-foreground))]">Extra/mo</span>
                          <span className="font-medium">{formatCurrency(s.extraMonthlyCents)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[hsl(var(--muted-foreground))]">Cushion kept/mo</span>
                          <span className="font-medium">{formatCurrency(s.cushionCents)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[hsl(var(--muted-foreground))]">Total interest</span>
                          <span className="font-medium">{formatCurrency(s.totalInterestCents)}</span>
                        </div>
                        {s.key !== "minimum" && baseline && (timeSaved > 0 || interestSaved > 0) && (
                          <div className="flex justify-between text-green-600">
                            <span>vs. Stay the Course</span>
                            <span className="font-medium text-right">
                              {timeSaved > 0 ? `${monthsLabel(timeSaved)} faster` : ""}
                              {timeSaved > 0 && interestSaved > 0 ? " · " : ""}
                              {interestSaved > 0 ? `${formatCurrency(interestSaved)} saved` : ""}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

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
