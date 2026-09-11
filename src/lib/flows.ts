import { merchantKey } from "./merchants";
import { chargeMatchesRule } from "./forecast";
import { classifyExpense, daysInMonth, type ScheduledLike } from "./insights/shape";
import { EXCLUDED_CATEGORY_ID, TRANSFER_CATEGORY_ID, type Transaction } from "./types";

/**
 * The Chart: one month's money as currents between sources, accounts and destinations.
 *
 * Pure module. `matchTransfers` pairs the two legs of a move between the user's own accounts
 * (a card payment leaving checking and landing on the card, a transfer into savings), which
 * statement imports make reliable: both sides carry final amounts and dates. `buildMoneyFlow`
 * turns a month of rows into a layered graph whose every edge carries the transactions behind
 * it and a per-day cumulative for the scrubber, and `layoutFlow` places it. Nothing here
 * touches the database; flowData.ts gathers the rows.
 *
 * Accounting follows reportingSql.ts: income is a positive row on a spending account outside
 * Transfers and Excluded; spending is any negative row outside those categories, on checking or
 * on a card; a card payment is a transfer, never spending, so card purchases count once.
 */

export type FlowTxn = Transaction & { account_name: string; account_type: string };

export type FlowNodeKind =
  // Sources (column 0), plus the card-side funding sources that sit in column 1.
  | "income" | "transfer-in" | "from-balance" | "carried"
  // Accounts (column 1) and cards (column 2, fed by their payment).
  | "account" | "card"
  // Destinations (column 2 from checking, column 3 from a card).
  | "bills" | "recurring" | "category" | "other" | "investments" | "savings" | "debt" | "transfer-out" | "stayed" | "paid-down";

export type FlowColumn = 0 | 1 | 2 | 3;

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  column: FlowColumn;
  /** Money through the node: the larger of what came in and what went out. */
  cents: number;
  /** Stored category colour when the node is a category; the page harmonises it. */
  color: string | null;
  accountId?: number;
  categoryId?: number | null;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: FlowNodeKind;
  cents: number;
  /** Cumulative cents through each day of the month, index 0 = the 1st. */
  daily: number[];
  txnIds: number[];
  color: string | null;
}

export interface FlowTotals {
  incomeCents: number;
  /** Purchases and bills on checking plus purchases on cards; card payments are not spending. */
  spentCents: number;
  /** Savings transfers, investment contributions, debt payments and card paydown beyond purchases. */
  putAwayCents: number;
  savingsCents: number;
  investmentsCents: number;
  debtCents: number;
  cardPaymentsCents: number;
  stayedCents: number;
  fromBalanceCents: number;
  carriedCents: number;
}

export interface MoneyFlow {
  month: string;
  days: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  totals: FlowTotals;
  txns: Map<number, FlowTxn>;
}

export interface TransferPair {
  outId: number;
  inId: number;
  cents: number;
  fromAccountId: number;
  toAccountId: number;
  date: string;
}

const TRANSFER_WORDS = /\b(transfer|xfer|payment|pymt|pmt|autopay|epay|e-payment|zelle|to savings|from savings|to checking|from checking)\b/i;
const DEBT_CATEGORY_RE = /\b(debt|loan|mortgage)\b/i;
export const DEBT_CATEGORY_ID = 22;

function dayIndex(date: string): number {
  return Number(date.slice(8, 10)) - 1;
}

function dayDiff(a: string, b: string): number {
  const ua = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const ub = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.abs(ua - ub) / 86_400_000;
}

function isExcluded(t: FlowTxn): boolean {
  return t.category_id === EXCLUDED_CATEGORY_ID;
}

/** Whether two opposite legs may be the same move. Either side filed as a Transfer, money
 *  landing on a card or loan (a payment), or both descriptions saying so. */
function pairQualifies(out: FlowTxn, inn: FlowTxn): boolean {
  if (out.category_id === TRANSFER_CATEGORY_ID || inn.category_id === TRANSFER_CATEGORY_ID) return true;
  if (inn.account_type === "credit" || inn.account_type === "loan") return true;
  return TRANSFER_WORDS.test(out.description) && TRANSFER_WORDS.test(inn.description);
}

