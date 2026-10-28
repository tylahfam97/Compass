import { describe, it, expect } from "vitest";
import { parseStatementItems, type PdfTextItem } from "./pdfParse";

// Synthetic statement layouts built from positioned text items (what pdf.js hands the parser).
// Names, dates and amounts are invented; only the layout traits mirror real statements.
type Item = PdfTextItem & { upright?: boolean };
const t = (x: number, y: number, str: string, extra: Partial<Item> = {}): Item =>
  ({ x, y, width: str.length * 4.4, height: 8, str, ...extra });
const today = new Date(2026, 9, 27);

describe("parseStatementItems: card statement layout", () => {
  // Trans. date + Post date columns, a two-line header, amounts sitting ~1pt below the
  // description baseline, signs printed as separate "-" items, a wrapped merchant name, a rotated
  // margin code on the same line as a row, and a summary block that must not become rows.
  const page1: Item[] = [
    t(34, 700, "Billing Period: 12/06/25-01/05/26"),
    t(317, 660, "Previous balance"), t(553, 660, "$1,000.00"),
    t(317, 646, "Payments"), t(549, 646, "-"), t(553, 646, "$500.00"),
    t(317, 632, "Purchases"), t(548, 632, "+$145.20"),
    t(317, 618, "New balance"), t(553, 618, "$645.20"),
    t(34, 600, "Minimum payment due: $41.00"),
    t(37, 560, "Trans."), t(100, 560, "Post"),
    t(37, 550, "date"), t(100, 550, "date"), t(163, 550, "Description"), t(548, 550, "Amount"),
    t(37, 530, "12/28"), t(100, 530, "12/29"), t(163, 530, "SAMPLE GROCERY MARKET"), t(551, 528.9, "$120.00"),
    t(9, 530, "000123", { upright: false }),
    t(37, 516, "12/30"), t(100, 516, "12/30"), t(163, 516, "ONLINE PAYMENT THANK YOU"), t(549, 514.8, "-"), t(553, 514.8, "$500.00"),
    t(37, 502, "01/02"), t(100, 502, "01/03"), t(163, 502, "EXAMPLE COFFEE ROASTERS"), t(551, 500.7, "$25.20"),
    t(163, 494, "PORTLAND OR"),
    t(37, 470, "Fees Charged"),
    t(41, 450, "Total fees charged in this billing period"), t(551, 449, "$0.00"),
  ];

  it("reads every row with its date, wrapped name and printed sign", () => {
    const r = parseStatementItems([page1], today);
    expect(r.headers).toEqual(["Date", "Description", "Amount"]);
    expect(r.rows).toEqual([
      ["2025-12-28", "SAMPLE GROCERY MARKET", "120.00"],
      ["2025-12-30", "ONLINE PAYMENT THANK YOU", "-500.00"],
      ["2026-01-02", "EXAMPLE COFFEE ROASTERS PORTLAND OR", "25.20"],
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.amountsIncreaseBalance).toBe(true); // 120 - 500 + 25.20 = 645.20 - 1,000.00
    expect(r.looksLikeLoanStatement).toBe(false);
    expect(r.noActivity).toBe(false);
  });

  it("warns instead of importing a partial statement silently", () => {
    const missingRow = page1.filter((i) => i.y !== 502 && i.y !== 500.7 && i.y !== 494);
    const r = parseStatementItems([missingRow], today);
    expect(r.rows).toHaveLength(2);
    expect(r.warnings.join(" ")).toMatch(/2 rows found add up to \$380\.00, but the statement's balance changed by \$354\.80/);
  });

  it("reports a cycle with no activity instead of guessing it is a loan statement", () => {
    const quiet = [
      t(34, 700, "Billing Period: 08/05/26-09/03/26"),
      t(317, 660, "Previous balance"), t(553, 660, "$0.00"),
      t(317, 646, "Payments"), t(549, 646, "-"), t(553, 646, "$0.00"),
      t(317, 632, "Purchases"), t(548, 632, "+$0.00"),
      t(317, 618, "New balance"), t(553, 618, "$0.00"),
      t(34, 600, "Minimum payment due: $0.00"),
      t(37, 550, "date"), t(100, 550, "date"), t(163, 550, "Description"), t(548, 550, "Amount"),
    ];
    const r = parseStatementItems([quiet], today);
    expect(r).toMatchObject({ rows: [], noActivity: true, looksLikeLoanStatement: false, hasText: true });
  });
});

describe("parseStatementItems: other layouts", () => {
  it("maps reordered Deposits/Withdrawals/Balance columns by position across pages", () => {
    const header = (y: number) => [t(40, y, "Date"), t(110, y, "Description"), t(330, y, "Deposits"), t(420, y, "Withdrawals"), t(520, y, "Balance")];
    const pages: Item[][] = [
      [
        t(40, 760, "Statement period Jul 1, 2026 through Jul 31, 2026"),
        t(40, 740, "Beginning balance"), t(520, 740, "2,000.00"),
        ...header(700),
        t(40, 680, "Jul 3, 2026"), t(110, 680, "PAYROLL EXAMPLE CO"), t(330, 680, "1,500.00"), t(520, 680, "3,500.00"),
        t(40, 666, "Jul 9, 2026"), t(110, 666, "RENT SAMPLE PROPERTY"), t(420, 666, "1,150.00"), t(520, 666, "2,350.00"),
        t(260, 40, "Page 1 of 2"),
      ],
      [
        ...header(720),
        t(40, 700, "Jul 20, 2026"), t(110, 700, "CHECK 1001"), t(420, 700, "45.10"), t(520, 700, "2,304.90"),
        t(40, 660, "Ending balance"), t(520, 660, "2,304.90"),
      ],
    ];
    const r = parseStatementItems(pages, today);
    expect(r.headers).toEqual(["Date", "Description", "Debit", "Credit", "Balance"]);
    expect(r.rows).toEqual([
      ["2026-07-03", "PAYROLL EXAMPLE CO", "", "1500.00", "3500.00"],
      ["2026-07-09", "RENT SAMPLE PROPERTY", "1150.00", "", "2350.00"],
      ["2026-07-20", "CHECK 1001", "45.10", "", "2304.90"],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("reads CR amounts as the opposite of plain ones and flags an unreadable amount", () => {
    const r = parseStatementItems([[
      t(40, 760, "Closing Date 03/14/2026"),
      t(40, 700, "Posting Date"), t(120, 700, "Transaction Description"), t(500, 700, "Amount"),
      t(40, 680, "03/02"), t(120, 680, "SAMPLE HARDWARE"), t(500, 680, "64.00"),
      t(40, 666, "03/05"), t(120, 666, "SAMPLE HARDWARE RETURN"), t(500, 666, "14.00 CR"),
      t(40, 652, "03/09"), t(120, 652, "SAMPLE BOOKS"), t(500, 652, "1O.00"),
    ]], today);
    expect(r.rows).toEqual([["2026-03-02", "SAMPLE HARDWARE", "64.00"], ["2026-03-05", "SAMPLE HARDWARE RETURN", "-14.00"]]);
    expect(r.warnings).toEqual([expect.stringMatching(/^1 dated line .* no readable amount/)]);
    expect(r.mostlyPositive).toBe(false); // 1 of 2
  });

  it("guesses years from today when no statement period is printed, and says so", () => {
    const r = parseStatementItems([[t(40, 700, "Date"), t(120, 700, "Description"), t(500, 700, "Amount"),
      t(40, 680, "10/02"), t(120, 680, "SAMPLE TRANSIT"), t(500, 680, "-3.75")]], today);
    expect(r.rows).toEqual([["2026-10-02", "SAMPLE TRANSIT", "-3.75"]]);
    expect(r.warnings).toEqual([expect.stringMatching(/period wasn't found/)]);
  });

  it("keeps the loan hint for loan statements and reports scanned PDFs", () => {
    expect(parseStatementItems([[t(40, 700, "Personal Loan"), t(40, 680, "Loan balance $9,000.00"), t(40, 660, "Payment due $300.00")]]).looksLikeLoanStatement).toBe(true);
    expect(parseStatementItems([[], []])).toMatchObject({ hasText: false, rows: [] });
  });
});
