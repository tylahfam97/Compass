import { useEffect, useId, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, ResponsiveContainer, ReferenceLine, ReferenceDot, Tooltip } from "recharts";
import { Play, Pause, RotateCcw, ArrowDownRight, ArrowUpRight, Crosshair } from "lucide-react";
import type { ForecastResult } from "@/lib/forecast";
import { formatAxisCurrency, formatCurrency, formatDate } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";

interface Props {
  current: ForecastResult;
  scenario: ForecastResult;
  bufferCents: number;
  typicalDailyCents: number;
  holdScale?: boolean;
}

export default function CashFlowHorizon({ current, scenario, bufferCents, typicalDailyCents, holdScale = false }: Props) {
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
  const hasChanges = scenario.assumedSpendCents !== current.assumedSpendCents;

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

  return <section className="cash-horizon" aria-label="Cash-flow horizon">
    <div className="workspace-heading mb-4">
      <div><h2 className="font-semibold">Cash-flow horizon</h2><p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Projected daily closing balances</p></div>
      <button className="flex items-center gap-2 text-xs px-3 py-2 border rounded-md" onClick={() => choose(Math.max(0, scenario.days.findIndex((value) => value.date === scenario.lowPoint?.date)))}><Crosshair size={14} /> Inspect low point</button>
    </div>
    <div className="horizon-legend">
      <span><i style={{ background: "hsl(var(--primary))" }} />Current projection</span>
      <span><i style={{ borderTop: "2px dashed var(--gold)", background: "none" }} />With changes</span>
      <span>Cash cushion {formatCurrency(bufferCents)}</span>
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
          <Tooltip content={() => null} />
          <ReferenceLine y={0} stroke="hsl(var(--error))" strokeDasharray="3 4" />
          {bufferCents > 0 && <ReferenceLine y={bufferCents} stroke="hsl(var(--muted-foreground))" strokeDasharray="8 4" />}
          {hasChanges && <Area type="stepAfter" dataKey="difference" stroke="none" fill={`url(#${fillId})`} isAnimationActive={false} />}
          <Area type="stepAfter" dataKey="current" stroke="hsl(var(--primary))" strokeWidth={2} fill="none" isAnimationActive={false} />
          {hasChanges && <Area type="stepAfter" dataKey="changed" stroke="var(--gold)" strokeWidth={2.5} strokeDasharray="7 3" fill="none" isAnimationActive={false} />}
          {scenario.days.filter((value) => value.events.length > 0 && value.date !== day.date).map((value) => <ReferenceDot key={value.date} x={value.date} y={Math.max(domain[0], Math.min(domain[1], value.balanceCents))} r={3} fill="hsl(var(--primary))" stroke="hsl(var(--background))" />)}
          <ReferenceLine x={day.date} stroke="hsl(var(--foreground))" strokeOpacity={0.4} />
          <ReferenceDot x={day.date} y={Math.max(domain[0], Math.min(domain[1], day.balanceCents))} r={5} stroke="hsl(var(--background))" strokeWidth={2} fill={day.balanceCents < 0 ? "hsl(var(--error))" : "var(--gold)"} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    {holdScale && (minimum < domain[0] || maximum > domain[1]) && <p role="status" className="text-xs text-[hsl(var(--muted-foreground))]">Preview extends beyond the held scale. Release the control to fit the full projection.</p>}
    <div className="horizon-transport">
      {!reduced && <button className="workspace-icon" title={playing ? "Pause forecast" : "Play forecast"} aria-label={playing ? "Pause forecast" : "Play forecast"} onClick={() => { if (selectedIndex >= data.length - 1) setSelected(0); setPlaying(!playing); }}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>}
      <button className="workspace-icon" title="Reset forecast playback" aria-label="Reset forecast playback" onClick={() => choose(0)}><RotateCcw size={16} /></button>
      <input type="range" aria-label="Inspect forecast date" aria-valuetext={formatDate(day.date)} min={0} max={Math.max(0, data.length - 1)} step={1} value={selectedIndex} onChange={(event) => choose(Number(event.target.value))} />
      <time dateTime={day.date}>{formatDate(day.date)}</time>
    </div>
    <div className="horizon-inspector" aria-label="Selected forecast day">
      <div className="horizon-day-values">
        <div><p>With changes</p><strong style={{ color: day.balanceCents < bufferCents ? "hsl(var(--error))" : undefined }}>{formatCurrency(day.balanceCents)}</strong></div>
        <div><p>Current projection</p><strong>{formatCurrency(currentDay.balanceCents)}</strong></div>
        <div><p>Difference</p><strong>{formatCurrency(delta)}</strong></div>
      </div>
      <div className="horizon-events">
        {day.events.map((event) => <div key={event.key} className="horizon-event">
          {event.amountCents < 0 ? <ArrowDownRight size={15} /> : <ArrowUpRight size={15} />}
          <span>{event.description}<small>{event.source === "rule" ? "Confirmed schedule" : "Detected estimate"}</small></span>
          <strong>{formatCurrency(event.amountCents)}</strong>
        </div>)}
        {typicalDailyCents > 0 && <div className="horizon-event"><ArrowDownRight size={15} /><span>Typical spending<small>History-based assumption</small></span><strong>{formatCurrency(-typicalDailyCents)}</strong></div>}
        {(day.purchaseCents ?? 0) > 0 && <div className="horizon-event"><ArrowDownRight size={15} /><span>Purchase preview<small>Hypothetical, not recorded</small></span><strong>{formatCurrency(-day.purchaseCents!)}</strong></div>}
        {(day.scenarioSpendCents ?? 0) > (day.purchaseCents ?? 0) && <div className="horizon-event"><ArrowDownRight size={15} /><span>Extra spending<small>Hypothetical daily allocation</small></span><strong>{formatCurrency(-((day.scenarioSpendCents ?? 0) - (day.purchaseCents ?? 0)))}</strong></div>}
        {day.events.length === 0 && !typicalDailyCents && !day.scenarioSpendCents && <p className="text-xs text-[hsl(var(--muted-foreground))] py-2">No projected activity on this date.</p>}
      </div>
    </div>
    <p className="text-xs mt-4 text-[hsl(var(--muted-foreground))]">{breach ? `First cash-cushion breach: ${formatDate(breach.date)}` : "Above the cash cushion throughout this projection"}</p>
  </section>;
}