/**
 * Pairs each outgoing leg with the closest-dated unmatched incoming leg of the same amount on a
 * different account, within `maxDayGap` days. Greedy by date, oldest out first, so one deposit
 * is never claimed twice. Rows in the Excluded category are never legs.
 */
export function matchTransfers(txns: FlowTxn[], maxDayGap = 3): TransferPair[] {
  const outs = txns.filter((t) => t.amount_cents < 0 && !isExcluded(t)).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const insByAmount = new Map<number, FlowTxn[]>();
  for (const t of txns) {
    if (t.amount_cents <= 0 || isExcluded(t)) continue;
    const list = insByAmount.get(t.amount_cents);
    if (list) list.push(t); else insByAmount.set(t.amount_cents, [t]);
  }
  const used = new Set<number>();
  const pairs: TransferPair[] = [];
  for (const out of outs) {
    const candidates = (insByAmount.get(-out.amount_cents) ?? [])
      .filter((c) => !used.has(c.id) && c.account_id !== out.account_id && dayDiff(out.date, c.date) <= maxDayGap && pairQualifies(out, c))
      .sort((a, b) => dayDiff(out.date, a.date) - dayDiff(out.date, b.date) || a.id - b.id);
    const inn = candidates[0];
    if (!inn) continue;
    used.add(inn.id);
    pairs.push({ outId: out.id, inId: inn.id, cents: -out.amount_cents, fromAccountId: out.account_id, toAccountId: inn.account_id, date: out.date });
  }
  return pairs;
}

export interface BuildOptions {
  maxIncomeSources?: number;
  maxCategories?: number;
  maxCardCategories?: number;
  maxBills?: number;
  maxRecurring?: number;
}

interface EdgeAcc {
  id: string;
  source: string;
  target: string;
  kind: FlowNodeKind;
  increments: number[];
  txnIds: number[];
  color: string | null;
  cents: number;
}

interface NodeAcc extends FlowNode {
  /** Description frequency, for naming an income source by its commonest form. */
  names?: Map<string, number>;
}

const PUT_AWAY: ReadonlySet<FlowNodeKind> = new Set(["savings", "investments", "debt", "paid-down"]);
const SPENDING: ReadonlySet<FlowNodeKind> = new Set(["bills", "recurring", "category", "other"]);

/** Builds the month's flow graph. `txns` may include a few days either side of the month so a
 *  transfer straddling the boundary still pairs; only in-month rows become flows. */
