import { describe, it, expect } from "vitest";
import { transactionsCsv } from "./transactionView";

const HEADER = "Date,Description,Category,Amount,Balance,Notes";

const row = (over: Partial<Parameters<typeof transactionsCsv>[0][number]> = {}) => ({
  date: "2026-11-02",
  description: "GROCERY MARKET",
  category_name: "Groceries",
  amount_cents: -4_210,
  balance_cents: 125_000,
  notes: "",
  ...over,
});

describe("transactionsCsv", () => {
  it("writes only the header when there are no rows", () => {
    expect(transactionsCsv([])).toBe(HEADER);
  });

  it("keeps the existing columns, number formatting and quoting for ordinary text", () => {
    const csv = transactionsCsv([
      row(),
      row({ date: "2026-11-01", description: 'Say "hi", then\nleave', category_name: null, amount_cents: 250_000, balance_cents: null, notes: "a=b" }),
      row({ description: null, notes: null }),
    ]);
    expect(csv).toBe([
      HEADER,
      '2026-11-02,"GROCERY MARKET","Groceries",-42.10,1250.00,""',
      '2026-11-01,"Say ""hi"", then\nleave","Uncategorized",2500.00,,"a=b"',
      '2026-11-02,"","Groceries",-42.10,1250.00,""',
    ].join("\n"));
  });

  it("leaves negative Amount and Balance numeric", () => {
    expect(transactionsCsv([row({ amount_cents: -5, balance_cents: -12_345 })]).split("\n")[1])
      .toBe('2026-11-02,"GROCERY MARKET","Groceries",-0.05,-123.45,""');
  });

  it.each(["=1+1", "+ADJUSTMENT", "-SQ COFFEE", "@handle", "\tTAB LED", "\rCR LED"])(
    "puts an apostrophe before free text that starts like a formula: %j",
    (text) => {
      expect(transactionsCsv([row({ description: text, category_name: text, notes: text })]).split("\n")[1]).toBe(`2026-11-02,"'${text}","'${text}",-42.10,1250.00,"'${text}"`);
    },
  );

  it("still doubles quotes in prefixed text", () => {
    expect(transactionsCsv([row({ description: '=1+1 "x"' })]).split("\n")[1])
      .toBe('2026-11-02,"\'=1+1 ""x""","Groceries",-42.10,1250.00,""');
  });
});
