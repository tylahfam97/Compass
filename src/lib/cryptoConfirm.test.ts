// Authored for #107; NOT executed in the authoring run (no-tests rule). Drives the real db.ts
// mutation functions through the mocked native SQL bridge and checks the SQL they issue.
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { confirmCryptoTransfer, deleteAllProfileData, getDb, undoCryptoTransfer, keepCryptoAsSpending, splitCryptoTransfer, undoCryptoSplit } from "./db";

import { TRANSFER_CATEGORY_ID } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Stmt = { sql: string; params: unknown[] };
let batches: Stmt[][] = [];
let linkCount = 1;
let splitOk = 1;
let splitLeft = 0;

beforeEach(async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "db_select") {
      if (/PRAGMA user_version/.test(args.sql)) return [{ user_version: 1e9 }];
      if (/COUNT\(\*\) AS n FROM crypto_transfer_links/.test(args.sql)) return [{ n: linkCount }];
      if (/COUNT\(\*\) AS n FROM transaction_splits s/.test(args.sql)) return [{ n: splitOk }];
      if (/COUNT\(\*\) AS n FROM transaction_splits WHERE/.test(args.sql)) return [{ n: splitLeft }];
      return [];
    }
    if (cmd === "db_execute_batch") { batches.push(args.statements); return undefined; }
    return { rowsAffected: 0, lastInsertId: 0 };
  });
  await getDb(); // migrations run once against the mock
  batches = [];
  linkCount = 1;
  splitOk = 1;
  splitLeft = 0;
  vi.mocked(invoke).mockClear();
});

const SEEN = { transactionId: 7, categoryId: 21, amountCents: -21223, accountId: 4, profileId: 1, date: "2026-05-01" };
const DEP = { id: 3, amountCents: 21233, date: "2026-05-02", symbol: "BTC", accountId: 9 };

it("confirm guards on what the user saw and never touches amount/balance", async () => {
  await confirmCryptoTransfer(SEEN, DEP);
  const [insert, update] = batches[0];
  expect(insert.sql).toMatch(/confirmed, confirmed_txn_cents, confirmed_deposit_cents/);
  expect(insert.sql).toMatch(/t\.amount_cents = \?/);
  expect(insert.sql).toMatch(/ia\.amount_cents = \?/);
  expect(insert.sql).toMatch(/ia\.id NOT IN \(SELECT activity_id FROM crypto_transfer_links\)/); // no duplicate
  // Deposit id/amount/date/coin/account, then row id/amount/account/profile/date/category.
  expect(insert.params).toEqual([3, 21233, "2026-05-02", "BTC", 9, 7, -21223, 4, 1, "2026-05-01", 21]);
  expect(insert.sql).toMatch(/ia\.trade_date = \? AND ia\.symbol = \? AND ia\.account_id = \?/);
  expect(insert.sql).toMatch(/t\.account_id = \? AND COALESCE\(t\.profile_id, 1\) = \? AND t\.date = \?/);
  expect(insert.sql).toMatch(/NOT IN \(SELECT parent_id FROM transaction_splits\)/);
  expect(update.sql).toMatch(/SET category_id = \d+\s/);
  expect(batches.flat().some((s) => /amount_cents\s*=\s*\?.*SET|SET[^W]*amount_cents|balance/i.test(s.sql))).toBe(false);
});

it("confirm reports a stale source instead of pretending success", async () => {
  linkCount = 0;
  await expect(confirmCryptoTransfer({ ...SEEN, amountCents: -100 }, { ...DEP, amountCents: 90 }))
    .rejects.toThrow(/changed since you opened it/);
});

it("undo records an account-scoped rejection before restoring the category, then drops the link", async () => {
  await undoCryptoTransfer(7);
  const [reject, restore, drop] = batches[0];
  expect(reject.sql).toMatch(/crypto_transfer_rejections \(account_id, import_hash\)/);
  expect(restore.sql).toMatch(/previous_category_id/);
  expect(restore.sql).toMatch(/category_id = \d+ AND id IN/); // later human edits are kept
  expect(drop.sql).toMatch(/DELETE FROM crypto_transfer_links/);
});

it("keep-as-spending and profile erase are scoped to the account, not a bare import hash", async () => {
  await keepCryptoAsSpending(7);
  const exec = vi.mocked(invoke).mock.calls.find(([c]) => c === "db_execute")!;
  expect((exec[1] as any).sql).toMatch(/SELECT account_id, import_hash FROM transactions WHERE id = \?/);
  await deleteAllProfileData(2);
  const erase = batches.at(-1)!;
  const i = erase.findIndex((s) => /crypto_transfer_rejections/.test(s.sql));
  expect(erase[i].sql).toMatch(/account_id IN \(SELECT id FROM accounts WHERE profile_id=\?\)/);
  expect(i).toBeLessThan(erase.findIndex((s) => /DELETE FROM accounts/.test(s.sql)));
});

