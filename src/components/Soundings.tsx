import { useMemo } from "react";
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot, ResponsiveContainer } from "recharts";
import StatRow, { type StatItem } from "@/components/StatRow";
import TrendChip from "@/components/TrendChip";
import CountUp from "@/components/CountUp";
import { formatCurrency, formatAxisCurrency } from "@/lib/utils";
import { series, chartTooltipStyle, chartTooltipText, chartTooltipWrapper, axisTick } from "@/lib/chartTheme";
import { describeSounding, monthLong, monthShort, type Sounding } from "@/lib/soundings";

/**
 * Net worth read as depth. Zero is a waterline drawn across the plot: everything owned rises
 * above it, everything owed hangs below it, and the net line runs between the two. When the
 * household is under water, the measured pace continues as a gold ray to the month it surfaces.
 *
 * Length from a shared baseline does the quantitative work (never a gauge or a dial), and the
 * net line is the only high-contrast mark on the chart so the eye lands on it first.
 */
interface SoundingsProps {
  sounding: Sounding;
  /** Completes "This profile" / "Combined, unlocked profiles" above the figures. */
  scopeLabel: string;
}

/** Months of recorded history drawn. Older soundings stay in the figures, not the plot. */
const HISTORY_CAP = 24;
/** A ray longer than this is drawn running off the plot rather than squeezing the history. */
const PROJECTION_CAP = 36;

interface Row {
  month: string;
  assets: number | null;
  owed: number | null;
  net: number | null;
  projected: number | null;
}

/** The second figure: what the pace means, phrased for whichever side of the waterline we are on. */
function crossingStat(s: Sounding): StatItem | null {
  const pace = s.paceCentsPerMonth;
  const paceHint = pace == null
    ? undefined
    : pace === 0
      ? `Level over ${s.paceMonths} months`
      : `${pace > 0 ? "Up" : "Down"} ${formatCurrency(Math.abs(pace))} a month over ${s.paceMonths} months`;

  switch (s.crossing.kind) {
    case "projected":
      return {
        label: "Clears zero",
        tone: "gold",
        value: monthLong(s.crossing.month),
        hint: paceHint,
      };
    case "distant":
      return {
        label: "Clears zero",
        tone: "muted",
        value: `${Math.floor(s.crossing.monthsAway / 12)}+ years out`,
        hint: paceHint,
      };
    case "above":
      return {
        label: "Above water",
        tone: "success",
        value: s.crossing.sinceMonth ? `Since ${monthLong(s.crossing.sinceMonth)}` : "All recorded history",
        hint: paceHint,
      };
    case "sinking":
      return {
        label: "Pace",
        tone: pace === 0 ? "muted" : "error",
        value: pace === 0 ? "Holding steady" : `${formatCurrency(Math.abs(pace ?? 0))} a month`,
        hint: pace === 0 ? `Level over ${s.paceMonths} months` : "Moving away from the waterline",
      };
    default:
      return null;
  }
}

