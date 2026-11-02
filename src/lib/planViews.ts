import type { ForecastEvent, ForecastResult } from "./forecast";
import type { FlowColumn, FlowEdge, FlowNode, FlowNodeKind, MoneyFlow } from "./flows";

/**
 * The Plan page's other two ways to read a forecast (#123), built from the same projection the
 * line chart draws - so every view agrees to the cent. Pure, for unit tests.
 *
 * - The money map: one window's money as currents, from where it comes (what you have now,
 *   paychecks, what-if income) through checking to where it goes (bills by category, everyday
 *   spending, what-ifs) and what is left at the end, split into the reserved cushion and the
 *   rest. Drawn by the Chart page's MoneyFlowMap.
 * - The calendar: the window as weeks, each day with its end-of-day balance and what lands.
 */

export interface PlanFlowInput {
  /** The projection to draw - the scenario, which equals expected when nothing is changed. */
  result: ForecastResult;
  startingBalanceCents: number;
  /** The cushion actually applied to the projection. */
  bufferCents: number;
  /** Typical everyday spending included in the projection, per day (0 when off). */
  typicalDailyCents: number;
}

/** Colors for nodes that are not categories; MoneyFlowMap paints an explicit color as given. */
const WHAT_IF = "hsl(var(--primary))";
const SEA = "hsl(var(--sea))";
const ERROR = "hsl(var(--error))";

interface Acc { node: FlowNode; perDay: number[] }

export function buildPlanFlow({ result, startingBalanceCents, bufferCents, typicalDailyCents }: PlanFlowInput): MoneyFlow {
  const days = result.days.length;
  const accs = new Map<string, Acc>();
  const add = (id: string, kind: FlowNodeKind, label: string, column: FlowColumn, day: number, cents: number, color: string | null = null) => {
    if (cents <= 0) return;
    let acc = accs.get(id);
    if (!acc) {
      acc = { node: { id, kind, label, column, cents: 0, color }, perDay: new Array<number>(days).fill(0) };
      accs.set(id, acc);
    }
    acc.node.cents += cents;
    acc.perDay[Math.max(0, Math.min(days - 1, day))] += cents;
  };

  const typical = Math.max(0, Math.round(typicalDailyCents));
  if (startingBalanceCents > 0) add("now", "transfer-in", "Have now", 0, 0, startingBalanceCents, SEA);
  else if (startingBalanceCents < 0) add("overdraft", "debt", "Overdraft to cover", 2, 0, -startingBalanceCents, ERROR);

  result.days.forEach((day, i) => {
    for (const e of day.events) {
      if (e.amountCents > 0) add(`in:${e.description.toLowerCase()}`, "income", e.description, 0, i, e.amountCents);
      else {
        const name = e.categoryName ?? "Other bills";
        add(`bill:${name.toLowerCase()}`, e.categoryColor ? "category" : "bills", name, 2, i, -e.amountCents, e.categoryColor);
      }
    }
    // projectCashFlow spends max(0, typical + change) a day; split it back into its two parts.
    const spend = Math.max(0, typical + (day.scenarioSpendCents ?? 0));
    add("everyday", "other", "Everyday spending", 2, i, Math.min(spend, typical));
    add("whatif:spend", "other", "Extra spending (what-if)", 2, i, spend - Math.min(spend, typical), WHAT_IF);
    add("whatif:income", "income", "Extra income (what-if)", 0, i, day.scenarioIncomeCents ?? 0, WHAT_IF);
    const oneOff = day.oneOffCents ?? 0;
    if (oneOff < 0) add("whatif:purchase", "other", "One-off purchase (what-if)", 2, i, -oneOff, WHAT_IF);
    else add("whatif:oneoff", "income", "One-off money in (what-if)", 0, i, oneOff, WHAT_IF);
  });

  const last = Math.max(0, days - 1);
  const ending = result.endingBalanceCents;
  if (ending < 0) {
    // Sources must match uses: the projection runs short by exactly the negative ending.
    const first = result.days.findIndex((d) => d.balanceCents < 0);
    add("shortfall", "from-balance", "Shortfall", 0, first < 0 ? last : first, -ending, ERROR);
  } else {
    const reserved = Math.min(ending, Math.max(0, bufferCents));
    add("reserve", "savings", "Kept in reserve", 2, last, reserved);
    add("left", "stayed", "Left at the end", 2, last, ending - reserved, SEA);
  }

  const nodes: FlowNode[] = [{ id: "checking", kind: "account", label: "Checking", column: 1, cents: 0, color: null }];
  const edges: FlowEdge[] = [];
  let inCents = 0, outCents = 0;
  for (const { node, perDay } of accs.values()) {
    nodes.push(node);
    let running = 0;
    const daily = perDay.map((cents) => (running += cents));
    const incoming = node.column === 0;
    if (incoming) inCents += node.cents; else outCents += node.cents;
    edges.push({
      id: incoming ? `${node.id}>checking` : `checking>${node.id}`,
      source: incoming ? node.id : "checking",
      target: incoming ? "checking" : node.id,
      kind: node.kind,
      cents: node.cents,
      daily,
      txnIds: [],
      color: node.color,
    });
  }
  nodes[0].cents = Math.max(inCents, outCents);

  const sum = (pred: (n: FlowNode) => boolean) => nodes.filter(pred).reduce((s, n) => s + n.cents, 0);
  const spentCents = sum((n) => n.column === 2 && (n.kind === "category" || n.kind === "bills" || n.kind === "other"));
  return {
    month: result.days[0]?.date.slice(0, 7) ?? "",
    days,
    nodes,
    edges,
    totals: {
      incomeCents: sum((n) => n.kind === "income"),
      spentCents,
      putAwayCents: sum((n) => n.id === "reserve"),
      savingsCents: sum((n) => n.id === "reserve"),
      investmentsCents: 0,
      debtCents: 0,
      cardPaymentsCents: 0,
      stayedCents: sum((n) => n.id === "left"),
      fromBalanceCents: sum((n) => n.id === "shortfall"),
      carriedCents: 0,
    },
    txns: new Map(),
  };
}