// ── Split (#107: 150 bank -> 125 invested + 25 spending, entered by the user) ──
const SPLIT_SEEN = { ...SEEN, amountCents: -15000 };

it("split rejects non-integer, out-of-range and Transfers allocations before touching the db", async () => {
  for (const [invest, cat] of [[12500.5, 5], [0, 5], [15000, 5], [16000, 5], [-1, 5], [12500, TRANSFER_CATEGORY_ID], [12500, 5.5]]) {
    await expect(splitCryptoTransfer(SPLIT_SEEN, DEP, invest, cat)).rejects.toThrow(/investment amount/);
  }
  await expect(splitCryptoTransfer({ ...SPLIT_SEEN, amountCents: 15000 }, DEP, 100, 5)).rejects.toThrow(/investment amount/);
  expect(batches).toHaveLength(0);
});

it("split parts sum exactly to the original, keep its identity, and every step keys off the guarded snapshot", async () => {
  await splitCryptoTransfer(SPLIT_SEEN, DEP, 12500, 5);
  const [snap, child, link, parent] = batches[0];
  expect(batches[0]).toHaveLength(4); // one atomic batch
  // snapshot: invest -12500 + spend -2500 = original -15000, guarded on everything the dialog showed
  expect(snap.params.slice(0, 3)).toEqual([-12500, -2500, 5]);
  expect(snap.params.slice(-2)).toEqual([-2500, 12500]);
  expect(snap.sql).toMatch(/t\.amount_cents = \? - \?/);
  expect(snap.sql).toMatch(/NOT IN \(SELECT parent_id FROM transaction_splits\)/); // no double split
  expect(snap.sql).toMatch(/import_hash NOT LIKE 'split:%'/); // a part is never split again
  const token = snap.params[3];
  // child: deterministic hash, same account/date/session/balance as the original
  expect(child.sql).toMatch(/'split:' \|\| t\.id, t\.balance_cents, t\.profile_id, t\.import_session_id/);
  expect(child.sql).toMatch(/t\.amount_cents = s\.original_cents/);
  expect(link.sql).toMatch(/confirmed, confirmed_txn_cents/);
  // original: amount only changes from the exact seen total, and only in this batch's snapshot
  expect(parent.sql).toMatch(/WHERE id = \? AND amount_cents = \? AND EXISTS/);
  expect(parent.params).toEqual([7, -15000, 7, token]);
  for (const st of [child, link]) expect(st.params).toEqual([7, token]);
  expect(batches[0].some((st) => /import_hash\s*=/.test(st.sql) && /UPDATE transactions/.test(st.sql))).toBe(false);
});

it("split reports a stale dialog (nothing applied) instead of pretending success", async () => {
  splitOk = 0;
  await expect(splitCryptoTransfer(SPLIT_SEEN, DEP, 12500, 5)).rejects.toThrow(/changed since you opened it/);
});

it("undo split marks first, then removes the part, link and restores, all keyed off the mark", async () => {
  await undoCryptoSplit(7);
  const [mark, delChild, delLink, reject, restore, drop] = batches[0];
  expect(mark.sql).toMatch(/SET undo_token = \?/);
  expect(mark.sql).toMatch(/p\.amount_cents = transaction_splits\.invest_cents/);
  expect(mark.sql).toMatch(/c\.amount_cents = transaction_splits\.spend_cents AND COALESCE\(c\.category_id, 0\) = transaction_splits\.spend_category_id/);
  expect(mark.sql).toMatch(/p\.account_id = transaction_splits\.account_id/);
  const token = mark.params[0];
  expect(delChild.sql).toMatch(/import_hash = 'split:' \|\| \? AND account_id = \(SELECT account_id/);
  for (const st of [delChild, delLink, reject, restore]) expect(st.params.at(-1)).toBe(token);
  expect(restore.sql).toMatch(/amount_cents = \(SELECT original_cents/);
  expect(drop.params).toEqual([7, token]);
});

it("undo split refuses (and says so) when a part was edited since", async () => {
  splitLeft = 1;
  await expect(undoCryptoSplit(7)).rejects.toThrow(/can't be undone automatically - nothing was changed/);
});

it("whole-row undo never touches a split original", async () => {
  await undoCryptoTransfer(7);
  for (const st of batches[0]) expect(st.sql).toMatch(/NOT IN \(SELECT parent_id FROM transaction_splits\)/);
});

it("profile erase removes split snapshots by account before accounts", async () => {
  await deleteAllProfileData(2);
  const erase = batches.at(-1)!;
  const i = erase.findIndex((st) => /DELETE FROM transaction_splits/.test(st.sql));
  expect(erase[i].sql).toMatch(/account_id IN \(SELECT id FROM accounts WHERE profile_id=\?\)/);
  expect(i).toBeLessThan(erase.findIndex((st) => /DELETE FROM accounts/.test(st.sql)));
});
