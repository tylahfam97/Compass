import type { Insight, InsightRichData } from "@/lib/types";
import { formatCurrency, formatCurrencyWhole } from "@/lib/utils";
import { harmonizeColor } from "@/lib/chartTheme";
import { useIsDark } from "@/hooks/useIsDark";
import RankedBars from "@/components/RankedBars";

/**
 * The expandable detail under an insight row. Every visualizer is a length on a track or a
 * short list, in the same fills as the page's Fixed and flexible instrument, so a row's detail
 * reads as a slice of the big picture rather than a card of its own.
 */

const SEGMENT_CLASS: Record<NonNullable<InsightRichData["shareBar"]>["segments"][number]["kind"], string> = {
  bills: "bearing-seg-committed",
  recurring: "bearing-seg-due",
  flexible: "bearing-seg-spent",
  left: "bearing-seg-free",
  unknown: "bearing-seg-unknown",
};

export function hasDetail(insight: Insight): boolean {
  const r = insight.richData;
  if (!r) return false;
  return !!(
    (r.items && r.items.length > 0) ||
    (r.timeline && r.timeline.length > 0) ||
    (r.shareBar && r.shareBar.segments.length > 0) ||
    r.streakMonths !== undefined ||
    (r.beforeAmount !== undefined && r.afterAmount !== undefined) ||
    (r.paceMonthly !== undefined && r.avgMonthly !== undefined) ||
    r.runwayMonths !== undefined ||
    r.currentRate !== undefined
  );
}

function weekdayDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric" }).format(new Date(`${iso}T12:00:00`));
}

function Track({ children, over = false, className = "" }: { children: React.ReactNode; over?: boolean; className?: string }) {
  return <div className={`bearing-track ${over ? "bearing-track-over" : ""} ${className}`}>{children}</div>;
}

