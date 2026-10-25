import { describe, it, expect } from "vitest";
import {
  parseDate, parseAmount, parseSplitAmount, hashRow, dedupeRowHash, detectSplitAmountColumns, countAmountsOnlyIn,
  countOmittedSplitRows,
} from "./importParsing";

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

  it("returns empty string (not the raw text) for an unparseable cell", () => {
    expect(parseDate("Pending")).toBe("");
    expect(parseDate("N/A")).toBe("");
    expect(parseDate("Total")).toBe("");
  });

  it("parses 2-digit years with a sensible century pivot", () => {
    expect(parseDate("3/5/24")).toBe("2024-03-05");
    expect(parseDate("12/31/99")).toBe("1999-12-31");
  });

  it("parses dash-separated MM-DD-YYYY", () => {
    expect(parseDate("03-05-2024")).toBe("2024-03-05");
  });

  it("recognizes unambiguous DD/MM/YYYY (day > 12) and swaps", () => {
    expect(parseDate("25/12/2026")).toBe("2026-12-25");
  });

  it("strips a trailing time-of-day", () => {
    expect(parseDate("09/05/2026 14:32")).toBe("2026-09-05");
    expect(parseDate("2026-09-05 14:32:15")).toBe("2026-09-05");
    expect(parseDate("3/5/2024 2:32 PM")).toBe("2024-03-05");
  });

  it("parses compact YYYYMMDD", () => {
    expect(parseDate("20260905")).toBe("2026-09-05");
    expect(parseDate("20260231")).toBe("");
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

  it("treats a trailing minus as negative", () => {
    expect(parseAmount("12.34-")).toBe(-12.34);
  });

  it("strips currency codes and extra symbols", () => {
    expect(parseAmount("USD 12.34")).toBe(12.34);
    expect(parseAmount("12.34 EUR")).toBe(12.34);
    expect(parseAmount("€1,234.56")).toBe(1234.56);
  });

  it("parses European decimal commas", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1234,56")).toBe(1234.56);
    expect(parseAmount("-0,50")).toBe(-0.5);
  });

  it("still treats a US thousands comma as a separator", () => {
    expect(parseAmount("1,234")).toBe(1234);
    expect(parseAmount("12,345.67")).toBe(12345.67);
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

describe("detectSplitAmountColumns", () => {
  it("finds separate Debit and Credit columns", () => {
    expect(detectSplitAmountColumns(["Date", "Description", "Debit", "Credit"])).toEqual({ debitCol: 2, creditCol: 3 });
    expect(detectSplitAmountColumns(["Posted", "Payee", "Credit Amount", "Debit Amount"])).toEqual({ debitCol: 3, creditCol: 2 });
  });

  it("leaves single-amount and combined Debit/Credit headers alone", () => {
    expect(detectSplitAmountColumns(["Date", "Description", "Amount"])).toBeNull();
    expect(detectSplitAmountColumns(["Date", "Description", "Debit/Credit", "Amount"])).toBeNull();
    expect(detectSplitAmountColumns(["Date", "Description", "Debit"])).toBeNull();
  });

  it("only reads monetary Debit/Credit headers, not identifiers like card numbers", () => {
    expect(detectSplitAmountColumns(["Date", "Credit Card No.", "Description", "Debit"])).toBeNull();
    expect(detectSplitAmountColumns(["Date", "Debit Card Number", "Credit Limit", "Amount"])).toBeNull();
    expect(detectSplitAmountColumns(["Date", "Credit Card No.", "Debit", "Credit"])).toEqual({ debitCol: 2, creditCol: 3 });
    expect(detectSplitAmountColumns(["Date", "Amount Debit", "Amount Credit"])).toEqual({ debitCol: 1, creditCol: 2 });
    expect(detectSplitAmountColumns(["Date", "Debits ($)", "Credits ($)"])).toEqual({ debitCol: 1, creditCol: 2 });
  });
});

describe("countAmountsOnlyIn", () => {
  const rows = [
    ["2026-10-02", "Synthetic Grocer", "120.00", ""],
    ["2026-10-10", "PAYMENT THANK YOU", "", "150.00"],
    ["2026-10-11", "Synthetic refund", "0.00", "5.00"],
  ];

  it("counts rows only the unmapped column would supply", () => {
    expect(countAmountsOnlyIn(rows, 2, 3)).toBe(2);
    expect(countAmountsOnlyIn(rows, 3, 2)).toBe(1);
  });

  it("is zero for a purchase-only statement with an empty Credit column", () => {
    expect(countAmountsOnlyIn(rows.slice(0, 1), 2, 3)).toBe(0);
  });
});

// Copied from dev PR #92 (fedbf94): credits beside zero-filled debits.
describe("parseSplitAmount", () => {
  it("uses a nonzero credit when the debit is zero", () => {
    expect(parseSplitAmount("0.00", "123.45")).toBe(123.45);
  });

  it("uses a nonzero credit when the debit is blank", () => {
    expect(parseSplitAmount("", "123.45")).toBe(123.45);
  });

  it("returns a nonzero debit as negative when the credit is zero or blank", () => {
    expect(parseSplitAmount("123.45", "0.00")).toBe(-123.45);
    expect(parseSplitAmount("123.45", "")).toBe(-123.45);
  });

  it("preserves debit precedence when both amounts are nonzero", () => {
    expect(parseSplitAmount("123.45", "67.89")).toBe(-123.45);
  });

  it("returns zero when neither amount parses nonzero", () => {
    expect(parseSplitAmount("0.00", "0.00")).toBe(0);
    expect(parseSplitAmount("", "")).toBe(0);
    expect(parseSplitAmount("n/a", "-")).toBe(0);
  });

  it("uses a nonzero credit when the debit is unparseable", () => {
    expect(parseSplitAmount("n/a", "123.45")).toBe(123.45);
  });
});

describe("countOmittedSplitRows", () => {
  const single = { amountCol: 2, typeCol: -1, debitCol: -1, creditCol: -1 };
  const card = [
    ["2026-10-02", "Synthetic Grocer", "120.00", "0.00"],
    ["2026-10-10", "PAYMENT THANK YOU", "", "150.00"],
    ["2026-10-12", "Synthetic refund", "0.00", "5.00"],
  ];

  it("counts blank- and zero-filled rows the unmapped partner column would supply", () => {
    expect(countOmittedSplitRows(["Date", "Description", "Debit", "Credit"], card, single)).toEqual({ partnerCol: 3, count: 2 });
  });

  it("is zero once both columns are mapped, or when a type column signs the amount", () => {
    const headers = ["Date", "Description", "Debit", "Credit"];
    expect(countOmittedSplitRows(headers, card, { ...single, debitCol: 2, creditCol: 3 }).count).toBe(0);
    expect(countOmittedSplitRows(headers, card, { ...single, typeCol: 3 }).count).toBe(0);
  });

  it("is zero for single signed-amount and purchase-only statements", () => {
    const signed = [["2026-10-02", "Synthetic Grocer", "-120.00"], ["2026-10-10", "PAYMENT THANK YOU", "150.00"]];
    expect(countOmittedSplitRows(["Date", "Description", "Amount"], signed, single)).toEqual({ partnerCol: -1, count: 0 });
    expect(countOmittedSplitRows(["Date", "Description", "Debit", "Credit"], [card[0]], single).count).toBe(0);
  });
});