export default function Soundings({ sounding: s, scopeLabel }: SoundingsProps) {
  const rows = useMemo<Row[]>(() => {
    const history = s.points.slice(-HISTORY_CAP);
    const projection = s.projection.slice(0, PROJECTION_CAP);
    const out: Row[] = history.map((p, i) => ({
      month: p.month,
      assets: p.liquidCents + p.investmentCents,
      owed: p.debtCents + p.loanDebtCents,
      net: p.netWorthCents,
      // The ray leaves the last recorded sounding, so the dashes meet the solid line.
      projected: i === history.length - 1 && projection.length > 0 ? p.netWorthCents : null,
    }));
    for (const q of projection) {
      out.push({ month: q.month, assets: null, owed: null, net: null, projected: q.netWorthCents });
    }
    return out;
  }, [s]);

  if (!s.latest) return null;

  const latest = s.latest;
  const assets = latest.liquidCents + latest.investmentCents;
  const owed = latest.debtCents + latest.loanDebtCents;
  const sentence = describeSounding(s);
  const crossing = crossingStat(s);
  // Only mark the surfacing point when the whole ray fits; a truncated ray never reaches it.
  const markCrossing = s.crossing.kind === "projected" && s.projection.length <= PROJECTION_CAP;
  const lastRecordedMonth = s.points[s.points.length - 1].month;

  const items: StatItem[] = [
    {
      label: "Net worth",
      hero: true,
      tone: latest.netWorthCents >= 0 ? "success" : "error",
      value: <CountUp value={latest.netWorthCents} format={(v) => formatCurrency(Math.round(v))} />,
      hint: s.changeMonthCents != null ? <TrendChip deltaCents={s.changeMonthCents} compareLabel="since last month" /> : undefined,
    },
    ...(crossing ? [crossing] : []),
    { label: "What you own", value: formatCurrency(assets), hint: `${formatCurrency(latest.liquidCents)} cash, ${formatCurrency(latest.investmentCents)} invested` },
    { label: "What you owe", tone: owed < 0 ? "error" : "default", value: formatCurrency(Math.abs(owed)), hint: `${formatCurrency(Math.abs(latest.debtCents))} cards, ${formatCurrency(Math.abs(latest.loanDebtCents))} loans` },
  ];

  return (
    <div className="soundings">
      <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{scopeLabel}</p>
      <StatRow className="mt-2" items={items} heroSize="xl" ariaLabel="Net worth soundings" />
      <p className="text-sm text-[hsl(var(--muted-foreground))] mt-4 max-w-[70ch]">{sentence}</p>

      {rows.length > 1 && (
        <div
          className="soundings-plot mt-3"
          role="img"
          aria-label={`Net worth by month from ${monthLong(s.points[0].month)} to ${monthLong(lastRecordedMonth)}, latest ${formatCurrency(latest.netWorthCents)}. ${sentence}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            {/* The right margin leaves room for the crossing month printed above its marker,
                which sits at the very end of the ray. */}
            <ComposedChart data={rows} margin={{ top: 8, right: 48, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="soundingsOwned" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={series.balance} stopOpacity={0.26} />
                  <stop offset="100%" stopColor={series.balance} stopOpacity={0.01} />
                </linearGradient>
                <linearGradient id="soundingsOwed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--error))" stopOpacity={0.02} />
                  <stop offset="100%" stopColor="hsl(var(--error))" stopOpacity={0.2} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="month"
                tick={axisTick}
                tickLine={false}
                axisLine={false}
                minTickGap={44}
                tickFormatter={(m: string) => monthShort(m)}
              />
              <YAxis
                tick={axisTick}
                tickLine={false}
                axisLine={false}
                width={54}
                tickFormatter={(v: number) => formatAxisCurrency(v)}
              />
              <Tooltip
                contentStyle={chartTooltipStyle}
                labelStyle={chartTooltipText}
                itemStyle={chartTooltipText}
                wrapperStyle={chartTooltipWrapper}
                labelFormatter={(m) => monthLong(String(m))}
                formatter={(value, name) => [formatCurrency(Number(value)), String(name)]}
              />
              <Area type="monotone" dataKey="assets" name="Owned" stroke="none" fill="url(#soundingsOwned)" connectNulls={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="owed" name="Owed" stroke="none" fill="url(#soundingsOwed)" connectNulls={false} isAnimationActive={false} />
              {/* The waterline: the one baseline every length on this plot is measured from. */}
              <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.55} strokeWidth={1.5} />
              {s.projection.length > 0 && (
                <ReferenceLine
                  x={lastRecordedMonth}
                  stroke="hsl(var(--muted-foreground))"
                  strokeOpacity={0.5}
                  strokeDasharray="2 4"
                  label={{ value: "Today", position: "insideTopRight", fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
              )}
              <Line type="monotone" dataKey="net" name="Net worth" stroke="hsl(var(--foreground))" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="projected" name="At this pace" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="7 3" dot={false} connectNulls={false} isAnimationActive={false} />
              {markCrossing && s.crossing.kind === "projected" && (
                <ReferenceDot
                  x={s.crossing.month}
                  y={0}
                  r={4.5}
                  fill="hsl(var(--background))"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  label={{ value: monthShort(s.crossing.month), position: "top", fontSize: 11, fill: "hsl(var(--gold-ink))" }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