export function buildMoneyFlow(
  input: { txns: FlowTxn[]; bills: ScheduledLike[]; detected: ScheduledLike[]; month: string },
  options: BuildOptions = {},
): MoneyFlow {
  const { month } = input;
  const days = daysInMonth(month);
  const maxIncome = options.maxIncomeSources ?? 5;
  const maxCategories = options.maxCategories ?? 8;
  const maxCardCategories = options.maxCardCategories ?? 6;
  const maxBills = options.maxBills ?? 6;
  const maxRecurring = options.maxRecurring ?? 5;

  const inMonth = input.txns.filter((t) => t.date.slice(0, 7) === month && !isExcluded(t) && (t.account_type === "checking" || t.account_type === "credit"));
  const inMonthIds = new Set(inMonth.map((t) => t.id));
  const pairs = matchTransfers(input.txns);
  const pairByOut = new Map(pairs.map((p) => [p.outId, p]));
  const pairByIn = new Map(pairs.map((p) => [p.inId, p]));
  const accountName = new Map<number, string>();
  const accountType = new Map<number, string>();
  for (const t of input.txns) { accountName.set(t.account_id, t.account_name); accountType.set(t.account_id, t.account_type); }

  const nodes = new Map<string, NodeAcc>();
  const edges = new Map<string, EdgeAcc>();
  const txnIndex = new Map<number, FlowTxn>();
  // Per-account daily in and out, for the honest balancing legs.
  const accountIn = new Map<string, number[]>();
  const accountOut = new Map<string, number[]>();

  const node = (id: string, kind: FlowNodeKind, label: string, column: FlowColumn, extra: Partial<FlowNode> = {}): NodeAcc => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, label, column, cents: 0, color: null, ...extra };
      nodes.set(id, n);
    }
    return n;
  };
  const bump = (map: Map<string, number[]>, id: string, day: number, cents: number) => {
    let arr = map.get(id);
    if (!arr) { arr = new Array<number>(days).fill(0); map.set(id, arr); }
    arr[day] += cents;
  };
  const flow = (source: string, target: string, kind: FlowNodeKind, t: FlowTxn, cents: number, color: string | null = null) => {
    const id = `${source}>${target}`;
    let e = edges.get(id);
    if (!e) {
      e = { id, source, target, kind, increments: new Array<number>(days).fill(0), txnIds: [], color, cents: 0 };
      edges.set(id, e);
    }
    const day = dayIndex(t.date);
    e.increments[day] += cents;
    e.cents += cents;
    e.txnIds.push(t.id);
    if (color && !e.color) e.color = color;
    txnIndex.set(t.id, t);
  };

  const billRule = (t: FlowTxn): ScheduledLike | null => {
    const probe = { description: t.description, amount_cents: t.amount_cents };
    return input.bills.find((b) => b.amount_cents < 0 && chargeMatchesRule(probe, b)) ?? null;
  };
  const isDebtCategory = (t: FlowTxn) => t.category_id === DEBT_CATEGORY_ID || (!!t.category_name && DEBT_CATEGORY_RE.test(t.category_name));

  /** Names a spending destination for a row: a scheduled bill by its rule, a detected charge
   *  by its own name, an investment-like category as investments, a debt category as debt,
   *  else its category. Card rows get their own per-card nodes in column 3. */
  const destinationFor = (t: FlowTxn, prefix: string, column: FlowColumn): NodeAcc => {
    const rule = billRule(t);
    if (rule) return node(`${prefix}bill:${rule.description.toLowerCase()}`, "bills", rule.description, column);
    const kind = classifyExpense(t, input.bills, input.detected);
    if (kind === "recurring") {
      const probe = { description: t.description, amount_cents: t.amount_cents };
      const charge = input.detected.find((d) => chargeMatchesRule(probe, d));
      const name = charge?.description.trim() || t.description.trim() || "Recurring charge";
      return node(`${prefix}rec:${name.toLowerCase()}`, "recurring", name, column);
    }
    if (kind === "invested") return node(`${prefix}investments`, "investments", "Investments", column);
    if (isDebtCategory(t)) return node(`${prefix}debt`, "debt", "Debt payments", column);
    const name = t.category_name ?? "Uncategorized";
    return node(`${prefix}cat:${name.toLowerCase()}`, "category", name, column, { color: t.category_color ?? null, categoryId: t.category_id ?? null });
  };

  // Checking accounts first so cards funded by them already have a source.
  for (const t of inMonth) {
    if (t.account_type !== "checking") continue;
    const acctId = `acct:${t.account_id}`;
    const acct = node(acctId, "account", t.account_name, 1, { accountId: t.account_id });
    const day = dayIndex(t.date);
    if (t.amount_cents > 0) {
      const cents = t.amount_cents;
      const pair = pairByIn.get(t.id);
      // A move between two of the user's own bank accounts is drawn once, from the sender's
      // side, as a savings destination; drawing the arrival too would show the money twice.
      if (pair && accountType.get(pair.fromAccountId) === "checking" && inMonthIds.has(pair.outId)) continue;
      bump(accountIn, acctId, day, cents);
      if (pair) {
        const from = node(`from:${pair.fromAccountId}`, "transfer-in", `From ${accountName.get(pair.fromAccountId) ?? "another account"}`, 0, { accountId: pair.fromAccountId });
        flow(from.id, acct.id, "transfer-in", t, cents);
      } else if (t.category_id === TRANSFER_CATEGORY_ID) {
        flow(node("xfer-in", "transfer-in", "Transfers in", 0).id, acct.id, "transfer-in", t, cents);
      } else {
        const key = merchantKey(t.description) || t.description.trim() || "Deposit";
        const src = node(`inc:${key}`, "income", t.description.trim() || "Deposit", 0);
        src.names ??= new Map();
        src.names.set(t.description.trim(), (src.names.get(t.description.trim()) ?? 0) + 1);
        flow(src.id, acct.id, "income", t, cents);
      }
    } else if (t.amount_cents < 0) {
      const cents = -t.amount_cents;
      bump(accountOut, acctId, day, cents);
      const pair = pairByOut.get(t.id);
      if (pair) {
        const toType = accountType.get(pair.toAccountId);
        const toName = accountName.get(pair.toAccountId) ?? "another account";
        if (toType === "credit") {
          const card = node(`card:${pair.toAccountId}`, "card", toName, 2, { accountId: pair.toAccountId });
          flow(acct.id, card.id, "card", t, cents);
        } else if (toType === "loan") {
          flow(acct.id, node(`to:${pair.toAccountId}`, "debt", `To ${toName}`, 2, { accountId: pair.toAccountId }).id, "debt", t, cents);
        } else {
          flow(acct.id, node(`to:${pair.toAccountId}`, "savings", `To ${toName}`, 2, { accountId: pair.toAccountId }).id, "savings", t, cents);
        }
      } else if (t.category_id === TRANSFER_CATEGORY_ID) {
        flow(acct.id, node("xfer-out", "transfer-out", "Transfers out", 2).id, "transfer-out", t, cents);
      } else {
        const dest = destinationFor(t, "", 2);
        flow(acct.id, dest.id, dest.kind, t, cents, dest.color);
      }
    }
  }

  // Cards: payments already arrived from checking above; purchases fan out to column 3.
  for (const t of inMonth) {
    if (t.account_type !== "credit") continue;
    const cardId = `card:${t.account_id}`;
    const card = node(cardId, "card", t.account_name, 2, { accountId: t.account_id });
    const day = dayIndex(t.date);
    const prefix = `c${t.account_id}:`;
    if (t.amount_cents > 0) {
      const pair = pairByIn.get(t.id);
      // The payment's other leg was drawn from the paying account, unless it posted outside
      // this month, in which case the card was paid from somewhere the map cannot show.
      if (pair && inMonthIds.has(pair.outId)) { bump(accountIn, cardId, day, t.amount_cents); continue; }
      if (pair || t.category_id === TRANSFER_CATEGORY_ID) {
        bump(accountIn, cardId, day, t.amount_cents);
        flow(node(`elsewhere:${t.account_id}`, "carried", "Paid from elsewhere", 1, { accountId: t.account_id }).id, card.id, "carried", t, t.amount_cents);
      } else {
        // A refund nets against its category rather than counting as money in.
        const dest = destinationFor(t, prefix, 3);
        bump(accountOut, cardId, day, -t.amount_cents);
        flow(card.id, dest.id, dest.kind, t, -t.amount_cents, dest.color);
      }
    } else if (t.amount_cents < 0) {
      const cents = -t.amount_cents;
      bump(accountOut, cardId, day, cents);
      const dest = destinationFor(t, prefix, 3);
      flow(card.id, dest.id, dest.kind, t, cents, dest.color);
    }
  }

  // Balancing legs, so every account node is a true junction: what came in equals what went out.
  const prefix = (arr: number[]) => { const out = new Array<number>(days).fill(0); let run = 0; for (let i = 0; i < days; i++) { run += arr[i]; out[i] = run; } return out; };
  for (const n of [...nodes.values()]) {
    if (n.kind !== "account" && n.kind !== "card") continue;
    const cumIn = prefix(accountIn.get(n.id) ?? new Array<number>(days).fill(0));
    const cumOut = prefix(accountOut.get(n.id) ?? new Array<number>(days).fill(0));
    const totalIn = cumIn[days - 1];
    const totalOut = cumOut[days - 1];
    if (totalOut > totalIn) {
      const src = n.kind === "card"
        ? node(`carry:${n.accountId}`, "carried", `Carried on ${n.label}`, 1, { accountId: n.accountId })
        : node(`bal:${n.accountId}`, "from-balance", "From balance", 0, { accountId: n.accountId });
      edges.set(`${src.id}>${n.id}`, {
        id: `${src.id}>${n.id}`, source: src.id, target: n.id, kind: src.kind, color: null, txnIds: [],
        cents: totalOut - totalIn, increments: cumOut.map((v, i) => Math.max(0, v - cumIn[i])),
      });
    } else if (totalIn > totalOut) {
      const dest = n.kind === "card"
        ? node(`paid:${n.accountId}`, "paid-down", `Paid down ${n.label}`, 3, { accountId: n.accountId })
        : node(`stay:${n.accountId}`, "stayed", `Stayed in ${n.label}`, 2, { accountId: n.accountId });
      edges.set(`${n.id}>${dest.id}`, {
        id: `${n.id}>${dest.id}`, source: n.id, target: dest.id, kind: dest.kind, color: null, txnIds: [],
        cents: totalIn - totalOut, increments: cumIn.map((v, i) => Math.max(0, v - cumOut[i])),
      });
    }
  }

  // Refund netting can leave a destination at or below zero; those edges carry nothing.
  for (const [id, e] of edges) if (e.cents <= 0) edges.delete(id);

  // Fold the long tail so the map stays legible: extra deposits, categories and bills merge.
  const fold = (predicate: (n: NodeAcc) => boolean, keep: number, foldedId: string, foldedKind: FlowNodeKind, foldedLabel: string, column: FlowColumn) => {
    const candidates = [...nodes.values()].filter(predicate).map((n) => ({ n, cents: [...edges.values()].filter((e) => e.source === n.id || e.target === n.id).reduce((s, e) => s + e.cents, 0) }))
      .sort((a, b) => b.cents - a.cents);
    if (candidates.length <= keep) return;
    const folded = node(foldedId, foldedKind, foldedLabel, column);
    for (const { n } of candidates.slice(keep)) {
      for (const e of [...edges.values()]) {
        if (e.source !== n.id && e.target !== n.id) continue;
        edges.delete(e.id);
        const source = e.source === n.id ? folded.id : e.source;
        const target = e.target === n.id ? folded.id : e.target;
        const id = `${source}>${target}`;
        const existing = edges.get(id);
        if (existing) {
          existing.cents += e.cents;
          existing.txnIds.push(...e.txnIds);
          for (let i = 0; i < days; i++) existing.increments[i] += e.increments[i];
        } else {
          edges.set(id, { ...e, id, source, target, kind: foldedKind, color: null });
        }
      }
      nodes.delete(n.id);
    }
  };
  fold((n) => n.kind === "income", maxIncome, "inc:other", "income", "Other deposits", 0);
  fold((n) => n.kind === "category" && n.column === 2, maxCategories, "cat:other", "other", "Other spending", 2);
  fold((n) => n.kind === "bills" && n.column === 2, maxBills, "bill:other", "bills", "Other scheduled bills", 2);
  fold((n) => n.kind === "recurring" && n.column === 2, maxRecurring, "rec:other", "recurring", "Other recurring charges", 2);
  for (const card of [...nodes.values()].filter((n) => n.kind === "card")) {
    const p = `c${card.accountId}:`;
    fold((n) => n.kind === "category" && n.column === 3 && n.id.startsWith(p), maxCardCategories, `${p}cat:other`, "other", "Other purchases", 3);
    fold((n) => n.kind === "recurring" && n.column === 3 && n.id.startsWith(p), 4, `${p}rec:other`, "recurring", "Other recurring charges", 3);
  }

  // Income sources take their commonest description as the label.
  for (const n of nodes.values()) {
    if (n.kind === "income" && n.names && n.names.size > 0) {
      n.label = [...n.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    }
    delete n.names;
  }

  // Node totals from the surviving edges; drop nodes nothing reaches.
  const inSum = new Map<string, number>();
  const outSum = new Map<string, number>();
  for (const e of edges.values()) {
    outSum.set(e.source, (outSum.get(e.source) ?? 0) + e.cents);
    inSum.set(e.target, (inSum.get(e.target) ?? 0) + e.cents);
  }
  const finalNodes: FlowNode[] = [];
  for (const n of nodes.values()) {
    const cents = Math.max(inSum.get(n.id) ?? 0, outSum.get(n.id) ?? 0);
    if (cents <= 0) continue;
    finalNodes.push({ id: n.id, kind: n.kind, label: n.label, column: n.column, cents, color: n.color, accountId: n.accountId, categoryId: n.categoryId });
  }

  const finalEdges: FlowEdge[] = [...edges.values()].map((e) => ({
    id: e.id, source: e.source, target: e.target, kind: e.kind, cents: e.cents, color: e.color,
    txnIds: e.txnIds.slice().sort((a, b) => a - b),
    daily: e.txnIds.length > 0 ? prefix(e.increments) : e.increments.slice(),
  }));

  const totals: FlowTotals = {
    incomeCents: 0, spentCents: 0, putAwayCents: 0, savingsCents: 0, investmentsCents: 0, debtCents: 0,
    cardPaymentsCents: 0, stayedCents: 0, fromBalanceCents: 0, carriedCents: 0,
  };
  for (const e of finalEdges) {
    if (e.kind === "income") totals.incomeCents += e.cents;
    else if (SPENDING.has(e.kind)) totals.spentCents += e.cents;
    else if (e.kind === "card") totals.cardPaymentsCents += e.cents;
    else if (e.kind === "stayed") totals.stayedCents += e.cents;
    else if (e.kind === "from-balance") totals.fromBalanceCents += e.cents;
    else if (e.kind === "carried") totals.carriedCents += e.cents;
    if (PUT_AWAY.has(e.kind)) {
      totals.putAwayCents += e.cents;
      if (e.kind === "savings") totals.savingsCents += e.cents;
      else if (e.kind === "investments") totals.investmentsCents += e.cents;
      else totals.debtCents += e.cents;
    }
  }

  return { month, days, nodes: finalNodes, edges: finalEdges, totals, txns: txnIndex };
}

