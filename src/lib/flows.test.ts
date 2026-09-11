import { describe, it, expect } from "vitest";
import { buildMoneyFlow, edgeCentsThrough, edgeTxnsOnDay, layoutFlow, matchTransfers, type FlowTxn } from "./flows";

let nextId = 1;
function txn(partial: Partial<FlowTxn> & { date: string; amount_cents: number; account_id: number }): FlowTxn {
  const id = partial.id ?? nextId++;
  const isCard = partial.account_type === "credit";
  return {
    id,
    account_id: partial.account_id,
    date: partial.date,
    amount_cents: partial.amount_cents,
    description: partial.description ?? "Row",
    category_id: partial.category_id ?? null,
    notes: null,
    import_hash: `h${id}`,
    balance_cents: null,
    created_at: partial.date,
    category_name: partial.category_name,
    category_color: partial.category_color,
    account_name: partial.account_name ?? (isCard ? "Visa" : "Everyday checking"),
    account_type: partial.account_type ?? "checking",
  };
}

const CHECKING = 1, VISA = 2, SAVINGS = 3;
const card = { account_id: VISA, account_type: "credit", account_name: "Visa" } as const;
const savings = { account_id: SAVINGS, account_type: "checking", account_name: "Savings" } as const;

describe("matchTransfers", () => {
  it("pairs a card payment leaving checking with the credit landing on the card", () => {
    const out = txn({ date: "2026-09-10", amount_cents: -40_000, account_id: CHECKING, description: "VISA PAYMENT", category_id: 20 });
    const inn = txn({ date: "2026-09-12", amount_cents: 40_000, ...card, description: "PAYMENT THANK YOU", category_id: 20 });
    const pairs = matchTransfers([out, inn]);
    expect(pairs).toEqual([{ outId: out.id, inId: inn.id, cents: 40_000, fromAccountId: CHECKING, toAccountId: VISA, date: "2026-09-10" }]);
  });

  it("never pairs two legs on the same account, different amounts, or beyond the day gap", () => {
    const out = txn({ date: "2026-09-10", amount_cents: -5_000, account_id: CHECKING, category_id: 20 });
    const sameAccount = txn({ date: "2026-09-10", amount_cents: 5_000, account_id: CHECKING, category_id: 20 });
    const wrongAmount = txn({ date: "2026-09-10", amount_cents: 5_001, ...savings, category_id: 20 });
    const tooLate = txn({ date: "2026-09-20", amount_cents: 5_000, ...savings, category_id: 20 });
    expect(matchTransfers([out, sameAccount, wrongAmount, tooLate])).toEqual([]);
  });

  it("does not pair two unrelated purchases that happen to be equal and opposite", () => {
    const out = txn({ date: "2026-09-10", amount_cents: -1_250, account_id: CHECKING, description: "COFFEE", category_id: 3 });
    const inn = txn({ date: "2026-09-10", amount_cents: 1_250, ...savings, description: "REFUND", category_id: 7 });
    expect(matchTransfers([out, inn])).toEqual([]);
  });

  it("prefers the closest-dated deposit and claims each deposit once", () => {
    const outA = txn({ date: "2026-09-01", amount_cents: -20_000, account_id: CHECKING, category_id: 20 });
    const outB = txn({ date: "2026-09-03", amount_cents: -20_000, account_id: CHECKING, category_id: 20 });
    const inNear = txn({ date: "2026-09-03", amount_cents: 20_000, ...savings, category_id: 20 });
    const inFar = txn({ date: "2026-09-02", amount_cents: 20_000, ...savings, category_id: 20 });
    const pairs = matchTransfers([outA, outB, inNear, inFar]);
    expect(pairs.map((p) => [p.outId, p.inId])).toEqual([[outA.id, inFar.id], [outB.id, inNear.id]]);
  });
});

