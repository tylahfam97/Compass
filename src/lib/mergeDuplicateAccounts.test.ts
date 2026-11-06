import { describe, it, expect, vi } from "vitest";

// Real in-memory SQLite (Node's built-in node:sqlite) behind the same invoke() commands the
// Rust layer serves, so the real migrations and the real merge SQL both run. Foreign keys stay
// off, exactly like the app, so nothing cascades behind the merge's back.
const sqlite = vi.hoisted(() => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  return new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
});

vi.mock("@tauri-apps/api/core", () => {
  // Same coercion as the Rust json_to_sql: booleans become 0/1, missing values NULL.
  const bind = (params: unknown[] = []) =>
    params.map((v) => (typeof v === "boolean" ? Number(v) : v ?? null)) as (string | number | null)[];
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

import { getDb, mergeDuplicateAccounts, splitCryptoTransfer, undoCryptoSplit } from "./db";
import { TRANSFER_CATEGORY_ID } from "./types";

const insert = (sql: string, ...params: (string | number)[]) =>
  Number(sqlite.prepare(sql).run(...params).lastInsertRowid);
const rows = (sql: string, ...params: (string | number)[]) => sqlite.prepare(sql).all(...params);

describe("mergeDuplicateAccounts", () => {
  it("moves investment rows, goals and scheduled rules onto the primary; the primary's copy wins collisions", async () => {
    await getDb(); // run the real migrations first
    insert("INSERT INTO profiles (id, name) VALUES (2, 'Other')");
    const acct = (profile: number, created: string) =>
      insert("INSERT INTO accounts (name, account_type, profile_id, created_at) VALUES ('Brokerage', 'investment', ?, ?)", profile, created);
    const primary = acct(1, "2026-01-01 00:00:00");
    const dupe = acct(1, "2026-02-01 00:00:00");
    const otherProfile = acct(2, "2026-01-15 00:00:00");

    const activity = (account: number, profile: number, hash: string, cents: number) =>
      insert("INSERT INTO investment_activity (account_id, profile_id, trade_date, activity_type, import_hash, amount_cents) VALUES (?, ?, '2026-03-01', 'dividend', ?, ?)", account, profile, hash, cents);
    activity(primary, 1, "shared", 100);
    activity(dupe, 1, "shared", 999);
    activity(dupe, 1, "dupe-only", 50);
    activity(otherProfile, 2, "shared", 7);

    const summary = (account: number, periodEnd: string, cents: number) =>
      insert("INSERT INTO investment_summaries (account_id, profile_id, period_end, ending_value_cents) VALUES (?, 1, ?, ?)", account, periodEnd, cents);
    summary(primary, "2026-03-31", 1000);
    summary(dupe, "2026-03-31", 9999);
    summary(dupe, "2026-06-30", 2000);

    const goal = insert("INSERT INTO goals (name, type, profile_id, account_id) VALUES ('Pay down', 'debt_paydown', 1, ?)", dupe);
    const rule = insert("INSERT INTO recurring_rules (profile_id, account_id, description, amount_cents, start_date) VALUES (1, ?, 'Contribution', -500, '2026-01-01')", dupe);

    expect(await mergeDuplicateAccounts(1)).toBe(1);

    expect(rows("SELECT id FROM accounts WHERE name='Brokerage' ORDER BY id")).toEqual([{ id: primary }, { id: otherProfile }]);
    expect(rows("SELECT account_id, import_hash, amount_cents FROM investment_activity ORDER BY account_id, import_hash")).toEqual([
      { account_id: primary, import_hash: "dupe-only", amount_cents: 50 },
      { account_id: primary, import_hash: "shared", amount_cents: 100 },
      { account_id: otherProfile, import_hash: "shared", amount_cents: 7 },
    ]);
    expect(rows("SELECT account_id, period_end, ending_value_cents FROM investment_summaries ORDER BY period_end")).toEqual([
      { account_id: primary, period_end: "2026-03-31", ending_value_cents: 1000 },
      { account_id: primary, period_end: "2026-06-30", ending_value_cents: 2000 },
    ]);
    expect(rows("SELECT account_id FROM goals WHERE id=?", goal)).toEqual([{ account_id: primary }]);
    expect(rows("SELECT account_id FROM recurring_rules WHERE id=?", rule)).toEqual([{ account_id: primary }]);
  });

  it("discards a split's spending part with its discarded original, keeps every other split intact and undoable (#107)", async () => {
    await getDb();
    insert("INSERT OR IGNORE INTO profiles (id, name) VALUES (2, 'Other')");
    const acct = (profile: number, name: string, type: string, created: string) =>
      insert("INSERT INTO accounts (name, account_type, profile_id, created_at) VALUES (?, ?, ?, ?)", name, type, profile, created);
    // A tracked crypto portfolio per profile, so the real split helper accepts its deposits.
    const wallet = (profile: number) => {
      const id = acct(profile, "Coinbase", "investment", "2026-01-01 00:00:00");
      insert("INSERT INTO holdings (account_id, profile_id, as_of_date, security_type, symbol) VALUES (?, ?, '2026-03-31', 'crypto', 'BTC')", id, profile);
      return id;
    };
    const wallet1 = wallet(1);
    const wallet2 = wallet(2);
    const deposit = (account: number, profile: number, hash: string, cents: number) => ({
      id: insert("INSERT INTO investment_activity (account_id, profile_id, trade_date, activity_type, symbol, import_hash, amount_cents) VALUES (?, ?, '2026-03-01', 'deposit', 'BTC', ?, ?)", account, profile, hash, cents),
      amountCents: cents, date: "2026-03-01", symbol: "BTC", accountId: account,
    });
    const primary = acct(1, "Checking", "checking", "2026-01-01 00:00:00");
    const dupe = acct(1, "Checking", "checking", "2026-02-01 00:00:00");
    const other = acct(2, "Checking", "checking", "2026-01-15 00:00:00");
    const outflow = (account: number, profile: number, hash: string, cents: number) => ({
      transactionId: insert("INSERT INTO transactions (account_id, profile_id, date, amount_cents, category_id, import_hash) VALUES (?, ?, '2026-03-01', ?, 15, ?)", account, profile, cents, hash),
      categoryId: 15, amountCents: cents, accountId: account, profileId: profile, date: "2026-03-01",
    });
    const split = async (o: ReturnType<typeof outflow>, d: ReturnType<typeof deposit>) => {
      await splitCryptoTransfer(o, d, d.amountCents, 7);
      return o.transactionId;
    };

    insert("INSERT INTO transactions (account_id, profile_id, date, amount_cents, category_id, import_hash) VALUES (?, 1, '2026-03-01', -15000, 15, 'H')", primary);
    const primarySplit = await split(outflow(primary, 1, "P", -10000), deposit(wallet1, 1, "d-p", 9000));
    // The same statement row H on the duplicate, split there: the primary's full copy wins.
    const collidingSplit = await split(outflow(dupe, 1, "H", -15000), deposit(wallet1, 1, "d-h", 12500));
    const movedSplit = await split(outflow(dupe, 1, "K", -5000), deposit(wallet1, 1, "d-k", 4000));
    const otherSplit = await split(outflow(other, 2, "H", -15000), deposit(wallet2, 2, "d-o", 12500));
    const otherBefore = rows("SELECT * FROM transactions WHERE account_id=? ORDER BY id", other);

    expect(await mergeDuplicateAccounts(1)).toBe(1);

    const total = (account: number) => (rows("SELECT SUM(amount_cents) AS n FROM transactions WHERE account_id=?", account)[0] as { n: number }).n;
    expect(rows("SELECT import_hash, amount_cents, category_id FROM transactions WHERE account_id=? ORDER BY import_hash", primary)).toEqual([
      { import_hash: "H", amount_cents: -15000, category_id: 15 },
      { import_hash: "K", amount_cents: -4000, category_id: TRANSFER_CATEGORY_ID },
      { import_hash: "P", amount_cents: -9000, category_id: TRANSFER_CATEGORY_ID },
      { import_hash: `split:${movedSplit}`, amount_cents: -1000, category_id: 7 },
      { import_hash: `split:${primarySplit}`, amount_cents: -1000, category_id: 7 },
    ].sort((a, b) => (a.import_hash < b.import_hash ? -1 : 1)));
    // Every statement dollar counted exactly once: H + P + K as imported.
    expect(total(primary)).toBe(-15000 - 10000 - 5000);
    expect(rows("SELECT id FROM transactions WHERE account_id=? OR id=? OR import_hash=?", dupe, collidingSplit, `split:${collidingSplit}`)).toEqual([]);
    expect(rows("SELECT parent_id, account_id, original_cents, invest_cents, spend_cents FROM transaction_splits ORDER BY parent_id")).toEqual([
      { parent_id: primarySplit, account_id: primary, original_cents: -10000, invest_cents: -9000, spend_cents: -1000 },
      { parent_id: movedSplit, account_id: primary, original_cents: -5000, invest_cents: -4000, spend_cents: -1000 },
      { parent_id: otherSplit, account_id: other, original_cents: -15000, invest_cents: -12500, spend_cents: -2500 },
    ]);
    expect(rows("SELECT transaction_id, confirmed_txn_cents FROM crypto_transfer_links ORDER BY transaction_id")).toEqual([
      { transaction_id: primarySplit, confirmed_txn_cents: -9000 },
      { transaction_id: movedSplit, confirmed_txn_cents: -4000 },
      { transaction_id: otherSplit, confirmed_txn_cents: -12500 },
    ]);
    // Another profile's same-named account and its split are untouched.
    expect(rows("SELECT * FROM transactions WHERE account_id=? ORDER BY id", other)).toEqual(otherBefore);
    expect(total(other)).toBe(-15000);

    // The moved split still undoes exactly on the merged account.
    await undoCryptoSplit(movedSplit);
    expect(rows("SELECT amount_cents, category_id FROM transactions WHERE id=?", movedSplit)).toEqual([{ amount_cents: -5000, category_id: 15 }]);
    expect(rows("SELECT id FROM transactions WHERE import_hash=?", `split:${movedSplit}`)).toEqual([]);
    expect(rows("SELECT parent_id FROM transaction_splits WHERE parent_id=?", movedSplit)).toEqual([]);
    expect(total(primary)).toBe(-15000 - 10000 - 5000);
  });
});