function ShareBar({ segments }: { segments: NonNullable<InsightRichData["shareBar"]>["segments"] }) {
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.cents), 0);
  if (total <= 0) return null;
  return (
    <div>
      <Track>
        {segments.filter((s) => s.cents > 0).map((s) => (
          <div key={s.label} className={`bearing-seg ${SEGMENT_CLASS[s.kind]}`} style={{ width: `${(s.cents / total) * 100}%` }} />
        ))}
      </Track>
      <div className="share-legend">
        {segments.map((s) => (
          <span key={s.label}>
            <i className={`share-swatch ${SEGMENT_CLASS[s.kind]}`} aria-hidden="true" />
            <span className="text-[hsl(var(--muted-foreground))]">{s.label}</span>
            <strong className="tabular-nums font-medium">{formatCurrencyWhole(s.cents)}</strong>
            <span className="text-[hsl(var(--muted-foreground))]">{Math.round((Math.max(0, s.cents) / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function StreakDots({ months }: { months: number }) {
  const dots = Math.min(Math.max(months + 1, 4), 8);
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: dots }).map((_, i) => (
          <span key={i} className="streak-dot" data-filled={i < months ? "true" : undefined} />
        ))}
      </div>
      <span className="text-xs text-[hsl(var(--muted-foreground))]">{months} {months === 1 ? "month" : "months"} in a row</span>
    </div>
  );
}

function BeforeAfter({ before, after }: { before: number; after: number }) {
  const max = Math.max(before, after, 1);
  const dropPct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <div className="ranked-bar-track"><div className="ranked-bar-fill bg-[hsl(var(--muted-foreground)/0.45)]" style={{ width: `${(before / max) * 100}%` }} /></div>
        <span className="tabular-nums text-[hsl(var(--muted-foreground))]">Before {formatCurrencyWhole(before)}</span>
        <div className="ranked-bar-track"><div className="ranked-bar-fill bg-[hsl(var(--primary))]" style={{ width: `${(after / max) * 100}%` }} /></div>
        <span className="tabular-nums">Now {formatCurrencyWhole(after)}{dropPct > 0 ? `, down ${dropPct}%` : ""}</span>
      </div>
    </div>
  );
}

function Pace({ pace, avg }: { pace: number; avg: number }) {
  const max = Math.max(pace, avg, 1);
  const avgPct = (avg / max) * 100;
  const overPct = pace > avg ? ((pace - avg) / max) * 100 : 0;
  return (
    <div>
      <Track>
        <div className="bearing-seg bearing-seg-spent" style={{ width: `${avgPct}%` }} />
        {overPct > 0 && <div className="bearing-seg bearing-seg-over" style={{ width: `${overPct}%` }} />}
      </Track>
      <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2 tabular-nums">Pace {formatCurrencyWhole(pace)} a month against a {formatCurrencyWhole(avg)} average</p>
    </div>
  );
}

function Runway({ months }: { months: number }) {
  const MAX = 12;
  const pct = Math.min(100, (Math.min(months, MAX) / MAX) * 100);
  const fill = months < 1 ? "hsl(var(--error))" : months < 3 ? "hsl(var(--warning))" : "hsl(var(--foreground) / 0.55)";
  return (
    <div>
      <div className="bearing-track mt-5">
        <div className="bearing-seg" style={{ width: `${pct}%`, background: fill }} />
        {[1, 3, 6].map((m) => (
          <span key={m} className="bearing-tick" style={{ left: `${(m / MAX) * 100}%` }} aria-hidden="true"><small>{m} mo</small></span>
        ))}
      </div>
      <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
        {months < 1 ? "Less than a month of expenses covered" : `About ${months.toFixed(1)} months of expenses covered`}
      </p>
    </div>
  );
}

function RateTrack({ current, target, label }: { current: number; target: number; label?: string }) {
  const MAX = 0.4;
  const pct = Math.max(0, Math.min(100, (current / MAX) * 100));
  const targetPct = Math.max(0, Math.min(100, (target / MAX) * 100));
  const fill = current >= target ? "hsl(var(--primary))" : current >= target * 0.7 ? "hsl(var(--foreground) / 0.55)" : "hsl(var(--warning))";
  return (
    <div>
      <div className="bearing-track mt-5">
        <div className="bearing-seg" style={{ width: `${pct}%`, background: fill }} />
        <span className="bearing-tick" style={{ left: `${targetPct}%` }} aria-hidden="true"><small>{Math.round(target * 100)}% target</small></span>
      </div>
      <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">{label ?? "Current rate"} {Math.round(current * 100)}%, on a 0 to 40% scale</p>
    </div>
  );
}

export default function InsightDetail({ insight }: { insight: Insight }) {
  const isDark = useIsDark();
  const r = insight.richData;
  if (!r) return null;
  const mode = isDark ? "dark" : "light";

  if (r.items && r.items.length > 0) {
    return (
      <RankedBars
        items={r.items.slice(0, 5).map((i) => ({
          key: i.label,
          name: i.label,
          value: i.valueCents,
          color: i.color ? harmonizeColor(i.color, mode) : "hsl(var(--muted-foreground) / 0.6)",
        }))}
        formatValue={formatCurrency}
        context={insight.period ?? "this month"}
        showPct={false}
      />
    );
  }
  if (r.timeline && r.timeline.length > 0) {
    return (
      <ol className="insight-timeline">
        {r.timeline.map((t) => (
          <li key={`${t.date}-${t.label}`}>
            <span className="text-[hsl(var(--muted-foreground))]">{weekdayDay(t.date)}</span>
            <span className="truncate">{t.label}{t.kind === "detected" && <span className="text-[hsl(var(--muted-foreground))]"> detected</span>}</span>
            <span className="tabular-nums">{formatCurrency(t.cents)}</span>
          </li>
        ))}
      </ol>
    );
  }
  if (r.shareBar && r.shareBar.segments.length > 0) return <ShareBar segments={r.shareBar.segments} />;
  if (r.streakMonths !== undefined) return <StreakDots months={r.streakMonths} />;
  if (r.beforeAmount !== undefined && r.afterAmount !== undefined) return <BeforeAfter before={r.beforeAmount} after={r.afterAmount} />;
  if (r.paceMonthly !== undefined && r.avgMonthly !== undefined) return <Pace pace={r.paceMonthly} avg={r.avgMonthly} />;
  if (r.runwayMonths !== undefined) return <Runway months={r.runwayMonths} />;
  if (r.currentRate !== undefined) return <RateTrack current={r.currentRate} target={r.targetRate ?? 0.2} label={r.rateLabel} />;
  return null;
}
