import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { PlayIcon, PauseIcon, ArrowCounterClockwiseIcon, ArrowDownRightIcon, ArrowUpRightIcon, SparkleIcon } from "@phosphor-icons/react";
import MoneyFlowMap, { type FlowSelection } from "@/components/MoneyFlowMap";
import { buildPlanCalendar, buildPlanFlow } from "@/lib/planViews";
import type { ForecastResult } from "@/lib/forecast";
import { formatAxisCurrency, formatCurrency, formatCurrencyWhole, formatDate } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import { useIsDark } from "@/hooks/useIsDark";

/**
 * The Plan page's second and third ways to read the forecast (#123). Both draw the scenario
 * projection the line chart draws, so the figures agree everywhere.
 */

interface ViewProps {
  /** The scenario projection (identical to expected when nothing is changed). */
  result: ForecastResult;
  startingBalanceCents: number;
  bufferCents: number;
  typicalDailyCents: number;
  scenarioChanged: boolean;
}

const compact = (cents: number) => `${cents < 0 ? "-" : ""}${formatAxisCurrency(Math.abs(cents))}`;

/** The money map: this window's money as currents, scrubbable day by day like the Chart page. */
export function PlanMapView({ result, startingBalanceCents, bufferCents, typicalDailyCents, scenarioChanged }: ViewProps) {
  const reduced = useAppReducedMotion();
  const dark = useIsDark();
  const flow = useMemo(
    () => buildPlanFlow({ result, startingBalanceCents, bufferCents, typicalDailyCents }),
    [result, startingBalanceCents, bufferCents, typicalDailyCents]
  );
  const last = Math.max(0, flow.days - 1);
  const [day, setDay] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<FlowSelection | null>(null);
  const shown = day === null ? last : Math.min(day, last);

  useEffect(() => {
    if (!playing || reduced) return;
    if (shown >= last) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setDay(shown + 1), 420);
    const stop = () => setPlaying(false);
    document.addEventListener("visibilitychange", stop);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", stop); };
  }, [playing, reduced, shown, last]);

  // Ids are stable across slider drags (keyed by name/category), so a selection survives them;
  // one that no longer exists after a window change simply lapses.
  const active = selected && (selected.type === "node" ? flow.nodes.some((n) => n.id === selected.id) : flow.edges.some((e) => e.id === selected.id)) ? selected : null;
  const node = active?.type === "node" ? flow.nodes.find((n) => n.id === active.id) : undefined;
  const edge = active?.type === "edge" ? flow.edges.find((e) => e.id === active.id) : undefined;
  const label = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;
  const date = result.days[shown]?.date ?? "";
  const totalIn = flow.nodes.filter((n) => n.column === 0).reduce((s, n) => s + n.cents, 0);

  if (flow.edges.length === 0) {
    return <p className="text-sm text-[hsl(var(--muted-foreground))] py-10 text-center">Nothing moves in this window yet. Add a paycheck or a bill below and it will appear here.</p>;
  }

  return (
    <section className="plan-map" aria-label="Money map">
      <div className="workspace-heading mb-1">
        <div>
          <h2 className="font-semibold">Money map</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-xl">
            Where this window's money comes from and where it goes{scenarioChanged ? ", your what-ifs in gold" : ""}. Each ribbon is as wide as the money; scrub to watch it move.
          </p>
        </div>
      </div>
      <div className="flow-scroll">
        <MoneyFlowMap
          flow={flow} day={shown} selected={active} onSelect={setSelected} mode={dark ? "dark" : "light"} reduced={reduced} burstKey={0} height={360}
          captions={{ 0: "Comes from", 1: "Through", 2: "Goes to" }}
          summary={`Money map to ${formatDate(result.days[last]?.date ?? "")}: ${formatCurrencyWhole(totalIn)} available across ${flow.nodes.filter((n) => n.column === 0).length} sources, spread over ${flow.nodes.filter((n) => n.column === 2).length} uses.`}
        />
      </div>
      <div className="flow-transport">
        {!reduced && (
          <button type="button" className="workspace-icon" title={playing ? "Pause the window" : "Play the window"} aria-label={playing ? "Pause the window" : "Play the window"}
            onClick={() => { if (shown >= last) setDay(0); setPlaying((p) => !p); }}>
            {playing ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
          </button>
        )}
        <button type="button" className="workspace-icon" title="Show the whole window" aria-label="Show the whole window" onClick={() => { setPlaying(false); setDay(null); }}>
          <ArrowCounterClockwiseIcon size={16} />
        </button>
        <input
          type="range" className="instrument-range" min={0} max={last} step={1} value={shown}
          style={{ "--fill": `${last > 0 ? (shown / last) * 100 : 100}%` } as CSSProperties}
          aria-label="Money map day" aria-valuetext={formatDate(date)}
          onChange={(event) => { setPlaying(false); setDay(Number(event.target.value)); }}
        />
        <time dateTime={date}>{formatDate(date)}</time>
      </div>
      <p className="plan-view-note" role="status">
        {node ? <><span className="font-medium text-[hsl(var(--foreground))]">{node.label}</span>: {formatCurrency(node.cents)} in this window.</>
          : edge ? <><span className="font-medium text-[hsl(var(--foreground))]">{label(edge.source)} → {label(edge.target)}</span>: {formatCurrency(edge.cents)}, {formatCurrency(edge.daily[shown] ?? edge.cents)} of it by {formatDate(date)}.</>
          : "Select a ribbon or a place to isolate it."}
      </p>
    </section>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The calendar: the window as weeks, each day shaded by its end-of-day balance. */
export function PlanCalendarView({ result, bufferCents }: Pick<ViewProps, "result" | "bufferCents">) {
  const calendar = useMemo(() => buildPlanCalendar(result, bufferCents), [result, bufferCents]);
  const days = calendar.weeks.flat().filter((d): d is NonNullable<typeof d> => d !== null);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = days.find((d) => d.date === picked) ?? days.find((d) => d.events.length > 0) ?? days[0];
  if (!selected) return null;

  return (
    <section className="plan-calendar" aria-label="Forecast calendar">
      <div className="workspace-heading mb-3">
        <div>
          <h2 className="font-semibold">Calendar</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-xl">
            Your balance at the end of each day. Brighter days hold more; amber falls below your cushion, red below zero.
          </p>
        </div>
        <p className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums">Range {formatCurrency(calendar.lowCents)} to {formatCurrency(calendar.highCents)}</p>
      </div>
      <div className="plan-cal" role="group" aria-label="Days in this forecast">
        {WEEKDAYS.map((name) => <span key={name} className="plan-cal-weekday" aria-hidden="true">{name}</span>)}
        {calendar.weeks.flat().map((day, index) => day === null
          ? <span key={`pad-${index}`} className="plan-cal-pad" aria-hidden="true" />
          : (
            <button
              key={day.date}
              type="button"
              className="plan-cal-day"
              data-tone={day.tone}
              aria-pressed={day.date === selected.date}
              aria-label={`${formatDate(day.date)}: ${formatCurrency(day.balanceCents)} at the end of the day${day.events.length ? `, ${day.events.map((e) => `${e.description} ${formatCurrency(e.amountCents)}`).join(", ")}` : ""}`}
              style={{ "--level": day.level.toFixed(3) } as CSSProperties}
              onClick={() => setPicked(day.date)}
            >
              <span className="plan-cal-date">{day.dayOfMonth === 1 || day.date === days[0].date ? `${MONTHS[Number(day.date.slice(5, 7)) - 1]} ${day.dayOfMonth}` : day.dayOfMonth}</span>
              <strong className="tabular-nums">{compact(day.balanceCents)}</strong>
              <span className="plan-cal-pips" aria-hidden="true">
                {day.inCents > 0 && <i data-kind="in" />}
                {day.outCents > 0 && <i data-kind="out" />}
                {day.oneOffCents !== 0 && <i data-kind="whatif" />}
              </span>
            </button>
          ))}
      </div>
      <p className="plan-cal-legend" aria-hidden="true">
        <span><span className="plan-cal-pips"><i data-kind="in" /></span>Money in</span>
        <span><span className="plan-cal-pips"><i data-kind="out" /></span>Money out</span>
        <span><span className="plan-cal-pips"><i data-kind="whatif" /></span>One-off what-if</span>
      </p>
      <div className="plan-cal-detail" aria-live="polite">
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          {formatDate(selected.date)}: <span className="font-medium text-[hsl(var(--foreground))]">{formatCurrency(selected.balanceCents)}</span> at the end of the day
          {selected.tone === "short" ? ", below zero" : selected.tone === "below" ? ", below your cushion" : ""}
        </p>
        {selected.events.length === 0 && selected.oneOffCents === 0
          ? <p className="text-xs text-[hsl(var(--muted-foreground))] py-2">Nothing scheduled on this day.</p>
          : <div className="horizon-events">
            {selected.events.map((e) => (
              <div key={e.key} className="horizon-event">
                {e.amountCents < 0 ? <ArrowDownRightIcon size={15} /> : <ArrowUpRightIcon size={15} />}
                <span>{e.description}<small>{e.source === "rule" ? "Confirmed schedule" : "Detected estimate"}</small></span>
                <strong style={{ color: e.amountCents < 0 ? "hsl(var(--error))" : "hsl(var(--success))" }}>{formatCurrency(e.amountCents)}</strong>
              </div>
            ))}
            {selected.oneOffCents !== 0 && (
              <div className="horizon-event">
                <SparkleIcon size={15} style={{ color: "var(--gold)" }} />
                <span>{selected.oneOffCents < 0 ? "Purchase preview" : "One-off money in"}<small>Hypothetical, not recorded</small></span>
                <strong style={{ color: "var(--gold)" }}>{formatCurrency(selected.oneOffCents)}</strong>
              </div>
            )}
          </div>}
      </div>
    </section>
  );
}