describe("buildMoneyFlow", () => {
  const month = "2026-09";
  const bills = [{ description: "Rent", amount_cents: -150_000 }];
  const detected = [{ description: "Netflix", amount_cents: -1_599 }];

  function septemberRows(): FlowTxn[] {
    return [
      txn({ date: "2026-09-04", amount_cents: 300_000, account_id: CHECKING, description: "ACME PAYROLL", category_id: 1, category_name: "Income" }),
      txn({ date: "2026-09-18", amount_cents: 300_000, account_id: CHECKING, description: "ACME PAYROLL", category_id: 1, category_name: "Income" }),
      txn({ date: "2026-09-05", amount_cents: -150_000, account_id: CHECKING, description: "SUNSET APTS RENT", category_id: 12, category_name: "Rent / Mortgage" }),
      txn({ date: "2026-09-06", amount_cents: -1_599, account_id: CHECKING, description: "NETFLIX", category_id: 17, category_name: "Subscriptions" }),
      txn({ date: "2026-09-07", amount_cents: -8_450, account_id: CHECKING, description: "GREEN MARKET", category_id: 13, category_name: "Groceries", category_color: "#fb923c" }),
      txn({ date: "2026-09-21", amount_cents: -6_000, account_id: CHECKING, description: "GREEN MARKET", category_id: 13, category_name: "Groceries", category_color: "#fb923c" }),
      // Card payment, both legs.
      txn({ date: "2026-09-10", amount_cents: -40_000, account_id: CHECKING, description: "VISA PAYMENT", category_id: 20 }),
      txn({ date: "2026-09-11", amount_cents: 40_000, ...card, description: "PAYMENT THANK YOU", category_id: 20 }),
      // Card purchases exceed the payment by $100.
      txn({ date: "2026-09-02", amount_cents: -30_000, ...card, description: "BISTRO", category_id: 3, category_name: "Food & Dining", category_color: "#f97316" }),
      txn({ date: "2026-09-15", amount_cents: -20_000, ...card, description: "BOOKSHOP", category_id: 7, category_name: "Shopping", category_color: "#06b6d4" }),
      // Savings transfer, both legs.
      txn({ date: "2026-09-19", amount_cents: -20_000, account_id: CHECKING, description: "ONLINE TRANSFER TO SAVINGS", category_id: 20 }),
      txn({ date: "2026-09-19", amount_cents: 20_000, ...savings, description: "ONLINE TRANSFER FROM CHECKING", category_id: 20 }),
      // Investment contribution and a debt payment.
      txn({ date: "2026-09-20", amount_cents: -25_000, account_id: CHECKING, description: "VANGUARD BUY", category_id: 26, category_name: "Investments" }),
      txn({ date: "2026-09-22", amount_cents: -12_000, account_id: CHECKING, description: "SOFI LOAN PMT", category_id: 22, category_name: "Debt" }),
      // Excluded rows never appear.
      txn({ date: "2026-09-23", amount_cents: -99_999, account_id: CHECKING, description: "REIMBURSED", category_id: 29 }),
      // Outside the month: only a pairing candidate.
      txn({ date: "2026-10-01", amount_cents: -777, account_id: CHECKING, description: "OCTOBER", category_id: 13, category_name: "Groceries" }),
    ];
  }

  it("routes income through checking to bills, categories, the card, savings, investments and debt", () => {
    const flow = buildMoneyFlow({ txns: septemberRows(), bills, detected, month });
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    expect(byId.get("inc:ACME PAYROLL")).toMatchObject({ kind: "income", column: 0, cents: 600_000, label: "ACME PAYROLL" });
    expect(byId.get(`acct:${CHECKING}`)).toMatchObject({ kind: "account", column: 1 });
    expect(byId.get("bill:rent")).toMatchObject({ kind: "bills", label: "Rent", cents: 150_000, column: 2 });
    expect(byId.get("rec:netflix")).toMatchObject({ kind: "recurring", label: "Netflix", cents: 1_599 });
    expect(byId.get("cat:groceries")).toMatchObject({ kind: "category", cents: 14_450, color: "#fb923c", categoryId: 13 });
    expect(byId.get(`card:${VISA}`)).toMatchObject({ kind: "card", column: 2, cents: 50_000 });
    expect(byId.get(`to:${SAVINGS}`)).toMatchObject({ kind: "savings", label: "To Savings", cents: 20_000 });
    // The arrival in Savings is the same money; it is not drawn a second time.
    expect(byId.has(`acct:${SAVINGS}`)).toBe(false);
    expect(byId.has(`from:${CHECKING}`)).toBe(false);
    expect(byId.get("investments")).toMatchObject({ kind: "investments", cents: 25_000 });
    expect(byId.get("debt")).toMatchObject({ kind: "debt", cents: 12_000 });
    expect(byId.get(`c${VISA}:cat:food & dining`)).toMatchObject({ column: 3, cents: 30_000 });
    expect(byId.get(`c${VISA}:cat:shopping`)).toMatchObject({ column: 3, cents: 20_000 });
    expect(flow.nodes.some((n) => n.label === "OCTOBER" || n.id.includes("reimbursed"))).toBe(false);
  });

  it("balances every junction with honest legs: money that stayed, and card spending carried", () => {
    const flow = buildMoneyFlow({ txns: septemberRows(), bills, detected, month });
    const stayed = flow.edges.find((e) => e.kind === "stayed")!;
    // 600,000 in; out = 150,000 + 1,599 + 14,450 + 40,000 + 20,000 + 25,000 + 12,000 = 263,049.
    expect(stayed.cents).toBe(336_951);
    expect(stayed.target).toBe(`stay:${CHECKING}`);
    const carried = flow.edges.find((e) => e.kind === "carried")!;
    expect(carried.cents).toBe(10_000);
    expect(carried.source).toBe(`carry:${VISA}`);
    expect(flow.nodes.find((n) => n.id === `carry:${VISA}`)).toMatchObject({ column: 1, label: "Carried on Visa" });
    expect(flow.edges.some((e) => e.kind === "from-balance" || e.kind === "paid-down")).toBe(false);
  });

  it("sums the month the way the rest of the app does: cards counted once, payments never spending", () => {
    const { totals } = buildMoneyFlow({ txns: septemberRows(), bills, detected, month });
    expect(totals.incomeCents).toBe(600_000);
    expect(totals.spentCents).toBe(150_000 + 1_599 + 14_450 + 30_000 + 20_000);
    expect(totals.cardPaymentsCents).toBe(40_000);
    expect(totals.putAwayCents).toBe(20_000 + 25_000 + 12_000);
    expect(totals.savingsCents).toBe(20_000);
    expect(totals.investmentsCents).toBe(25_000);
    expect(totals.debtCents).toBe(12_000);
    expect(totals.stayedCents).toBe(336_951);
    expect(totals.carriedCents).toBe(10_000);
    expect(totals.fromBalanceCents).toBe(0);
  });

  it("gives every edge a cumulative daily series the scrubber can read", () => {
    const flow = buildMoneyFlow({ txns: septemberRows(), bills, detected, month });
    const groceries = flow.edges.find((e) => e.target === "cat:groceries")!;
    expect(groceries.daily).toHaveLength(30);
    expect(edgeCentsThrough(groceries, 5)).toBe(0);
    expect(edgeCentsThrough(groceries, 6)).toBe(8_450);
    expect(edgeCentsThrough(groceries, 20)).toBe(14_450);
    expect(edgeCentsThrough(groceries, 29)).toBe(14_450);
    for (let i = 1; i < groceries.daily.length; i++) expect(groceries.daily[i]).toBeGreaterThanOrEqual(groceries.daily[i - 1]);
    expect(edgeTxnsOnDay(flow, groceries, 6).map((t) => t.description)).toEqual(["GREEN MARKET"]);
    // The stayed leg is the running gap between what came in and what left, so it can shrink.
    const stayed = flow.edges.find((e) => e.kind === "stayed")!;
    expect(edgeCentsThrough(stayed, 3)).toBe(300_000 - 30_000 * 0); // payday, nothing out of checking yet
    expect(edgeCentsThrough(stayed, 4)).toBe(300_000 - 150_000);
    expect(edgeCentsThrough(stayed, 29)).toBe(336_951);
  });

  it("shows a transfer that arrived from outside the month as coming from that account", () => {
    const rows = [
      txn({ date: "2026-08-31", amount_cents: -20_000, account_id: CHECKING, description: "TRANSFER TO SAVINGS", category_id: 20 }),
      txn({ date: "2026-09-01", amount_cents: 20_000, ...savings, description: "TRANSFER FROM CHECKING", category_id: 20 }),
      txn({ date: "2026-09-02", amount_cents: -5_000, ...savings, description: "SAVINGS FEE", category_id: 19, category_name: "Bank Fees" }),
    ];
    const flow = buildMoneyFlow({ txns: rows, bills: [], detected: [], month });
    expect(flow.nodes.find((n) => n.id === `from:${CHECKING}`)).toMatchObject({ column: 0, label: "From Everyday checking" });
    expect(flow.nodes.find((n) => n.id === `acct:${SAVINGS}`)).toMatchObject({ column: 1, cents: 20_000 });
    expect(flow.edges.find((e) => e.kind === "stayed")?.cents).toBe(15_000);
    expect(flow.nodes.some((n) => n.id === `to:${SAVINGS}`)).toBe(false);
  });

  it("draws a month with no income from the balance, so an expenses-only fixture still maps", () => {
    const rows = [
      txn({ date: "2026-09-03", amount_cents: -8_450, account_id: CHECKING, description: "Green Market Groceries", category_id: 13, category_name: "Groceries" }),
      txn({ date: "2026-09-03", amount_cents: -650, account_id: CHECKING, description: "Neighborhood Coffee", category_id: 3, category_name: "Food & Dining" }),
    ];
    const flow = buildMoneyFlow({ txns: rows, bills: [], detected: [], month });
    const from = flow.edges.find((e) => e.kind === "from-balance")!;
    expect(from.cents).toBe(9_100);
    expect(flow.nodes.find((n) => n.id === `bal:${CHECKING}`)).toMatchObject({ column: 0, label: "From balance" });
    expect(flow.totals.incomeCents).toBe(0);
    expect(flow.totals.spentCents).toBe(9_100);
    expect(flow.edges.some((e) => e.kind === "stayed")).toBe(false);
  });

  it("folds the long tail of deposits and categories into one honest line each", () => {
    const rows: FlowTxn[] = [];
    for (let i = 0; i < 8; i++) rows.push(txn({ date: "2026-09-02", amount_cents: 1_000 + i, account_id: CHECKING, description: `Payer ${i}`, category_id: 1 }));
    for (let i = 0; i < 12; i++) rows.push(txn({ date: "2026-09-09", amount_cents: -(500 + i), account_id: CHECKING, description: `Shop ${i}`, category_id: 100 + i, category_name: `Category ${i}` }));
    const flow = buildMoneyFlow({ txns: rows, bills: [], detected: [], month }, { maxIncomeSources: 3, maxCategories: 4 });
    expect(flow.nodes.filter((n) => n.kind === "income")).toHaveLength(4);
    expect(flow.nodes.find((n) => n.id === "inc:other")).toMatchObject({ label: "Other deposits" });
    expect(flow.nodes.filter((n) => n.column === 2 && (n.kind === "category" || n.kind === "other"))).toHaveLength(5);
    const other = flow.edges.find((e) => e.target === "cat:other")!;
    expect(other.txnIds).toHaveLength(8);
    expect(other.cents).toBe(rows.filter((t) => t.amount_cents < 0).sort((a, b) => a.amount_cents - b.amount_cents).slice(4).reduce((s, t) => s - t.amount_cents, 0));
  });

  it("nets a card refund against its category instead of counting it as money in", () => {
    const rows = [
      txn({ date: "2026-09-02", amount_cents: -10_000, ...card, description: "BOOKSHOP", category_id: 7, category_name: "Shopping" }),
      txn({ date: "2026-09-05", amount_cents: 3_000, ...card, description: "BOOKSHOP REFUND", category_id: 7, category_name: "Shopping" }),
    ];
    const flow = buildMoneyFlow({ txns: rows, bills: [], detected: [], month });
    expect(flow.nodes.find((n) => n.id === `c${VISA}:cat:shopping`)?.cents).toBe(7_000);
    expect(flow.totals.spentCents).toBe(7_000);
    expect(flow.totals.carriedCents).toBe(7_000);
  });
});

