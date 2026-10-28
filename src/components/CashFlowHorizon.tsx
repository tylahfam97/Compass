import { useEffect, useId, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, ResponsiveContainer, ReferenceLine, ReferenceDot, Tooltip } from "recharts";
import { PlayIcon, PauseIcon, ArrowCounterClockwiseIcon, ArrowDownRightIcon, ArrowUpRightIcon, CrosshairIcon } from "@phosphor-icons/react";
import { toISODate, type ForecastResult } from "@/lib/forecast";
import type { MonthToDate } from "@/lib/forecastData";
import { chartTooltipStyle, chartTooltipWrapper } from "@/lib/chartTheme";
import { formatAxisCurrency, formatCurrency, formatDate } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import InfoTooltip from "@/components/InfoTooltip";

interface Props {
  /** Expected: today's balance plus scheduled income and bills (and typical spending if on). */
  current: ForecastResult;
  /** Expected plus the user's what-if changes. */
  scenario: ForecastResult;
  bufferCents: number;
  typicalDailyCents: number;
  holdScale?: boolean;
  startingBalanceCents: number;
  /** Oldest of the checking balances the start figure is built from. */
  balanceAsOf: string | null;
  balanceStale: boolean;
  incomplete: boolean;
  monthToDate: MonthToDate;
}

const signed = (cents: number) => `${cents > 0 ? "+" : ""}${formatCurrency(cents)}`;

