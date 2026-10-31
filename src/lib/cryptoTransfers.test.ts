import { describe, it, expect } from "vitest";
import { matchCryptoTransfers } from "./cryptoTransfers";
import type { CryptoOutflow, PortfolioDeposit } from "./cryptoTransfers";

const out = (id: number, date: string, amountCents: number, profileId = 1, eligible = true): CryptoOutflow => ({ id, profileId, date, amountCents, eligible });
const dep = (id: number, date: string, amountCents: number, profileId = 1): PortfolioDeposit => ({ id, profileId, date, amountCents });

describe("matchCryptoTransfers", () => {
  it("matches only exact-cent amounts within the window, in either date order", () => {
    // Synthetic version of the #107 example: one exact match, one 10-cent near-miss, one unmatched.
    const outflows = [out(1, "2026-03-02", -32573), out(2, "2026-03-05", -21223), out(3, "2026-03-09", -15000)];
    const deposits = [dep(10, "2026-02-28", 32573), dep(11, "2026-03-05", 21233), dep(12, "2026-03-10", 12500)];
    expect(matchCryptoTransfers(outflows, deposits)).toEqual([{ transactionId: 1, activityId: 10 }]);
  });

  it("leaves ambiguous amounts unmatched on both sides", () => {
    expect(matchCryptoTransfers([out(1, "2026-03-02", -10000), out(2, "2026-03-03", -10000)], [dep(10, "2026-03-02", 10000)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-02", -10000)], [dep(10, "2026-03-02", 10000), dep(11, "2026-03-04", 10000)])).toEqual([]);
  });

  it("treats a same-amount Transfers outflow as competing funding, never as a match", () => {
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000), out(2, "2026-03-02", -5000, 1, false)], [dep(10, "2026-03-02", 5000)])).toEqual([]);
    expect(matchCryptoTransfers([out(2, "2026-03-02", -5000, 1, false)], [dep(10, "2026-03-02", 5000)])).toEqual([]);
  });

  it("never matches an unreadable date", () => {
    expect(matchCryptoTransfers([out(1, "03/01/2026", -5000)], [dep(10, "2026-03-01", 5000)])).toEqual([]);
  });

  it("respects the window, the profile and the money direction", () => {
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000)], [dep(10, "2026-03-07", 5000)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000)], [dep(10, "2026-03-06", 5000)])).toEqual([{ transactionId: 1, activityId: 10 }]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000, 1)], [dep(10, "2026-03-01", 5000, 2)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", 5000)], [dep(10, "2026-03-01", 5000)])).toEqual([]);
    expect(matchCryptoTransfers([out(1, "2026-03-01", -5000)], [dep(10, "2026-03-01", -5000)])).toEqual([]);
  });

  it("counts calendar days across month and year ends", () => {
    expect(matchCryptoTransfers([out(1, "2025-12-30", -700)], [dep(10, "2026-01-04", 700)])).toEqual([{ transactionId: 1, activityId: 10 }]);
  });
});
