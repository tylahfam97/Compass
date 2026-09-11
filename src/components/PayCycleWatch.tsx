import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { WatchSummary } from "@/lib/payCycle";
import { formatCurrency, formatCurrencyWhole, formatDate, cn } from "@/lib/utils";
import StatRow from "@/components/StatRow";
import InfoTooltip from "@/components/InfoTooltip";

/**
 * The Watch: this pay cycle against the household's own usual curve. Past cycles are faint
 * sea lines aligned on days since payday, the usual curve is dashed, and the current cycle is
 * the gold line ending at today. The figure that matters is what each remaining day can carry
 * and still land where the cycle usually does.
 */
interface PayCycleWatchProps {
  watch: WatchSummary;
  className?: string;
}

const HEIGHT = 150;
const PAD = { top: 10, right: 12, bottom: 22, left: 44 };

export default function PayCycleWatch({ watch, className }: PayCycleWatchProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { detection, cycleDays, dayIndex, daysLeft } = watch;
  const maxCents = Math.max(1, watch.typicalTotalCents, watch.spentSoFarCents, ...watch.past.map((c) => c.totalCents));
  const innerW = Math.max(10, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (day: number) => PAD.left + (innerW * day) / Math.max(1, cycleDays - 1);
  const y = (cents: number) => PAD.top + innerH - (innerH * cents) / maxCents;
  const line = (values: number[], upTo = values.length - 1) => values.slice(0, upTo + 1).map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const ahead = watch.paceDeltaCents > 0;
  const hasHistory = watch.past.length > 0;
  const paceLabel = !hasHistory
    ? "First cycle on record"
    : Math.abs(watch.paceDeltaCents) < 1000 ? "Right on your usual pace"
    : ahead ? `${formatCurrencyWhole(watch.paceDeltaCents)} ahead of your usual pace` : `${formatCurrencyWhole(-watch.paceDeltaCents)} behind your usual pace`;
  const daysWord = daysLeft === 1 ? "day" : "days";
  const sourceNote = detection.source === "planned"
    ? "Paydays from your Plan schedule."
    : `Paydays inferred from ${detection.depositCount ?? 0} deposits of ${detection.payer ?? "your payer"}, about every ${detection.cadenceDays} days.`;

  return (
    <section className={cn("pay-watch", className)} aria-labelledby="pay-watch-title">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h3 id="pay-watch-title" className="text-[15px] font-semibold leading-tight flex items-center gap-1.5">
            This pay cycle
            <InfoTooltip text="Everyday spending since your last payday, set against the average of your past cycles aligned on the same day. Scheduled bills and detected recurring charges are left out, since they land on fixed dates regardless of pace. Card purchases count; card payments do not." />
          </h3>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
            Day {dayIndex + 1} of {cycleDays}, since {formatDate(detection.lastPayday)}. {watch.threePaycheckMonth && "A three-paycheck month. "}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Payday {formatDate(detection.nextPayday)}</p>
          <p className="hero-figure text-[hsl(var(--foreground))]">
            {daysLeft === 0 ? "Today" : <>{daysLeft} <span className="text-[20px] text-[hsl(var(--muted-foreground))] font-normal">{daysWord}</span></>}
          </p>
        </div>
      </div>

      <StatRow
        size="sm"
        columns={3}
        className="mt-4"
        ariaLabel="Pay cycle pace"
        items={[
          { label: "Spent this cycle", value: formatCurrencyWhole(watch.spentSoFarCents), hint: hasHistory ? paceLabel : "Everyday spending, bills left out", tone: hasHistory && ahead && watch.paceDeltaCents >= 1000 ? "warning" : "default" },
          { label: `Usual by day ${dayIndex + 1}`, value: hasHistory ? formatCurrencyWhole(watch.usualByNowCents) : "No past cycles yet", hint: hasHistory ? `${formatCurrencyWhole(watch.typicalTotalCents)} by payday, over ${watch.past.length} ${watch.past.length === 1 ? "cycle" : "cycles"}` : undefined },
          hasHistory && daysLeft > 0
            ? { label: "Left per day to hold your pace", value: formatCurrencyWhole(watch.leftPerDayCents), tone: "gold", hint: watch.leftPerDayCents === 0 ? "Already past your usual total" : `${daysLeft} ${daysWord} to payday` }
            : { label: "To payday", value: daysLeft === 0 ? "Today" : `${daysLeft} ${daysWord}`, hint: formatDate(detection.nextPayday) },
        ]}
      />

      <div ref={wrapRef} className="pay-watch-plot mt-4" role="img" aria-label={`Everyday spending this cycle ${formatCurrency(watch.spentSoFarCents)} by day ${dayIndex + 1}, usual ${formatCurrency(watch.usualByNowCents)}.`}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} className="block">
            <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} className="pay-watch-axis" />
            <text x={PAD.left - 6} y={y(maxCents) + 4} textAnchor="end" className="pay-watch-tick">{formatCurrencyWhole(maxCents)}</text>
            <text x={PAD.left - 6} y={y(0) + 4} textAnchor="end" className="pay-watch-tick">$0</text>
            <text x={x(0)} y={HEIGHT - 6} textAnchor="start" className="pay-watch-tick">Payday</text>
            <text x={x(cycleDays - 1)} y={HEIGHT - 6} textAnchor="end" className="pay-watch-tick">Next payday</text>
            {watch.past.map((c, i) => <path key={i} d={line(c.cumulative)} className="pay-watch-past" />)}
            {hasHistory && <path d={line(watch.typical)} className="pay-watch-typical" />}
            <path d={line(watch.current.cumulative, dayIndex)} className="pay-watch-current" />
            <circle cx={x(dayIndex)} cy={y(watch.spentSoFarCents)} r={4} className="pay-watch-today" />
            {dayIndex < cycleDays - 1 && <line x1={x(dayIndex)} x2={x(dayIndex)} y1={PAD.top} y2={y(0)} className="pay-watch-today-line" />}
          </svg>
        )}
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 mt-2 text-xs text-[hsl(var(--muted-foreground))]">
        <p className="max-w-[64ch]">
          {sourceNote}
          {detection.source === "detected" && <> <Link to="/plan" className="text-[hsl(var(--gold-ink))] hover:underline">Schedule your paycheck in Plan</Link> to make this exact.</>}
          {watch.threePaycheckMonth && <> Three paydays land this month, one more than your bills expect.</>}
        </p>
        <span className="pay-watch-legend">
          <i className="pay-watch-swatch-current" /> This cycle
          {hasHistory && <><i className="pay-watch-swatch-typical" /> Usual</>}
          {hasHistory && <><i className="pay-watch-swatch-past" /> Past cycles</>}
        </span>
      </div>
    </section>
  );
}