export default function CashFlowHorizon({ current, scenario, bufferCents, typicalDailyCents, holdScale = false, startingBalanceCents, balanceAsOf, balanceStale, incomplete, monthToDate }: Props) {
  const reduced = useAppReducedMotion();
  const fillId = useId();
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const selectedIndex = Math.min(selected, scenario.days.length - 1);
  const day = scenario.days[selectedIndex];
  const currentDay = current.days[selectedIndex];
  const data = scenario.days.map((value, index) => ({
    date: value.date,
    current: current.days[index].balanceCents,
    changed: value.balanceCents,
    difference: [value.balanceCents, current.days[index].balanceCents],
  }));
  const extent = [...current.days, ...scenario.days].map((value) => value.balanceCents);
  const minimum = Math.min(0, ...extent);
  const maximum = Math.max(bufferCents, 1, ...extent);
  const padding = Math.max(1000, (maximum - minimum) * 0.1);
  const [heldDomain, setHeldDomain] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (holdScale) setHeldDomain((previous) => previous ?? [minimum - padding, maximum + padding]);
    else setHeldDomain(null);
  }, [holdScale, minimum, maximum, padding]);
  const domain: [number, number] = holdScale && heldDomain ? heldDomain : [minimum - padding, maximum + padding];
  const breach = scenario.days.find((value) => value.balanceCents < bufferCents);
  const hasChanges = data.some((value) => value.changed !== value.current);

  useEffect(() => {
    setPlaying(false);
  }, [scenario, reduced]);

  useEffect(() => {
    if (!playing || reduced) return;
    if (selectedIndex >= scenario.days.length - 1) { setPlaying(false); return; }
    const interval = window.setTimeout(() => setSelected((index) => index + 1), 650);
    const stop = () => setPlaying(false);
    document.addEventListener("visibilitychange", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.clearTimeout(interval);
      document.removeEventListener("visibilitychange", stop);
      window.removeEventListener("blur", stop);
    };
  }, [playing, reduced, selectedIndex, scenario.days.length]);

  if (!day || !currentDay) return null;
  const delta = day.balanceCents - currentDay.balanceCents;
  const choose = (index: number) => { setPlaying(false); setSelected(index); };
  const endDate = scenario.days[scenario.days.length - 1].date;
  const endDelta = scenario.endingBalanceCents - current.endingBalanceCents;
  // Last day of the month the window starts in, from its own local YYYY-MM-DD text.
  const [startYear, startMonth] = scenario.days[0].date.split("-").map(Number);
  const monthEnd = toISODate(new Date(startYear, startMonth, 0));
  const monthEndIndex = data.findIndex((value) => value.date === monthEnd);
  const showMonthEnd = monthEndIndex >= 0 && monthEndIndex < data.length - 1;
  const monthName = new Date(startYear, startMonth - 1, 1).toLocaleDateString(undefined, { month: "long" });
  const skipped = scenario.skippedIncome;

  return <section className="cash-horizon" aria-label="Cash-flow horizon">
    <div className="workspace-heading mb-4">
      <div><h2 className="font-semibold">Cash-flow horizon</h2><p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Your checking balance at the end of each day, from today to {formatDate(endDate)}</p></div>
      <button className="flex items-center gap-2 text-xs px-3 py-2 border rounded-md" onClick={() => choose(Math.max(0, scenario.days.findIndex((value) => value.date === scenario.lowPoint?.date)))}><CrosshairIcon size={14} /> Inspect low point</button>
    </div>

    {/* Have / will have / could have: one figure each, kept apart so actuals, the expected
        schedule and the what-if never blur into one number. */}
    <div className="horizon-glance" aria-label="Your money at a glance">
      <div data-testid="horizon-now">
        <p>Have now <InfoTooltip text="The latest recorded balance of each checking account, added together. Credit cards, savings and investments are not included." /></p>
        <strong style={{ color: startingBalanceCents < 0 ? "hsl(var(--error))" : undefined }}>{formatCurrency(startingBalanceCents)}</strong>
        <small style={{ color: incomplete || balanceStale ? "hsl(var(--warning))" : undefined }}>
          {incomplete ? "Known balances only - an account has no recorded balance"
            : balanceStale && balanceAsOf ? `Last recorded ${formatDate(balanceAsOf)} - import newer statements`
            : balanceAsOf ? `Checking, as of ${formatDate(balanceAsOf)}` : "Checking"}
        </small>
      </div>
      <div data-testid="horizon-expected">
        <p>Expected by {formatDate(endDate)} <InfoTooltip text="Have now, plus the income and bills you scheduled (and detected bills, if included). Typical spending is subtracted only when you turn it on. Not guaranteed: it assumes everything arrives as scheduled." /></p>
        <strong style={{ color: current.endingBalanceCents < 0 ? "hsl(var(--error))" : undefined }}>{formatCurrency(current.endingBalanceCents)}</strong>
        <small>{typicalDailyCents > 0 ? "Schedule plus typical spending" : "Scheduled income and bills only"}</small>
      </div>
      <div data-testid="horizon-scenario">
        <p style={{ color: "var(--gold)" }}>Your scenario by {formatDate(endDate)} <InfoTooltip text="Expected, plus the what-if changes you set in Your scenario. Hypothetical - nothing is recorded." /></p>
        <strong style={{ color: scenario.endingBalanceCents < 0 ? "hsl(var(--error))" : undefined }}>{formatCurrency(scenario.endingBalanceCents)}</strong>
        <small>{hasChanges ? `${signed(endDelta)} vs expected` : "Same as expected"}</small>
      </div>
    </div>
    <p className="horizon-basis" data-testid="horizon-month-to-date">
      <span className="font-medium text-[hsl(var(--foreground))]">{monthName} so far:</span>{" "}
      <span style={{ color: "hsl(var(--success))" }}>{formatCurrency(monthToDate.incomeCents)}</span> in,{" "}
      <span style={{ color: "hsl(var(--error))" }}>{formatCurrency(monthToDate.spentCents)}</span> spent from checking
      {" "}({monthToDate.txCount} transaction{monthToDate.txCount === 1 ? "" : "s"}{monthToDate.lastImportedDate ? `, latest on file ${formatDate(monthToDate.lastImportedDate)}` : ", none on file"}).
      {" "}{balanceAsOf && monthToDate.lastImportedDate && balanceAsOf < monthToDate.lastImportedDate
        ? "Some of these are newer than your last recorded balance, so Have now may not include them yet."
        : "Already part of Have now, not projected again."}
      {" "}Transfers and card payments are not counted as spending.
    </p>
    {showMonthEnd && <p className="horizon-basis">
      Month end ({formatDate(monthEnd)}): expected <span className="font-medium text-[hsl(var(--foreground))]">{formatCurrency(data[monthEndIndex].current)}</span>
      {hasChanges && <>, your scenario <span className="font-medium" style={{ color: "var(--gold)" }}>{formatCurrency(data[monthEndIndex].changed)}</span></>}
    </p>}

    <div className="horizon-legend">
      <span><i style={{ background: "hsl(var(--sea))" }} />Expected</span>
      <span><i style={{ borderTop: "2px dashed var(--gold)", background: "none" }} />{hasChanges ? "Your scenario" : "Your scenario (matches expected)"}</span>
      {bufferCents > 0 && <span><i style={{ borderTop: "2px dashed hsl(var(--muted-foreground))", background: "none" }} />Cash cushion {formatCurrency(bufferCents)}</span>}
      {showMonthEnd && <span><i style={{ width: 2, height: 12, background: "hsl(var(--muted-foreground))" }} />Month end</span>}
    </div>
    <div className="horizon-plot">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 22, right: 20, left: 0, bottom: 4 }} onClick={(state) => {
          const index = Number(state.activeTooltipIndex);
          if (state.activeTooltipIndex != null && Number.isInteger(index) && index >= 0 && index < data.length) choose(index);
        }}>
          <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--gold)" stopOpacity={0.2} /><stop offset="100%" stopColor="var(--gold)" stopOpacity={0.04} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="2 6" />
          <XAxis dataKey="date" tickFormatter={formatDate} minTickGap={60} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
          <YAxis domain={domain} allowDataOverflow width={68} tickFormatter={formatAxisCurrency} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
          <Tooltip wrapperStyle={chartTooltipWrapper} content={({ active, payload }) => {
            const row = payload?.[0]?.payload as (typeof data)[number] | undefined;
            if (!active || !row) return null;
            return <div style={chartTooltipStyle} className="px-3 py-2 space-y-0.5">
              <p className="font-medium">{formatDate(row.date)}</p>
              <p>Expected {formatCurrency(row.current)}</p>
              {hasChanges && <p style={{ color: "var(--gold)" }}>Your scenario {formatCurrency(row.changed)}</p>}
            </div>;
          }} />
          <ReferenceLine y={0} stroke="hsl(var(--error))" strokeDasharray="3 4" />
          {bufferCents > 0 && <ReferenceLine y={bufferCents} stroke="hsl(var(--muted-foreground))" strokeDasharray="8 4" />}
          {showMonthEnd && <ReferenceLine x={monthEnd} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.6} label={{ value: "Month end", position: "insideTopRight", fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />}
          {hasChanges && <Area type="stepAfter" dataKey="difference" stroke="none" fill={`url(#${fillId})`} isAnimationActive={false} />}
          <Area type="stepAfter" dataKey="current" stroke="hsl(var(--sea))" strokeWidth={2} fill="none" isAnimationActive={false} />
          {hasChanges && <Area type="stepAfter" dataKey="changed" stroke="var(--gold)" strokeWidth={2.5} strokeDasharray="7 3" fill="none" isAnimationActive={false} />}
          {scenario.days.filter((value) => value.events.length > 0 && value.date !== day.date).map((value) => <ReferenceDot key={value.date} x={value.date} y={Math.max(domain[0], Math.min(domain[1], value.balanceCents))} r={3} fill="hsl(var(--sea))" stroke="hsl(var(--background))" />)}
          <ReferenceLine x={day.date} stroke="hsl(var(--foreground))" strokeOpacity={0.4} />
          <ReferenceDot x={day.date} y={Math.max(domain[0], Math.min(domain[1], day.balanceCents))} r={5} stroke="hsl(var(--background))" strokeWidth={2} fill={day.balanceCents < 0 ? "hsl(var(--error))" : "var(--gold)"} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    {holdScale && (minimum < domain[0] || maximum > domain[1]) && <p role="status" className="text-xs text-[hsl(var(--muted-foreground))]">Preview extends beyond the held scale. Release the control to fit the full projection.</p>}
    <div className="horizon-transport">
      {!reduced && <button className="workspace-icon" title={playing ? "Pause forecast" : "Play forecast"} aria-label={playing ? "Pause forecast" : "Play forecast"} onClick={() => { if (selectedIndex >= data.length - 1) setSelected(0); setPlaying(!playing); }}>{playing ? <PauseIcon size={17} /> : <PlayIcon size={17} />}</button>}
      <button className="workspace-icon" title="Reset forecast playback" aria-label="Reset forecast playback" onClick={() => choose(0)}><ArrowCounterClockwiseIcon size={16} /></button>
      <input type="range" aria-label="Inspect forecast date" aria-valuetext={formatDate(day.date)} min={0} max={Math.max(0, data.length - 1)} step={1} value={selectedIndex} onChange={(event) => choose(Number(event.target.value))} />
      <time dateTime={day.date}>{formatDate(day.date)}</time>
    </div>
    <div className="horizon-inspector" aria-label="Selected forecast day">
      <div className="horizon-day-values">
        <div><p>Your scenario</p><strong style={{ color: day.balanceCents < bufferCents ? "hsl(var(--error))" : undefined }}>{formatCurrency(day.balanceCents)}</strong></div>
        <div><p>Expected</p><strong>{formatCurrency(currentDay.balanceCents)}</strong></div>
        <div><p>Difference</p><strong>{formatCurrency(delta)}</strong></div>
      </div>
      <div className="horizon-events">
        {day.events.map((event) => <div key={event.key} className="horizon-event">
          {event.amountCents < 0 ? <ArrowDownRightIcon size={15} /> : <ArrowUpRightIcon size={15} />}
          <span>{event.description}<small>{event.source === "rule" ? "Confirmed schedule" : "Detected estimate"}</small></span>
          <strong>{formatCurrency(event.amountCents)}</strong>
        </div>)}
        {skipped?.date === day.date && <div className="horizon-event"><ArrowUpRightIcon size={15} /><span>{skipped.description}<small>Skipped in your scenario</small></span><strong style={{ textDecoration: "line-through" }}>{formatCurrency(skipped.amountCents)}</strong></div>}
        {typicalDailyCents > 0 && <div className="horizon-event"><ArrowDownRightIcon size={15} /><span>Typical spending<small>History-based assumption</small></span><strong>{formatCurrency(-typicalDailyCents)}</strong></div>}
        {(day.scenarioSpendCents ?? 0) !== 0 && <div className="horizon-event">{(day.scenarioSpendCents ?? 0) > 0 ? <ArrowDownRightIcon size={15} /> : <ArrowUpRightIcon size={15} />}<span>{(day.scenarioSpendCents ?? 0) > 0 ? "Extra spending" : "Spending cut"}<small>What-if, spread across each day</small></span><strong>{formatCurrency(-(day.scenarioSpendCents ?? 0))}</strong></div>}
        {(day.scenarioIncomeCents ?? 0) > 0 && <div className="horizon-event"><ArrowUpRightIcon size={15} /><span>Extra income<small>What-if, spread across the month</small></span><strong>{formatCurrency(day.scenarioIncomeCents!)}</strong></div>}
        {(day.oneOffCents ?? 0) !== 0 && <div className="horizon-event">{day.oneOffCents! < 0 ? <ArrowDownRightIcon size={15} /> : <ArrowUpRightIcon size={15} />}<span>{day.oneOffCents! < 0 ? "Purchase preview" : "One-off money in"}<small>Hypothetical, not recorded</small></span><strong>{formatCurrency(day.oneOffCents!)}</strong></div>}
        {day.events.length === 0 && skipped?.date !== day.date && !typicalDailyCents && !day.scenarioSpendCents && !day.scenarioIncomeCents && !day.oneOffCents && <p className="text-xs text-[hsl(var(--muted-foreground))] py-2">No projected activity on this date.</p>}
      </div>
    </div>
    <p className="text-xs mt-4 text-[hsl(var(--muted-foreground))]">{breach ? `Your scenario first drops below the cash cushion on ${formatDate(breach.date)}` : "Your scenario stays above the cash cushion throughout"}</p>
  </section>;
}
