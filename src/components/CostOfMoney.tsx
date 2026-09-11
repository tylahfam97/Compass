import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import type { CostOfMoneySummary } from "@/lib/costOfMoney";
import { accruedToday } from "@/lib/costOfMoney";
import { formatCurrency, formatCurrencyWhole, cn } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import StatRow from "@/components/StatRow";
import CountUp from "@/components/CountUp";
import InfoTooltip from "@/components/InfoTooltip";

/**
 * The Insights page's second instrument: what money cost last month against what it earned,
 * with a live accrual for today. Interest paid is read from card statement lines and estimated
 * for loans from their APR; interest and dividends earned come from bank and brokerage rows.
 * The yield forgone on idle checking is the one assumption on the page, and it is editable.
 */
interface CostOfMoneyProps {
  summary: CostOfMoneySummary;
  /** "August, the last complete month" */
  monthLabel: string;
  onYieldChange: (bps: number) => void;
  className?: string;
}

const EASE = [0.2, 0.7, 0.2, 1] as const;

function signed(cents: number): string {
  return `${cents > 0 ? "+" : cents < 0 ? "-" : ""}${formatCurrency(Math.abs(cents))}`;
}

export default function CostOfMoney({ summary, monthLabel, onYieldChange, className }: CostOfMoneyProps) {
  const reduced = useAppReducedMotion();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, [reduced]);

  const hasAnything = summary.paidCents > 0 || summary.earnedCents > 0 || summary.perAccount.some((a) => a.balanceCents > 0) || summary.idleCents > 0;
  const net = summary.netCents;
  const heroTone = net < 0 ? "hsl(var(--error))" : net > 0 ? "hsl(var(--success))" : "hsl(var(--muted-foreground))";
  const heroLabel = net < 0 ? "Your money cost you" : net > 0 ? "Your money earned you" : "Your money broke even";

  const dailyNet = summary.dailyEarnCents - summary.dailyCostCents;
  const soFar = reduced ? dailyNet : accruedToday(dailyNet, now);
  const forgoneSoFar = reduced ? summary.dailyForgoneCents : accruedToday(summary.dailyForgoneCents, now);
  const shown = summary.perAccount.filter((a) => a.balanceCents > 0).slice(0, 4);

  // Track: paid and earned as lengths of the larger of the two, so the ratio reads at a glance.
  const track = Math.max(summary.paidCents, summary.earnedCents, 1);
  const pct = (cents: number) => `${Math.max(0, Math.min(100, (cents / track) * 100))}%`;

  return (
    <section className={cn("cost-of-money", className)} aria-labelledby="cost-of-money-title">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h3 id="cost-of-money-title" className="text-[15px] font-semibold leading-tight flex items-center gap-1.5">
            Cost of money
            <InfoTooltip text="Interest paid is read from the interest lines on your card statements and estimated for loans from the balance and APR on file. Interest and dividends earned come from interest lines on your bank accounts and dividend and interest rows on brokerage statements. Idle cash is your average checking balance above the reserve you set in Plan; the yield it could earn is an assumption you can change here, not a measurement." />
          </h3>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{monthLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{heroLabel}</p>
          <p className="hero-figure" style={{ color: heroTone }}>
            <CountUp value={Math.abs(net)} format={(v) => formatCurrencyWhole(Math.round(v))} />
          </p>
        </div>
      </div>

      {!hasAnything ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-4 max-w-[60ch]">
          No interest paid or earned turned up in {monthLabel.split(",")[0]}. Card statements with interest lines, loans with an APR, and brokerage statements feed this instrument.
        </p>
      ) : (
        <>
          <StatRow
            size="sm"
            columns={3}
            className="mt-4"
            ariaLabel="Cost of money last month"
            items={[
              {
                label: "Paid in interest",
                value: formatCurrencyWhole(summary.paidCents),
                tone: summary.paidCents > 0 ? "error" : "default",
                hint: summary.paidCents > 0
                  ? [summary.paidCardCents > 0 ? `${formatCurrencyWhole(summary.paidCardCents)} on cards, measured` : null, summary.paidLoanCents > 0 ? `${formatCurrencyWhole(summary.paidLoanCents)} on loans, estimated` : null].filter(Boolean).join("; ")
                  : "No interest lines found",
              },
              {
                label: "Earned in interest and dividends",
                value: formatCurrencyWhole(summary.earnedCents),
                tone: summary.earnedCents > 0 ? "success" : "default",
                hint: summary.earnedCents > 0
                  ? [summary.earnedBankCents > 0 ? `${formatCurrencyWhole(summary.earnedBankCents)} bank interest` : null, summary.earnedInvestmentCents > 0 ? `${formatCurrencyWhole(summary.earnedInvestmentCents)} dividends and interest` : null].filter(Boolean).join("; ")
                  : "Nothing recorded",
              },
              {
                label: "Left on the table",
                value: formatCurrencyWhole(summary.forgoneCents),
                tone: "muted",
                hint: summary.idleCents > 0
                  ? `${formatCurrencyWhole(summary.idleCents)} idle in checking at ${(summary.assumedYieldBps / 100).toFixed(2)}%, an assumption`
                  : summary.reserveCents > 0 ? "Checking stayed within your reserve" : "No checking balance on record",
              },
            ]}
          />

          <div className="cost-tracks mt-5" aria-hidden="true">
            <div className="cost-track-row">
              <span>Paid</span>
              <div className="cost-track"><motion.i className="cost-fill-paid" style={{ width: pct(summary.paidCents) }} initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.4, ease: EASE }} /></div>
            </div>
            <div className="cost-track-row">
              <span>Earned</span>
              <div className="cost-track"><motion.i className="cost-fill-earned" style={{ width: pct(summary.earnedCents) }} initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.4, ease: EASE }} /></div>
            </div>
          </div>

          {/* Today, live: the balances on file accruing by the second. */}
          <div className="cost-today mt-5">
            <div>
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{reduced ? "Each day at today's balances" : "So far today"}</p>
              <p className="text-[22px] leading-tight font-medium tabular-nums mt-1" style={{ color: dailyNet < 0 ? "hsl(var(--error))" : dailyNet > 0 ? "hsl(var(--success))" : undefined }}>
                {signed(Math.round(soFar))}
              </p>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1">
                {summary.dailyCostCents > 0 ? `${formatCurrency(Math.round(summary.dailyCostCents))} a day in interest on ${summary.perAccount.filter((a) => a.dailyCents > 0).length} ${summary.perAccount.filter((a) => a.dailyCents > 0).length === 1 ? "account" : "accounts"}` : "No interest accruing on the balances on file"}
                {summary.dailyEarnCents > 0 ? `; earning about ${formatCurrency(Math.round(summary.dailyEarnCents))} a day at last month's pace` : ""}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{reduced ? "Forgone each day on idle cash" : "Forgone so far today"}</p>
              <p className="text-[22px] leading-tight font-medium tabular-nums mt-1 text-[hsl(var(--muted-foreground))]">{formatCurrency(Math.round(forgoneSoFar))}</p>
              <label className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1 flex items-center gap-1.5 flex-wrap">
                Assuming a savings yield of
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={0.05}
                  value={(summary.assumedYieldBps / 100).toFixed(2)}
                  aria-label="Assumed savings yield, percent a year"
                  onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onYieldChange(Math.round(Math.max(0, Math.min(20, v)) * 100)); }}
                  className="w-[68px] border rounded-md bg-[hsl(var(--surface))] px-2 py-0.5 text-[11px] tabular-nums text-[hsl(var(--foreground))]"
                />
                % a year{summary.reserveCents > 0 ? `, above your ${formatCurrencyWhole(summary.reserveCents)} reserve` : ""}.
                {summary.reserveCents === 0 && <> <Link to="/plan" className="text-[hsl(var(--gold-ink))] hover:underline">Set a reserve in Plan</Link> to keep your cushion out of this.</>}
              </label>
            </div>
          </div>

          {shown.length > 0 && (
            <div className="mt-5">
              {shown.map((a) => (
                <div key={a.id} className="cost-account-row">
                  <span className="min-w-0 truncate text-sm font-medium">{a.name}</span>
                  <span className="text-[10px] font-medium shrink-0 px-1.5 py-0.5 rounded-full border text-[hsl(var(--muted-foreground))]">{a.kind === "credit" ? "Card" : "Loan"}</span>
                  <span className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums text-right">{formatCurrency(-a.balanceCents)}</span>
                  <span className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums text-right">{a.rateBps != null ? `${(a.rateBps / 100).toFixed(2)}%` : "no rate"}</span>
                  <span className={cn("text-sm font-semibold tabular-nums text-right", a.dailyCents > 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--muted-foreground))]")}>
                    {a.dailyCents > 0 ? `${formatCurrency(Math.round(a.dailyCents))} a day` : a.kind === "credit" ? "No interest charged" : "Add an APR"}
                  </span>
                </div>
              ))}
              {summary.missingRate.length > 0 && (
                <p className="text-xs text-[hsl(var(--muted-foreground))] mt-3">
                  {summary.missingRate.length === 1 ? `${summary.missingRate[0]} has` : `${summary.missingRate.length} loans have`} no APR on file, so their interest is not counted. Add one from the account's detail view on the Dashboard.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
