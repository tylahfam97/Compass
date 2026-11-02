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

import { getDb, mergeDuplicateAccounts } from "./db";

const insert = (sql: string, ...params: (string | number)[]) =>
  Number(sqlite.prepare(sql).run(...params).lastInsertRowid);
const rows = (sql: string, ...params: number[]) => sqlite.prepare(sql).all(...params);

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
});
