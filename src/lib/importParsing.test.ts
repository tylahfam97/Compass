import { describe, it, expect } from "vitest";
import { parseDate, parseAmount, hashRow, dedupeRowHash } from "./importParsing";

describe("parseDate", () => {
  it("parses MM/DD/YYYY into ISO", () => {
    expect(parseDate("3/5/2024")).toBe("2024-03-05");
  });

  it("passes through an already-ISO date", () => {
    expect(parseDate("2024-03-05")).toBe("2024-03-05");
  });

  it("rejects an impossible calendar date in MM/DD/YYYY form (Feb 31)", () => {
    expect(parseDate("02/31/2024")).toBe("");
  });

  it("rejects an impossible calendar date in ISO form", () => {
    expect(parseDate("2024-02-31")).toBe("");
  });

  it("rejects a nonexistent April 31st", () => {
    expect(parseDate("04/31/2024")).toBe("");
  });

  it("falls back to native Date parsing for other recognizable formats", () => {
    expect(parseDate("March 5, 2024")).toBe("2024-03-05");
  });
});

describe("parseAmount", () => {
  it("parses a plain positive amount", () => {
    expect(parseAmount("123.45")).toBe(123.45);
  });

  it("treats parentheses as negative", () => {
    expect(parseAmount("(123.45)")).toBe(-123.45);
  });

  it("treats a leading minus as negative", () => {
    expect(parseAmount("-123.45")).toBe(-123.45);
  });

  it("strips currency symbols and thousands separators", () => {
    expect(parseAmount("$1,234.56")).toBe(1234.56);
  });

  it("treats a trailing CR suffix as positive/credit", () => {
    expect(parseAmount("123.45 CR")).toBe(123.45);
    expect(parseAmount("123.45CR")).toBe(123.45);
  });

  it("treats a trailing DR suffix as negative/debit", () => {
    expect(parseAmount("123.45 DR")).toBe(-123.45);
    expect(parseAmount("123.45dr")).toBe(-123.45);
  });

  it("returns 0 for unparseable input", () => {
    expect(parseAmount("n/a")).toBe(0);
  });
});

describe("dedupeRowHash", () => {
  it("leaves the first occurrence of a row unchanged from hashRow", async () => {
    const row = ["2024-01-01", "Coffee", "5.00"];
    const plain = await hashRow(row);
    const deduped = await dedupeRowHash(row, new Map());
    expect(deduped).toBe(plain);
  });

  it("gives a second identical row within the same file a different hash", async () => {
    const row = ["2024-01-01", "Coffee", "5.00"];
    const seen = new Map<string, number>();
    const first = await dedupeRowHash(row, seen);
    const second = await dedupeRowHash(row, seen);
    expect(second).not.toBe(first);
  });

  it("does not affect hashes of distinct rows", async () => {
    const seen = new Map<string, number>();
    const a = await dedupeRowHash(["2024-01-01", "Coffee", "5.00"], seen);
    const b = await dedupeRowHash(["2024-01-01", "Tea", "4.00"], seen);
    expect(a).not.toBe(b);
  });
});