export type CalendarTone = "short" | "below" | "ok";

export interface PlanCalendarDay {
  date: string;
  /** Day of the month, for the cell label. */
  dayOfMonth: number;
  balanceCents: number;
  /** Scheduled money in and out on this day (what-ifs excluded; they are spread daily). */
  inCents: number;
  outCents: number;
  events: ForecastEvent[];
  /** A what-if one-off lands on this day. */
  oneOffCents: number;
  /** Below zero, below the cushion, or fine. */
  tone: CalendarTone;
  /** 0-1 position of the balance between the window's lowest and highest, for shading. */
  level: number;
}

export interface PlanCalendar {
  /** Sunday-first weeks; null pads days outside the window. */
  weeks: (PlanCalendarDay | null)[][];
  lowCents: number;
  highCents: number;
}

/** Weekday of a local YYYY-MM-DD date without going through UTC. */
function weekday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function buildPlanCalendar(result: ForecastResult, bufferCents: number): PlanCalendar {
  const balances = result.days.map((d) => d.balanceCents);
  const low = balances.length ? Math.min(...balances) : 0;
  const high = balances.length ? Math.max(...balances) : 0;
  const span = high - low;
  const cells: (PlanCalendarDay | null)[] = [];
  if (result.days.length > 0) for (let i = weekday(result.days[0].date); i > 0; i--) cells.push(null);
  for (const day of result.days) {
    const inCents = day.events.reduce((s, e) => s + Math.max(0, e.amountCents), 0);
    const outCents = day.events.reduce((s, e) => s + Math.max(0, -e.amountCents), 0);
    cells.push({
      date: day.date,
      dayOfMonth: Number(day.date.slice(8, 10)),
      balanceCents: day.balanceCents,
      inCents,
      outCents,
      events: day.events,
      oneOffCents: day.oneOffCents ?? 0,
      tone: day.balanceCents < 0 ? "short" : day.balanceCents < bufferCents ? "below" : "ok",
      level: span > 0 ? (day.balanceCents - low) / span : 1,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (PlanCalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { weeks, lowCents: low, highCents: high };
}