describe("layoutFlow", () => {
  it("stacks each column without overlap, keeps one scale, and packs ribbons to their nodes", () => {
    const rows = [
      txn({ date: "2026-09-04", amount_cents: 300_000, account_id: CHECKING, description: "PAYROLL", category_id: 1 }),
      txn({ date: "2026-09-05", amount_cents: -150_000, account_id: CHECKING, description: "RENT", category_id: 12, category_name: "Rent / Mortgage" }),
      txn({ date: "2026-09-07", amount_cents: -8_450, account_id: CHECKING, description: "GREEN MARKET", category_id: 13, category_name: "Groceries" }),
      txn({ date: "2026-09-10", amount_cents: -40_000, account_id: CHECKING, description: "VISA PAYMENT", category_id: 20 }),
      txn({ date: "2026-09-11", amount_cents: 40_000, ...card, description: "PAYMENT", category_id: 20 }),
      txn({ date: "2026-09-12", amount_cents: -25_000, ...card, description: "BISTRO", category_id: 3, category_name: "Food & Dining" }),
    ];
    const flow = buildMoneyFlow({ txns: rows, bills: [], detected: [], month: "2026-09" });
    const layout = layoutFlow(flow, { width: 1000, height: 500, gap: 12 });
    expect(layout.columns).toHaveLength(4);
    for (const column of [0, 1, 2, 3]) {
      const stack = layout.nodes.filter((n) => n.column === column).sort((a, b) => a.y - b.y);
      for (let i = 1; i < stack.length; i++) expect(stack[i].y).toBeGreaterThanOrEqual(stack[i - 1].y + stack[i - 1].height + 12 - 0.01);
      for (const n of stack) {
        expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.y + n.height).toBeLessThanOrEqual(500.01);
      }
    }
    const checking = layout.nodes.find((n) => n.id === `acct:${CHECKING}`)!;
    const outgoing = layout.edges.filter((e) => e.source === checking.id);
    expect(outgoing.reduce((s, e) => s + e.thickness, 0)).toBeCloseTo(checking.height, 5);
    for (const e of layout.edges) {
      expect(e.path.startsWith("M")).toBe(true);
      expect(e.x1).toBeGreaterThan(e.x0);
    }
    const dollars = (n: { cents: number; height: number }) => n.height / n.cents;
    const [a, b] = layout.nodes.filter((n) => n.cents * layout.scale > 2);
    expect(dollars(a)).toBeCloseTo(dollars(b), 6);
  });

  it("survives an empty month", () => {
    const flow = buildMoneyFlow({ txns: [], bills: [], detected: [], month: "2026-09" });
    const layout = layoutFlow(flow, { width: 800, height: 400 });
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
  });
});
