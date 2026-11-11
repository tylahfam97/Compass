import { describe, it, expect, vi, afterEach } from "vitest";

// Real in-memory SQLite (node:sqlite) behind the invoke() commands the Rust layer serves, so the
// real migrations, the real review predicate and the real confirm/split/undo SQL all run (#107).
// Same bridge as mergeDuplicateAccounts.test.ts. Each case gets its own profile and accounts.
const sqlite = vi.hoisted(() => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  return new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
});

vi.mock("@tauri-apps/api/core", () => {
  // Match Rust json_to_sql: integer JSON numbers/booleans bind as SQLite INTEGER.
  const bind = (params: unknown[] = []) =>
    params.map((v) => typeof v === "boolean" ? BigInt(v) :
      typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : v ?? null) as (string | number | bigint | null)[];
  return {
    invoke: async (cmd: string, args: { sql: string; params?: unknown[]; statements?: { sql: string; params?: unknown[] }[] }) => {
      if (cmd === "db_select") return sqlite.prepare(args.sql).all(...bind(args.params));
      if (cmd === "db_execute") {
        const r = sqlite.prepare(args.sql).run(...bind(args.params));
        return { lastInsertId: Number(r.lastInsertRowid), rowsAffected: Number(r.changes) };
      }
      if (cmd === "db_execute_batch") {
        sqlite.exec("BEGIN");
        try {
          for (const s of args.statements ?? []) sqlite.prepare(s.sql).run(...bind(s.params));
          sqlite.exec("COMMIT");
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
        return;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    },
  };
});

import {
  getDb, CRYPTO_REVIEW_SQL, countCryptoReview, getCryptoMatchState, reconcileCryptoTransfers,
  confirmCryptoTransfer, undoCryptoTransfer, allowCryptoMatching, splitCryptoTransfer, undoCryptoSplit,
  keepCryptoAsSpending,
} from "./db";
import type { CryptoDepositCandidate } from "./db";
import { TRANSFER_CATEGORY_ID } from "./types";
import { CRYPTO_CATEGORY_ID } from "./cryptoTransfers";

type Param = string | number | null;
const insert = (sql: string, ...params: Param[]) => Number(sqlite.prepare(sql).run(...params).lastInsertRowid);
const rows = <T = Record<string, unknown>>(sql: string, ...params: Param[]) => sqlite.prepare(sql).all(...params) as T[];
const SHOPPING = 7;

let nextProfile = 10;
let hash = 0;
/** A fresh profile: a checking account and a crypto portfolio that holds BTC. */
async function setup() {
  await getDb(); // real migrations
  const profile = nextProfile++;
  insert("INSERT INTO profiles (id, name) VALUES (?, 'Case')", profile);
  const checking = insert("INSERT INTO accounts (name, account_type, profile_id) VALUES ('Checking', 'checking', ?)", profile);
  const wallet = insert("INSERT INTO accounts (name, account_type, profile_id) VALUES ('Ledger', 'investment', ?)", profile);
  insert("INSERT INTO holdings (account_id, profile_id, as_of_date, security_type, symbol) VALUES (?, ?, '2026-03-31', 'crypto', 'BTC')", wallet, profile);
  const purchase = (date: string, cents: number, category = CRYPTO_CATEGORY_ID, account = checking) =>
    insert("INSERT INTO transactions (account_id, profile_id, date, amount_cents, description, category_id, import_hash) VALUES (?, ?, ?, ?, 'Exchange purchase', ?, ?)",
      account, profile, date, cents, category, `h${hash++}`);
  const deposit = (date: string, cents: number, symbol: string | null = "BTC", account = wallet) =>
    insert("INSERT INTO investment_activity (account_id, profile_id, trade_date, activity_type, symbol, import_hash, amount_cents) VALUES (?, ?, ?, 'deposit', ?, ?, ?)",
      account, profile, date, symbol, `h${hash++}`, cents);
  const queue = async () => (await (await getDb()).select<{ id: number; amount_cents: number }[]>(
    `SELECT t.id, t.amount_cents FROM transactions t WHERE t.profile_id = ? AND ${CRYPTO_REVIEW_SQL} ORDER BY t.amount_cents, t.id`, [profile]));
  const queuedAmounts = async () => (await queue()).map((r) => r.amount_cents);
  const txns = () => rows<{ id: number; date: string; amount_cents: number; category_id: number; import_hash: string }>(
    "SELECT id, date, amount_cents, category_id, import_hash FROM transactions WHERE profile_id = ? ORDER BY id", profile);
  const deposits = () => rows("SELECT id, trade_date, amount_cents FROM investment_activity WHERE profile_id = ? ORDER BY id", profile);
  const txn = (id: number) => txns().find((t) => t.id === id)!;
  return { profile, checking, wallet, purchase, deposit, queue, queuedAmounts, txns, deposits, txn };
}

/** What the editor would show for a row, plus the guard values it passes to confirm/split. */
async function open(id: number) {
  const state = (await getCryptoMatchState(id))!;
  const [t] = rows<{ category_id: number; amount_cents: number }>("SELECT category_id, amount_cents FROM transactions WHERE id = ?", id);
  return { state, seen: { transactionId: id, categoryId: t.category_id, amountCents: t.amount_cents, ...state.seen } };
}
const pick = (state: { candidates: CryptoDepositCandidate[] }, id: number) => state.candidates.find((c) => c.id === id)!;

// The queue and the editor must never disagree: every queued row has a deposit to confirm when
// opened, and every unqueued Crypto row has none, or was kept as spending.
afterEach(async () => {
  const db = await getDb();
  const queued = new Set((await db.select<{ id: number }[]>(`SELECT t.id FROM transactions t WHERE ${CRYPTO_REVIEW_SQL}`)).map((r) => r.id));
  for (const { id } of rows<{ id: number }>("SELECT id FROM transactions WHERE category_id = ?", CRYPTO_CATEGORY_ID)) {
    const state = await getCryptoMatchState(id);
    if (queued.has(id)) expect(state?.candidates.length, `queued row ${id}`).toBeGreaterThan(0);
    else expect(!state || state.candidates.length === 0 || state.rejected, `unqueued row ${id}`).toBe(true);
  }
});

describe("crypto review queue (#107)", () => {
  it("lists the issue's near misses, moves only the exact match, and changes no amounts or rows", async () => {
    const c = await setup();
    const near = c.purchase("2026-03-02", -21223);
    const exact = c.purchase("2026-03-03", -32573);
    const partly = c.purchase("2026-03-05", -15000);
    c.deposit("2026-03-03", 21233);
    const exactDeposit = c.deposit("2026-03-04", 32573);
    const before = c.txns().map(({ id, date, amount_cents }) => ({ id, date, amount_cents }));
    const depositsBefore = c.deposits();

    expect(await reconcileCryptoTransfers()).toBe(1);

    expect(c.txns().map(({ id, category_id }) => ({ id, category_id }))).toEqual([
      { id: near, category_id: CRYPTO_CATEGORY_ID },
      { id: exact, category_id: TRANSFER_CATEGORY_ID },
      { id: partly, category_id: CRYPTO_CATEGORY_ID },
    ]);
    expect(rows("SELECT transaction_id, activity_id, confirmed FROM crypto_transfer_links WHERE transaction_id IN (?, ?, ?)", near, exact, partly))
      .toEqual([{ transaction_id: exact, activity_id: exactDeposit, confirmed: 0 }]);
    expect(await c.queuedAmounts()).toEqual([-21223, -15000]);
    expect(await countCryptoReview(c.profile)).toBe(2);
    expect(c.txns().map(({ id, date, amount_cents }) => ({ id, date, amount_cents }))).toEqual(before);
    expect(c.deposits()).toEqual(depositsBefore);

    // Repeating the reconcile is a no-op: same links, same queue, same rows.
    const links = rows("SELECT transaction_id, activity_id, confirmed FROM crypto_transfer_links ORDER BY transaction_id");
    for (let i = 0; i < 2; i++) expect(await reconcileCryptoTransfers()).toBe(0);
    expect(rows("SELECT transaction_id, activity_id, confirmed FROM crypto_transfer_links ORDER BY transaction_id")).toEqual(links);
    expect(await c.queuedAmounts()).toEqual([-21223, -15000]);
    expect(c.txns().map(({ id, date, amount_cents }) => ({ id, date, amount_cents }))).toEqual(before);
  });

  it("gives the same result in either import order, and appears once a portfolio arrives", async () => {
    const outcome = async (c: Awaited<ReturnType<typeof setup>>) => ({
      transfers: c.txns().filter((t) => t.category_id === TRANSFER_CATEGORY_ID).map((t) => t.amount_cents),
      queue: await c.queuedAmounts(),
      count: await countCryptoReview(c.profile),
    });
    const depositsFirst = await setup();
    depositsFirst.deposit("2026-03-03", 21233);
    depositsFirst.deposit("2026-03-04", 32573);
    await reconcileCryptoTransfers();
    depositsFirst.purchase("2026-03-02", -21223);
    depositsFirst.purchase("2026-03-03", -32573);
    depositsFirst.purchase("2026-03-05", -15000);
    await reconcileCryptoTransfers();

    const purchasesFirst = await setup();
    purchasesFirst.purchase("2026-03-02", -21223);
    purchasesFirst.purchase("2026-03-03", -32573);
    purchasesFirst.purchase("2026-03-05", -15000);
    await reconcileCryptoTransfers();
    expect(await outcome(purchasesFirst)).toEqual({ transfers: [], queue: [], count: 0 }); // no portfolio yet
    purchasesFirst.deposit("2026-03-03", 21233);
    purchasesFirst.deposit("2026-03-04", 32573);
    await reconcileCryptoTransfers();

    const expected = { transfers: [-32573], queue: [-21223, -15000], count: 2 };
    expect(await outcome(depositsFirst)).toEqual(expected);
    expect(await outcome(purchasesFirst)).toEqual(expected);
  });

  it("queues both equal purchases near one deposit; confirming one takes the other out unchanged", async () => {
    const c = await setup();
    const first = c.purchase("2026-04-01", -10000);
    const second = c.purchase("2026-04-02", -10000);
    const deposit = c.deposit("2026-04-01", 10000);
    await reconcileCryptoTransfers();
    expect(rows("SELECT COUNT(*) AS n FROM crypto_transfer_links WHERE activity_id = ?", deposit)).toEqual([{ n: 0 }]);
    expect((await c.queue()).map((r) => r.id)).toEqual([first, second]);

    const { state, seen } = await open(first);
    await confirmCryptoTransfer(seen, pick(state, deposit));
    await reconcileCryptoTransfers();
    expect(c.txn(first)).toMatchObject({ amount_cents: -10000, category_id: TRANSFER_CATEGORY_ID });
    expect(c.txn(second)).toMatchObject({ amount_cents: -10000, category_id: CRYPTO_CATEGORY_ID });
    expect(await c.queue()).toEqual([]);
    expect(await countCryptoReview(c.profile)).toBe(0);
  });

  it("confirm with unequal amounts -> undo (not queued) -> allow matching (queued again)", async () => {
    const c = await setup();
    const near = c.purchase("2026-03-02", -21223);
    const deposit = c.deposit("2026-03-03", 21233);
    await reconcileCryptoTransfers();
    expect(await c.queuedAmounts()).toEqual([-21223]);

    const { state, seen } = await open(near);
    await confirmCryptoTransfer(seen, pick(state, deposit));
    expect(c.txn(near)).toMatchObject({ amount_cents: -21223, category_id: TRANSFER_CATEGORY_ID });
    expect(rows("SELECT amount_cents FROM investment_activity WHERE id = ?", deposit)).toEqual([{ amount_cents: 21233 }]);
    expect(rows("SELECT confirmed FROM crypto_transfer_links WHERE transaction_id = ?", near)).toEqual([{ confirmed: 1 }]);
    expect(await c.queue()).toEqual([]);

    await undoCryptoTransfer(near);
    expect(c.txn(near)).toMatchObject({ amount_cents: -21223, category_id: CRYPTO_CATEGORY_ID });
    expect(await c.queue()).toEqual([]);
    expect((await getCryptoMatchState(near))!.rejected).toBe(true);

    await allowCryptoMatching(near);
    expect(c.txn(near)).toMatchObject({ amount_cents: -21223, category_id: CRYPTO_CATEGORY_ID });
    expect(await c.queuedAmounts()).toEqual([-21223]);
  });

  for (const spendCategory of [SHOPPING, CRYPTO_CATEGORY_ID]) {
    it(`split into invested + spending (category ${spendCategory}) leaves the queue; undo restores one unqueued row`, async () => {
      const c = await setup();
      const partly = c.purchase("2026-03-05", -15000);
      const deposit = c.deposit("2026-03-06", 12600);
      c.deposit("2026-03-07", 9000); // still free after the split: a Crypto spending part must not be listed against it
      await reconcileCryptoTransfers();
      expect(await c.queuedAmounts()).toEqual([-15000]);

      const { state, seen } = await open(partly);
      await splitCryptoTransfer(seen, pick(state, deposit), 12500, spendCategory);
      await reconcileCryptoTransfers();
      const parts = c.txns();
      expect(parts.map(({ id, amount_cents, category_id, import_hash }) => ({ id, amount_cents, category_id, child: import_hash.startsWith("split:") }))).toEqual([
        { id: partly, amount_cents: -12500, category_id: TRANSFER_CATEGORY_ID, child: false },
        { id: expect.any(Number), amount_cents: -2500, category_id: spendCategory, child: true },
      ]);
      expect(parts.reduce((sum, t) => sum + t.amount_cents, 0)).toBe(-15000);
      expect(await c.queue()).toEqual([]);

      await undoCryptoSplit(partly);
      expect(c.txns().map(({ id, amount_cents, category_id }) => ({ id, amount_cents, category_id })))
        .toEqual([{ id: partly, amount_cents: -15000, category_id: CRYPTO_CATEGORY_ID }]);
      expect(await c.queue()).toEqual([]);
      expect((await getCryptoMatchState(partly))!.rejected).toBe(true);
    });
  }

  it("a split whose deposit went away stays out of the queue (the editor reviews it from the split)", async () => {
    const c = await setup();
    const partly = c.purchase("2026-03-05", -15000);
    const deposit = c.deposit("2026-03-06", 12500);
    c.deposit("2026-03-07", 9000); // another candidate nearby
    const { state, seen } = await open(partly);
    await splitCryptoTransfer(seen, pick(state, deposit), 12500, SHOPPING);
    sqlite.prepare("DELETE FROM investment_activity WHERE id = ?").run(deposit); // e.g. the portfolio import was undone
    await reconcileCryptoTransfers();
    expect(c.txn(partly)).toMatchObject({ amount_cents: -12500, category_id: CRYPTO_CATEGORY_ID });
    expect((await getCryptoMatchState(partly))!.split).not.toBeNull();
    expect(await c.queue()).toEqual([]);
  });

  it("Keep as spending takes a row out of the queue for good", async () => {
    const c = await setup();
    const kept = c.purchase("2026-05-10", -5000);
    c.deposit("2026-05-11", 5100);
    expect(await countCryptoReview(c.profile)).toBe(1);
    await keepCryptoAsSpending(kept);
    await reconcileCryptoTransfers();
    expect(await c.queue()).toEqual([]);
    expect(await countCryptoReview(c.profile)).toBe(0);
    expect(c.txn(kept)).toMatchObject({ amount_cents: -5000, category_id: CRYPTO_CATEGORY_ID });
  });

  it("never queues rows outside the editor's candidate rule", async () => {
    const other = await setup();
    other.deposit("2026-06-01", 4000); // another profile's deposit

    const cases: [string, (c: Awaited<ReturnType<typeof setup>>) => void][] = [
      ["deposit in another profile", (c) => { c.purchase("2026-06-01", -4000); }],
      ["coin the account does not hold as crypto", (c) => { c.purchase("2026-06-01", -4000); c.deposit("2026-06-01", 4000, "ETH"); }],
      ["cash deposit without a symbol", (c) => { c.purchase("2026-06-01", -4000); c.deposit("2026-06-01", 4000, null); }],
      ["deposit 11 days away", (c) => { c.purchase("2026-06-01", -4000); c.deposit("2026-06-12", 4100); }],
      ["outflow in an investment account", (c) => { c.purchase("2026-06-01", -4000, CRYPTO_CATEGORY_ID, c.wallet); c.deposit("2026-06-01", 4100); }],
      ["outflow not categorized Crypto", (c) => { c.purchase("2026-06-01", -4000, SHOPPING); c.deposit("2026-06-01", 4100); }],
      ["Crypto refund (money in)", (c) => { c.purchase("2026-06-01", 4000); c.deposit("2026-06-01", 4100); }],
    ];
    for (const [name, seed] of cases) {
      const c = await setup();
      seed(c);
      await reconcileCryptoTransfers();
      expect(await c.queue(), name).toEqual([]);
      expect(await countCryptoReview(c.profile), name).toBe(0);
    }
    // The 10-day edge itself is inside the rule.
    const edge = await setup();
    edge.purchase("2026-06-01", -4000);
    edge.deposit("2026-06-11", 4100);
    expect(await edge.queuedAmounts()).toEqual([-4000]);
  });

  it("lists two identical purchases (different import hashes) separately", async () => {
    const c = await setup();
    const a = c.purchase("2026-07-01", -7777);
    const b = c.purchase("2026-07-01", -7777);
    c.deposit("2026-07-02", 7800);
    await reconcileCryptoTransfers();
    expect((await c.queue()).map((r) => r.id)).toEqual([a, b]);
    expect(await countCryptoReview(c.profile)).toBe(2);
  });

  it("the editor still offers candidates closest amount first, then by date", async () => {
    const c = await setup();
    const purchase = c.purchase("2026-08-05", -10000);
    // Inserted latest first, and the earliest in a second wallet, so neither row order nor the
    // (account, date) index order produces the expected order: only the ORDER BY does.
    const wallet2 = insert("INSERT INTO accounts (name, account_type, profile_id) VALUES ('Second wallet', 'investment', ?)", c.profile);
    insert("INSERT INTO holdings (account_id, profile_id, as_of_date, security_type, symbol) VALUES (?, ?, '2026-03-31', 'crypto', 'BTC')", wallet2, c.profile);
    const far = c.deposit("2026-08-01", 10300);
    const lowLate = c.deposit("2026-08-04", 9900);
    const high = c.deposit("2026-08-03", 10100);
    const lowEarly = c.deposit("2026-08-02", 9900, "BTC", wallet2);
    expect((await getCryptoMatchState(purchase))!.candidates.map((d) => d.id)).toEqual([lowEarly, high, lowLate, far]);
  });

  it("the editor offers the default profile's deposits for a row without a profile", async () => {
    await getDb();
    const checking = insert("INSERT INTO accounts (name, account_type, profile_id) VALUES ('Old checking', 'checking', 1)");
    const wallet = insert("INSERT INTO accounts (name, account_type, profile_id) VALUES ('Old Ledger', 'investment', 1)");
    insert("INSERT INTO holdings (account_id, profile_id, as_of_date, security_type, symbol) VALUES (?, 1, '2026-09-30', 'crypto', 'BTC')", wallet);
    const deposit = insert("INSERT INTO investment_activity (account_id, profile_id, trade_date, activity_type, symbol, import_hash, amount_cents) VALUES (?, 1, '2026-09-02', 'deposit', 'BTC', 'old-deposit', 6100)", wallet);
    const purchase = insert(`INSERT INTO transactions (account_id, profile_id, date, amount_cents, description, category_id, import_hash) VALUES (?, NULL, '2026-09-01', -6000, 'Exchange purchase', ${CRYPTO_CATEGORY_ID}, 'old-purchase')`, checking);
    expect((await getCryptoMatchState(purchase))!.candidates.map((d) => d.id)).toEqual([deposit]);
    // Unlike the other cases this one uses profile 1: remove its rows so other cases are unaffected.
    for (const [table, id] of [["transactions", purchase], ["investment_activity", deposit], ["accounts", checking], ["accounts", wallet]] as const)
      sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    sqlite.prepare("DELETE FROM holdings WHERE account_id = ?").run(wallet);
  });
});