// ── Layout ───────────────────────────────────────────────────────────────────

export interface LayoutOptions {
  width: number;
  height: number;
  nodeWidth?: number;
  /** Vertical gap between nodes in a column. */
  gap?: number;
  /** Horizontal room kept for labels left of column 0 and right of the last column. */
  gutterLeft?: number;
  gutterRight?: number;
  /** Smallest drawn thickness so a $6 ribbon is still visible. */
  minThickness?: number;
}

export interface LaidOutNode extends FlowNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutEdge extends FlowEdge {
  /** Centreline path from the source's right edge to the target's left edge. */
  path: string;
  thickness: number;
  x0: number; y0: number; x1: number; y1: number;
}

export interface FlowLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  columns: number[];
  /** Pixels per cent, shared by every column. */
  scale: number;
}

const KIND_ORDER: Record<FlowNodeKind, number> = {
  income: 0, "transfer-in": 1, "from-balance": 2,
  account: 0, carried: 1,
  bills: 0, recurring: 1, category: 2, other: 3, investments: 4, savings: 5, debt: 6, "transfer-out": 7, card: 8, stayed: 9, "paid-down": 9,
};

/** A cubic between two points with horizontal tangents, the standard ribbon curve. */
export function ribbonPath(x0: number, y0: number, x1: number, y1: number): string {
  const mx = (x0 + x1) / 2;
  return `M${x0.toFixed(1)},${y0.toFixed(1)} C${mx.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

/**
 * Places the graph in four columns. Nodes stack by kind then size, each column is centred
 * vertically, and one scale serves every column so a dollar is the same height everywhere.
 * Positions depend only on month totals, so scrubbing the day never moves anything.
 */
export function layoutFlow(flow: MoneyFlow, options: LayoutOptions): FlowLayout {
  const nodeWidth = options.nodeWidth ?? 10;
  const gap = options.gap ?? 10;
  const gutterLeft = options.gutterLeft ?? 150;
  const gutterRight = options.gutterRight ?? 170;
  const minThickness = options.minThickness ?? 1.5;
  const { width, height } = options;

  const present = [0, 1, 2, 3].filter((c) => flow.nodes.some((n) => n.column === c)) as FlowColumn[];
  const span = Math.max(1, present.length - 1);
  const inner = Math.max(40, width - gutterLeft - gutterRight - nodeWidth);
  const columnX = new Map<number, number>();
  present.forEach((c, i) => columnX.set(c, gutterLeft + (inner * i) / span));
  const columns = present.map((c) => columnX.get(c)!);

  const cardOrder = new Map<string, number>();

  // Column order: kind, then size, with card categories following their card.
  const sorted = (column: FlowColumn) => flow.nodes.filter((n) => n.column === column).sort((a, b) => {
    if (column === 3) {
      const ca = cardOrder.get(cardOf(a)) ?? 0;
      const cb = cardOrder.get(cardOf(b)) ?? 0;
      if (ca !== cb) return ca - cb;
    }
    const ka = KIND_ORDER[a.kind], kb = KIND_ORDER[b.kind];
    if (ka !== kb) return ka - kb;
    return b.cents - a.cents || a.label.localeCompare(b.label);
  });
  const cardOf = (n: FlowNode): string => {
    const e = flow.edges.find((edge) => edge.target === n.id);
    return e?.source ?? "";
  };

  let scale = Infinity;
  const stacks = new Map<FlowColumn, FlowNode[]>();
  for (const c of present) {
    const list = sorted(c);
    if (c === 2) list.filter((n) => n.kind === "card").forEach((n, i) => cardOrder.set(n.id, i));
    stacks.set(c, list);
  }
  // Column 3 depends on card order, so sort it after cards are placed.
  if (present.includes(3)) stacks.set(3, sorted(3));
  for (const [, list] of stacks) {
    const total = list.reduce((s, n) => s + n.cents, 0);
    const usable = height - gap * Math.max(0, list.length - 1);
    if (total > 0) scale = Math.min(scale, usable / total);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 0;

  const laidNodes: LaidOutNode[] = [];
  const positioned = new Map<string, LaidOutNode>();
  for (const [c, list] of stacks) {
    const total = list.reduce((s, n) => s + n.cents * scale, 0) + gap * Math.max(0, list.length - 1);
    let y = Math.max(0, (height - total) / 2);
    for (const n of list) {
      const h = Math.max(minThickness, n.cents * scale);
      const placed: LaidOutNode = { ...n, x: columnX.get(c)!, y, width: nodeWidth, height: h };
      laidNodes.push(placed);
      positioned.set(n.id, placed);
      y += h + gap;
    }
  }

  // Ribbons leave a node top to bottom in the order of their targets' heights, and arrive in the
  // order of their sources', so neighbouring ribbons never cross at a node face.
  const outOffset = new Map<string, number>();
  const inOffset = new Map<string, number>();
  const edgesByTargetY = flow.edges.slice().sort((a, b) => {
    const ta = positioned.get(a.target)?.y ?? 0, tb = positioned.get(b.target)?.y ?? 0;
    return ta - tb || a.id.localeCompare(b.id);
  });
  const laidEdges: LaidOutEdge[] = [];
  for (const e of edgesByTargetY) {
    const s = positioned.get(e.source), t = positioned.get(e.target);
    if (!s || !t) continue;
    const thickness = Math.max(minThickness, e.cents * scale);
    const so = outOffset.get(e.source) ?? 0;
    outOffset.set(e.source, so + thickness);
    laidEdges.push({ ...e, path: "", thickness, x0: s.x + s.width, y0: s.y + so + thickness / 2, x1: t.x, y1: 0 });
  }
  const bySourceY = laidEdges.slice().sort((a, b) => a.y0 - b.y0 || a.id.localeCompare(b.id));
  for (const e of bySourceY) {
    const t = positioned.get(e.target)!;
    const io = inOffset.get(e.target) ?? 0;
    inOffset.set(e.target, io + e.thickness);
    e.y1 = t.y + io + e.thickness / 2;
    e.path = ribbonPath(e.x0, e.y0, e.x1, e.y1);
  }

  return { nodes: laidNodes, edges: laidEdges, width, height, columns, scale };
}

/** Cents through an edge by the end of `day` (0-based), for the scrubber. */
export function edgeCentsThrough(edge: FlowEdge, day: number): number {
  if (edge.daily.length === 0) return edge.cents;
  const i = Math.max(0, Math.min(edge.daily.length - 1, day));
  return edge.daily[i];
}

/** Transactions of an edge that posted on `day` (0-based), for the day inspector and bursts. */
export function edgeTxnsOnDay(flow: MoneyFlow, edge: FlowEdge, day: number): FlowTxn[] {
  const out: FlowTxn[] = [];
  for (const id of edge.txnIds) {
    const t = flow.txns.get(id);
    if (t && dayIndex(t.date) === day) out.push(t);
  }
  return out;
}
