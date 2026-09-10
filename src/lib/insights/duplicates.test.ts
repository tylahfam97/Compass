import { describe, it, expect } from "vitest";
import { findDuplicateCharges, findFrequentMerchants } from "./duplicates";

let nextId = 1;
const txn = (date: string, description: string, amount_cents: number, account_id = 1) =>
  ({ id: nextId++, account_id, date, description, amount_cents });

describe("findDuplicateCharges", () => {
  it("flags two identical same-day charges from one merchant", () => {
    const rows = [txn("2026-09-04", "HOME DEPOT #1234", -8600), txn("2026-09-04", "HOME DEPOT #1234", -8600)];
    const out = findDuplicateCharges(rows, { sinceIso: "2026-08-01" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "HOME DEPOT", amountCents: 8600, date: "2026-09-04" });
    expect(out[0].ids).toHaveLength(2);
  });

  it("ignores next-day repeats, small amounts, other accounts and known recurring charges", () => {
    expect(findDuplicateCharges([txn("2026-09-04", "Home Depot", -8600), txn("2026-09-05", "Home Depot", -8600)], { sinceIso: "2026-08-01" })).toHaveLength(0);
    expect(findDuplicateCharges([txn("2026-09-04", "Coffee", -650), txn("2026-09-04", "Coffee", -650)], { sinceIso: "2026-08-01" })).toHaveLength(0);
    expect(findDuplicateCharges([txn("2026-09-04", "Home Depot", -8600, 1), txn("2026-09-04", "Home Depot", -8600, 2)], { sinceIso: "2026-08-01" })).toHaveLength(0);
    expect(findDuplicateCharges([txn("2026-09-04", "Netflix", -1799), txn("2026-09-04", "Netflix", -1799)], { sinceIso: "2026-08-01", excludeKeys: new Set(["NETFLIX"]) })).toHaveLength(0);
  });

  it("ignores habitual merchants", () => {
    const rows = Array.from({ length: 7 }, (_, i) => txn(`2026-08-${String(10 + i).padStart(2, "0")}`, "City Transit", -2400));
    rows.push(txn("2026-09-04", "City Transit", -2400), txn("2026-09-04", "City Transit", -2400));
    expect(findDuplicateCharges(rows, { sinceIso: "2026-09-01" })).toHaveLength(0);
  });

  it("does not report pairs older than the window even though they count toward frequency", () => {
    const rows = [txn("2026-07-04", "Home Depot", -8600), txn("2026-07-04", "Home Depot", -8600)];
    expect(findDuplicateCharges(rows, { sinceIso: "2026-08-01" })).toHaveLength(0);
  });
});

describe("findFrequentMerchants", () => {
  it("groups by merchant key and applies the count and total floors", () => {
    const rows = [
      ...Array.from({ length: 8 }, () => ({ description: "SQ *NEIGHBORHOOD COFFEE", amount_cents: -650 })),
      ...Array.from({ length: 3 }, () => ({ description: "Bookshop", amount_cents: -3800 })),
      ...Array.from({ length: 7 }, () => ({ description: "Vending", amount_cents: -150 })),
    ];
    const out = findFrequentMerchants(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "NEIGHBORHOOD COFFEE", count: 8, totalCents: 5200 });
  });
});
