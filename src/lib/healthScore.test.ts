import { describe, it, expect, vi, beforeEach } from "vitest";

// Real in-memory SQLite (Node's built-in node:sqlite) behind the same invoke() commands the Rust
// layer serves, so the real migrations and the real score SQL - including the per-account
// correlated balance subqueries - run against synthetic rows. Same harness as
// mergeDuplicateAccounts.test.ts.
const sqlite = vi.hoisted(() => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  return new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
});

vi.mock("@tauri-apps/api/core", () => {
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

import { getDb } from "./db";
import { computeHealthScore, computeCreditCardHealthScore } from "./agent";

/** A local YYYY-MM-DD date in the last complete calendar month (the score's savings window). */
function lastMonth(day: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let hash = 0;
function txn(accountId: number, date: string, amountCents: number, balanceCents: number | null = null) {
  sqlite.prepare("INSERT INTO transactions (account_id, profile_id, date, description, amount_cents, balance_cents, import_hash) VALUES (?, 1, ?, 'Synthetic', ?, ?, ?)")
    .run(accountId, date, amountCents, balanceCents, `synthetic-${++hash}`);
}
function account(id: number, type: string) {
  sqlite.prepare("INSERT INTO accounts (id, name, account_type, profile_id) VALUES (?, ?, ?, 1)").run(id, `Synthetic ${type} ${id}`, type);
}

beforeEach(async () => {
  await getDb(); // real migrations
  sqlite.exec("DELETE FROM transactions; DELETE FROM accounts; DELETE FROM budgets;");
});

describe("computeHealthScore on real SQL", () => {
  // One complete month: $3,000 in, $2,500 out -> 16.7% savings -> 30 of 40.
  const month = (balanceAfter: number | null) => {
    account(1, "checking");
    txn(1, lastMonth(1), 300_000);
    txn(1, lastMonth(20), -250_000, balanceAfter);
  };

  it("scores an overdrawn checking balance in the lowest runway band, not the neutral no-data score", async () => {
    month(-5_000);
    const score = await computeHealthScore([1]);
    expect(score.components.balanceRunway).toMatchObject({ score: 2, measured: true });
    expect(score.components.savingsRate).toMatchObject({ score: 30, measured: true });
    expect(score.hasData).toBe(true);
  });

  it("never lets zero cash outscore a thin positive cushion", async () => {
    month(0);
    const empty = (await computeHealthScore([1])).components.balanceRunway.score;
    sqlite.exec("DELETE FROM transactions; DELETE FROM accounts;");
    month(50_000); // 0.2 months of spending
    const thin = (await computeHealthScore([1])).components.balanceRunway.score;
    expect(empty).toBe(2);
    expect(empty).toBeLessThanOrEqual(thin);
  });

  it("keeps the neutral runway score, flagged unmeasured, when no checking balance is on record", async () => {
    month(null);
    expect((await computeHealthScore([1])).components.balanceRunway).toMatchObject({ score: 10, measured: false });
  });

  it("does not grade a profile with nothing to measure", async () => {
    const score = await computeHealthScore([1]);
    expect(score.components.savingsRate).toMatchObject({ score: 20, measured: false });
    expect(score).toMatchObject({ hasData: false, grade: "—", label: "Not enough data yet" });
  });

  it("still scores spending with no income as a measured 0% savings rate", async () => {
    account(1, "checking");
    txn(1, lastMonth(5), -90_000);
    expect((await computeHealthScore([1])).components.savingsRate).toMatchObject({ score: 0, measured: true });
  });
});

describe("computeCreditCardHealthScore on real SQL", () => {
  it("does not let one card's credit balance offset another card's debt", async () => {
    // Owes $2,000 on one card; another is $600 in credit. Owed is $2,000 (75 pts, at most half
    // the $6,000 benchmark), not a netted $1,400 (90 pts).
    account(2, "credit");
    account(3, "credit");
    txn(2, lastMonth(15), -10_000, -200_000);
    txn(3, lastMonth(15), 10_000, 60_000);
    expect(await computeCreditCardHealthScore([1])).toMatchObject({ score: 75, hasData: true, debtCents: -200_000 });
  });

  it("treats a card in credit as owing nothing", async () => {
    account(2, "credit");
    txn(2, lastMonth(15), 10_000, 50_000);
    expect(await computeCreditCardHealthScore([1])).toMatchObject({ score: 100, debtCents: 0 });
  });

  it("reports no data, not a perfect score, when no card has a balance on file", async () => {
    account(2, "credit");
    txn(2, lastMonth(15), -30_000);
    expect((await computeCreditCardHealthScore([1])).hasData).toBe(false);
  });
});
