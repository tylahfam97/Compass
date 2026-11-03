import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { workbookSheetRows, parseVanguardExport, sourceRoutingProblem, defaultSourceAccountName } from "./investmentParsing";
import {
  detectInvestmentFormat, parseInvestmentWorkbook, parseEtradeStatement,
  classifyEtradeActivity, inferSecurityType, buildHoldingHeaderMap,
} from "./investmentParsing";

// Header rows copied verbatim from real exports - the detection rules key off these exact
// names, and Fidelity's and Thrivent's are close enough to be mistaken for one another.
const FIDELITY_HEADER = [
  "Account number", "Account name", "Symbol", "Description", "Quantity", "Last price",
  "Last price change", "Current value", "Today's gain/loss dollar", "Today's gain/loss percent",
  "Total gain/loss dollar", "Total gain/loss percent", "Percent of account", "Cost basis total",
  "Average cost basis", "Type",
];
const fidelityRow = (account: string, symbol: string, desc: string, qty: string, price: string, value: string, cost: string, type = "") =>
  ["", account, symbol, desc, qty, price, "$0.00", value, "$0.00", "0.00%", "$0.00", "0.00%", "0.00%", cost, "$0.00", type];

const THRIVENT_HEADER = [
  "Indicators", "Security ID", "Account Number", "Security Description", "Closing Quantity",
  "Recent Quantity", "Recent Price", "Currency Code", "Foreign Recent Price", "Currency Code",
  "Recent Market Value", "Currency Code", "Foreign Recent Market Value", "Currency Code",
  "Account Type", "Cost", "Currency Code", "Foreign Cost", "Currency Code", "Gain/Loss",
  "Currency Code", "Foreign Gain/Loss", "Currency Code", "Change since last close (%)",
  "Foreign Change since last close (%)", "Currency", "Shares With No Redemption Fees",
  "Security Type", "Shares With Redemption Fees", "Symbol",
];
const thriventRow = (id: string, desc: string, qty: string, price: string, value: string, acctType: string, cost: string, secType: string, symbol: string) =>
  ["", id, "", desc, qty, qty, price, "USD", "", "", value, "USD", "", "", acctType, cost, "USD", "", "", "", "USD", "", "", "0.00%", "", "USD", "0", secType, "0", symbol];

describe("detectInvestmentFormat", () => {
  it("tells Fidelity and Thrivent apart", () => {
    // Regression guard: the two parsers were once named after each other's format. Fidelity's
    // export has "Account name"/"Cost basis total"; Thrivent's has "Security Description"/
    // "Security Type" - swapping them silently routes each file through the wrong column map.
    expect(detectInvestmentFormat([FIDELITY_HEADER])).toBe("fidelity");
    expect(detectInvestmentFormat([THRIVENT_HEADER])).toBe("thrivent");
  });

  it("detects a Principal statement from anywhere in the file", () => {
    const data = [["cover page"], ["more filler"], ["and more"], ["Asset Class", "Balance as of 01/01/2026"]];
    expect(detectInvestmentFormat(data)).toBe("principal");
  });

  it("detects an E*TRADE client statement from anywhere in the file", () => {
    const data = [["filler"], ["filler"], ["filler"], ["CLIENT STATEMENT", "For the Period July 1-31, 2026"]];
    expect(detectInvestmentFormat(data)).toBe("etrade");
  });

  it("falls back to the generic sectioned parser", () => {
    expect(detectInvestmentFormat([["Description", "Market Value"]])).toBe("wells-fargo");
  });
});

describe("parseFidelityPositionsCSV", () => {
  const data = [
    FIDELITY_HEADER,
    fidelityRow("MY 401(K)", "FXAIX", "FID 500 INDEX", "124.671", "$263.18 ", '"$32,810.91 "', '"$26,435.41 "'),
    fidelityRow("MY 401(K)", "AAPL", "APPLE INC", "10", "$100.00 ", "$1,000.00 ", "$800.00 "),
    fidelityRow("BROKERAGE", "SPY", "SPDR S&P 500 ETF", "5", "$500.00 ", "$2,500.00 ", "$2,000.00 "),
    [],
    ["Date downloaded Jul-16-2026 2:16 p.m ET"],
  ];

  it("uses the file's own download date rather than today", () => {
    expect(parseInvestmentWorkbook(data)!.asOfDate).toBe("2026-07-16");
  });

  it("groups by account name", () => {
    expect(parseInvestmentWorkbook(data)!.sections.map((s) => s.title)).toEqual(["MY 401(K)", "BROKERAGE"]);
  });

  it("infers a security type when the Type column is blank", () => {
    // Fidelity leaves Type empty on retirement-plan exports; without inference every holding
    // would land in the Investments page's "Other" bucket.
    const rows = parseInvestmentWorkbook(data)!.sections[0].rows;
    expect(rows.find((r) => r.symbol === "FXAIX")!.securityType).toBe("mutual_fund");
    expect(rows.find((r) => r.symbol === "AAPL")!.securityType).toBe("stock");
    expect(parseInvestmentWorkbook(data)!.sections[1].rows[0].securityType).toBe("etf");
  });

  it("maps values onto the right fields", () => {
    const row = parseInvestmentWorkbook(data)!.sections[0].rows[0];
    expect(row).toMatchObject({ description: "FID 500 INDEX", shares: 124.671, price: 263.18 });
  });
});

describe("parseThriventPositionsCSV", () => {
  const data = [
    THRIVENT_HEADER,
    thriventRow("FDRXX", "FIDELITY GOVERNMENT CASH RESERVES", '"3,075.69"', "$1.00 ", '"$3,075.69 "', "Cash", "", "Mutual Fund", "FDRXX"),
    thriventRow("AAPL", "APPLE INC", "11", "$332.02 ", '"$3,652.22 "', "Cash", '"$2,146.28 "', "Common Stock/ETF", "AAPL"),
    thriventRow("DYNF", "ISHARES U.S. EQUITY FACTOR ROTATION ACTIVE ETF", "133", "$67.48 ", '"$8,974.84 "', "Cash", '"$6,666.62 "', "Common Stock/ETF", "DYNF"),
    thriventRow("31617E588", "FID DIV INTL PL CL O", "46.738", "$27.39 ", '"$1,280.15 "', "Cash", "$877.68 ", "Mutual Fund", ""),
  ];

  it("splits the combined Common Stock/ETF bucket per holding", () => {
    // The section title names both, so classifying the whole section would file every
    // individual stock under ETFs.
    const section = parseInvestmentWorkbook(data)!.sections.find((s) => s.title === "Stocks & ETFs")!;
    expect(section.rows.find((r) => r.symbol === "AAPL")!.securityType).toBe("stock");
    expect(section.rows.find((r) => r.symbol === "DYNF")!.securityType).toBe("etf");
  });

  it("files a cash sweep fund as cash", () => {
    const section = parseInvestmentWorkbook(data)!.sections.find((s) => s.title === "Mutual Fund")!;
    expect(section.rows.find((r) => r.symbol === "FDRXX")!.securityType).toBe("cash");
  });

  it("falls back to the CUSIP when a holding has no ticker", () => {
    const section = parseInvestmentWorkbook(data)!.sections.find((s) => s.title === "Mutual Fund")!;
    expect(section.rows.find((r) => r.description === "FID DIV INTL PL CL O")!.symbol).toBe("31617E588");
  });
});

describe("wells fargo sectioned parser", () => {
  const data = [
    ["Priced as of  Close on 07/15/2026"],
    [],
    ["Stocks"],
    ["Description", "Symbol", "Cost Basis", "Est. Annual Income", "Market Value", "Shares", "Trade Date1"],
    ["Common Stock"],
    ["NVIDIA CORP", "NVDA", "$1,000.00", "$5.00", "$1,500.00", "10", "01/15/2025"],
    ["Total Stocks", "", "", "", "$1,500.00"],
  ];

  it("reads the priced-as-of date and skips asset-class sub-headings", () => {
    const parsed = parseInvestmentWorkbook(data)!;
    expect(parsed.asOfDate).toBe("2026-07-15");
    expect(parsed.sections[0].rows).toHaveLength(1);
    expect(parsed.sections[0].rows[0]).toMatchObject({
      symbol: "NVDA", shares: 10, marketValue: 1500, costBasis: 1000,
      estAnnualIncome: 5, tradeDate: "2025-01-15", securityType: "stock",
    });
  });
});

// ─── E*TRADE / Morgan Stanley client statement ─────────────────────────────────

/** The shape `extractPdfRows` produces for a real statement, trimmed to the rows that matter.
 *  Note the interleaved chart axis labels ("1.8", "-12.5%") between Account Summary rows and
 *  the values that wrap onto the line after their own label - both are real artifacts. */
const ETRADE_STATEMENT: string[][] = [
  ["CLIENT STATEMENT", "For the Period July 1-31, 2026"],
  ["TYLER FAMELI"],
  ["Morgan Stanley at Work Self-Directed Account"],
  ["377-170339-209"],
  ["Account Summary"],
  ["TOTAL BEGINNING VALUE", "$1,667.14", "$1,699.36"],
  ["-12.5%"],
  ["1.8", "-4.1%"],
  ["Credits", "—", "—"],
  ["Debits", "(1,667.00)", "(3,354.33)"],
  ["Security Transfers", "1,247.14", "2,946.58"],
  ["Thousands"],
  ["1.2"],
  ["Net Credits/Debits/Transfers"],
  ["$(419.86)", "$(407.75)"],
  ["0.9"],
  ["Change in Value"],
  ["(54.61)", "(98.94)"],
  ["TOTAL ENDING VALUE", "$1,192.67", "$1,192.67", "JUL AUG SEP", "OCT NOV DEC JAN"],
  ["CLOSING CASH, BDP, MMFs", "$0.14", "$0.14"],
  ["Income And Distributions", "—", "—"],
  ["Short-Term Gain", "—", "$1,732.60", "$310.58"],
  ["TOTAL INCOME AND DISTRIBUTIONS", "—", "—"],
  ["HOLDINGS"],
  ["This section reflects positions purchased/sold on a trade date basis and other long prose that must never be read as a holding row."],
  ["CASH, BANK DEPOSIT PROGRAM AND MONEY MARKET FUNDS"],
  ["7-Day"],
  ["APY %"],
  ["Description", "Current Yield %", "Est Ann Income"],
  ["Market Value"],
  ["MORGAN STANLEY PRIVATE BANK NA", "$0.14", "—", "—", "0.010"],
  ["Percentage"],
  ["of Holdings", "Market Value", "Est Ann Income"],
  ["0.01%", "$0.14", "—"],
  ["CASH, BDP, AND MMFs"],
  ["STOCKS"],
  ["COMMON STOCKS"],
  ["Unrealized", "Current"],
  ["Security Description", "Quantity", "Share Price", "Total Cost", "Market Value", "Gain/(Loss)", "Est Ann Income", "Yield %"],
  ["AVEANNA HEALTHCARE HLDGS INC (AVAH)", "127.000", "$9.390", "$881.95", "$1,192.53", "$310.58", "—", "—"],
  ["127.000 shs from Stock Plan; Asset Class: Equities"],
  ["Page 6 of 8"],
  ["CLIENT STATEMENT", "For the Period July 1-31, 2026"],
  ["377-170339-209"],
  ["Percentage", "Unrealized", "Current"],
  ["of Holdings", "Total Cost", "Market Value", "Gain/(Loss)", "Est Ann Income", "Yield %"],
  ["99.99%", "$881.95", "$1,192.53", "$310.58", "—", "—"],
  ["STOCKS"],
  ["100.00%", "$881.95", "$1,192.67", "$310.58", "—", "—"],
  ["TOTAL VALUE"],
  ["ACTIVITY"],
  ["CASH FLOW ACTIVITY BY DATE"],
  ["Activity", "Settlement"],
  ["Date", "Date", "Activity Type", "Description", "Comments", "Quantity", "Price", "Credits/(Debits)"],
  ["6/30", "7/1", "Sold", "AVEANNA HEALTHCARE HLDGS INC", "ACTED AS AGENT", "194.000", "$8.6450", "$1,667.14"],
  ["7/1", "Online Transfer", "ACH WITHDRAWL", "REFID:25954444395;", "$(1,667.00)"],
  ["NET CREDITS/(DEBITS)", "$(1,667.00)"],
  ["MONEY MARKET FUND (MMF) AND BANK DEPOSIT PROGRAM ACTIVITY"],
  ["Activity"],
  ["Date", "Activity Type", "Description", "Credits/(Debits)"],
  ["7/1", "Automatic Investment", "BANK DEPOSIT PROGRAM", "$1,667.14"],
  ["NET ACTIVITY FOR PERIOD", "$0.14"],
  ["UNSETTLED PURCHASES/SALES ACTIVITY"],
  ["Date", "Date", "Activity Type", "Description", "Comments", "Quantity", "Price", "Pending"],
  ["6/30", "7/1", "Sold", "AVEANNA HEALTHCARE HLDGS INC", "UNSETTLED SALE", "194.000", "$8.6450", "$1,667.14"],
  ["NET UNSETTLED PURCHASES/SALES", "$1,667.14"],
  ["TRANSFERS, CORPORATE ACTIONS AND ADDITIONAL ACTIVITY"],
  ["SECURITY TRANSFERS"],
  ["Activity"],
  ["Date", "Activity Type", "Security (Symbol)", "Comments", "Quantity", "Accrued Interest", "Amount"],
  ["7/9", "Transfer into Account", "AVEANNA HEALTHCARE HLDGS INC", "127.000", "$1,247.14"],
  ["MESSAGES"],
];

describe("parseEtradeStatement", () => {
  const parsed = parseEtradeStatement(ETRADE_STATEMENT)!;

  it("reads the statement period rather than defaulting to today", () => {
    expect(parsed.asOfDate).toBe("2026-07-31");
    expect(parsed.summary!.periodStart).toBe("2026-07-01");
    expect(parsed.summary!.periodEnd).toBe("2026-07-31");
  });

  it("expands a quarter-spanning period label", () => {
    const q = parseEtradeStatement([
      ["CLIENT STATEMENT", "For the Period April 1- June 30, 2026"],
      ["HOLDINGS"], ["STOCKS"],
      ["Security Description", "Quantity", "Market Value"],
      ["ACME CORP (ACME)", "1.000", "$1.00"],
    ])!;
    expect(q.summary!.periodStart).toBe("2026-04-01");
    expect(q.summary!.periodEnd).toBe("2026-06-30");
  });

  it("backs the start year off for a period spanning New Year", () => {
    const ny = parseEtradeStatement([
      ["CLIENT STATEMENT", "For the Period December 1- January 31, 2027"],
      ["HOLDINGS"], ["STOCKS"],
      ["Security Description", "Quantity", "Market Value"],
      ["ACME CORP (ACME)", "1.000", "$1.00"],
    ])!;
    expect(ny.summary!.periodStart).toBe("2026-12-01");
    expect(ny.summary!.periodEnd).toBe("2027-01-31");
  });

  it("reads the account name and number", () => {
    expect(parsed.accountLabel).toBe("Morgan Stanley at Work Self-Directed Account");
    expect(parsed.accountNumber).toBe("377-170339-209");
  });

  it("extracts holdings whose market values sum to the statement's own total", () => {
    const total = parsed.sections.reduce((s, sec) => s + sec.totalMarketValue, 0);
    expect(total).toBeCloseTo(1192.67, 2); // the statement's printed TOTAL VALUE
  });

  it("pulls the ticker out of the security description", () => {
    const stock = parsed.sections.find((s) => s.title === "Stocks")!.rows[0];
    expect(stock).toMatchObject({
      symbol: "AVAH", description: "AVEANNA HEALTHCARE HLDGS INC",
      shares: 127, price: 9.39, costBasis: 881.95, marketValue: 1192.53,
      securityType: "stock",
    });
  });

  it("reads the cash table even though its header wraps across four lines", () => {
    const cash = parsed.sections.find((s) => s.securityType === "cash")!;
    expect(cash.rows).toEqual([expect.objectContaining({ description: "MORGAN STANLEY PRIVATE BANK NA", marketValue: 0.14 })]);
  });

  it("ignores subtotal, page-header and detail rows", () => {
    // "99.99% | $881.95 | ..." and the repeated page header both sit inside the holdings
    // region; a naive "row with money in it" rule would import them as holdings.
    expect(parsed.sections.flatMap((s) => s.rows)).toHaveLength(2);
  });

  it("reads the Account Summary, including values that wrap onto the next line", () => {
    expect(parsed.summary).toMatchObject({
      beginningValue: 1667.14,
      endingValue: 1192.67,
      changeInValue: -54.61,   // wrapped onto the line after its label
      cashBalance: 0.14,
      withdrawals: -1667,
      transfers: 1247.14,
      realizedGain: 0,
      realizedGainYtd: 1732.6,
      unrealizedGain: 310.58,
    });
  });

  it("is not fooled by the chart axis labels interleaved between summary rows", () => {
    // "1.8" and "-4.1%" sit between TOTAL BEGINNING VALUE and Credits; a looser money test
    // would read them as the wrapped values for the preceding label.
    expect(parsed.summary!.beginningValue).toBe(1667.14);
    expect(parsed.summary!.deposits).toBe(0);
  });

  it("extracts every activity table", () => {
    expect(parsed.activity.map((a) => [a.date, a.activityType, a.amount])).toEqual([
      ["2026-06-30", "sell", 1667.14],
      ["2026-07-01", "withdrawal", -1667],
      ["2026-07-01", "transfer", 1667.14],
      ["2026-07-09", "transfer", 1247.14],
    ]);
  });

  it("skips the unsettled activity table so trades aren't double-counted", () => {
    // The 6/30 sale is printed in BOTH "Cash Flow Activity by Date" and "Unsettled
    // Purchases/Sales Activity" - importing both would book the trade twice.
    expect(parsed.activity.filter((a) => a.activityType === "sell")).toHaveLength(1);
  });

  it("resolves year-less activity dates against the statement period", () => {
    const sale = parsed.activity[0];
    expect(sale.date).toBe("2026-06-30");
    expect(sale.settleDate).toBe("2026-07-01");
    expect(sale.quantity).toBe(194);
    expect(sale.price).toBe(8.645);
  });

  it("handles rows with no settlement date, quantity or price", () => {
    expect(parsed.activity[1]).toMatchObject({
      settleDate: null, quantity: null, price: null,
      description: "ACH WITHDRAWL — REFID:25954444395;",
    });
  });
});

describe("classifyEtradeActivity", () => {
  it("routes a cash transfer by its sign", () => {
    expect(classifyEtradeActivity("Online Transfer", "ACH WITHDRAWL", -100)).toBe("withdrawal");
    expect(classifyEtradeActivity("Online Transfer", "ACH DEPOSIT", 100)).toBe("deposit");
  });

  it("maps trade and income wording", () => {
    expect(classifyEtradeActivity("Sold", "", 1)).toBe("sell");
    expect(classifyEtradeActivity("Bought", "", -1)).toBe("buy");
    expect(classifyEtradeActivity("Dividend", "QUALIFIED DIVIDEND", 1)).toBe("dividend");
    expect(classifyEtradeActivity("Interest", "CREDIT INTEREST", 1)).toBe("interest");
    expect(classifyEtradeActivity("Transfer into Account", "", 1)).toBe("transfer");
  });
});

describe("inferSecurityType", () => {
  it("uses ticker and description conventions", () => {
    expect(inferSecurityType("FXAIX", "FID 500 INDEX")).toBe("mutual_fund");
    expect(inferSecurityType("31617E588", "FID DIV INTL PL CL O")).toBe("mutual_fund");
    expect(inferSecurityType("SPY", "SPDR S&P 500 ETF")).toBe("etf");
    expect(inferSecurityType("AAPL", "APPLE INC")).toBe("stock");
    expect(inferSecurityType("FDRXX", "FIDELITY GOVERNMENT CASH RESERVES")).toBe("cash");
  });
});

describe("buildHoldingHeaderMap", () => {
  it("matches header aliases exactly, so a longer name is never shadowed", () => {
    // "Share Price" must map to price, not be missed because a bare "price" alias exists.
    expect(buildHoldingHeaderMap(["Security Description", "Quantity", "Share Price", "Total Cost"]))
      .toEqual({ description: 0, shares: 1, price: 2, costBasis: 3 });
  });

  it("treats an em-dash cell as empty rather than zero", () => {
    const parsed = parseInvestmentWorkbook([
      ["Stocks"],
      ["Description", "Symbol", "Market Value", "Est. Annual Income"],
      ["ACME CORP", "ACME", "$100.00", "—"],
      ["Total Stocks"],
    ])!;
    expect(parsed.sections[0].rows[0].estAnnualIncome).toBeNull();
  });
});

describe("parseLedgerLiveCSV", () => {
  // Synthetic Ledger Live export (invented hashes, accounts and values). Ledger documents that an
  // OUT amount already includes its network fee and an IN amount excludes the sender's fee.
  const header = ["Operation Date", "Status", "Currency Ticker", "Operation Type", "Operation Amount", "Operation Fees", "Operation Hash", "Account Name", "Account xpub", "Countervalue Ticker", "Countervalue at Operation Date", "Countervalue at CSV Export"];
  const op = (date: string, status: string, type: string, amount: string, fee: string, hash: string, cvOp: string, cvNow: string, ticker = "XRP") =>
    [date, status, ticker, type, amount, fee, hash, "Sample Wallet", "xpub-sample", "USD", cvOp, cvNow];
  const data = [
    header,
    op("2026-09-20T15:00:00.000Z", "Confirmed", "OUT", "25.000014", "0.000014", "H3", "50.00", "62.50"),
    op("2026-09-10T15:00:00.000Z", "Confirmed", "IN", "0.000003", "0.00003", "H2", "0.00", "0.00"),
    op("2026-09-01T15:00:00.000Z", "Confirmed", "IN", "100.123456", "0.000017", "H1", "200.25", "250.31"),
    op("2026-09-21T15:00:00.000Z", "Failed", "OUT", "5", "0.00004", "H4", "10.00", "12.50"),
    op("2026-09-22T15:00:00.000Z", "Confirmed", "NONE", "1", "0", "H5", "2.00", "2.50"),
    op("not a date", "Confirmed", "IN", "1", "0", "H6", "2.00", "2.50"),
  ];

  it("is detected and keeps exact units: receipts minus sends, fees not subtracted twice", () => {
    expect(detectInvestmentFormat(data)).toBe("ledger");
    const r = parseInvestmentWorkbook(data)!;
    const [h] = r.sections[0].rows;
    expect(h).toMatchObject({ securityType: "crypto", symbol: "XRP", shares: 75.123405, costBasis: null });
    expect(h.price).toBeCloseTo(2.5, 4); // export countervalues are rounded to cents
    expect(h.marketValue).toBeCloseTo(187.81, 2);
  });

  it("records operations as transfers with unique ids and reports what it left out", () => {
    const r = parseInvestmentWorkbook(data)!;
    expect(r.activity.map((a) => [a.activityType, a.quantity, a.amount])).toEqual([
      ["transfer", -25.000014, -50], ["transfer", 0.000003, 0], ["transfer", 100.123456, 200.25],
    ]);
    expect(new Set(r.activity.map((a) => a.importKey)).size).toBe(3);
    expect(r.summary).toBeNull();
    expect(r.notes!.join(" ")).toMatch(/Cost basis is unknown.*1 failed or unconfirmed operation was left out; the network fee of 1 failed send was still subtracted.*1 operation of an unsupported type.*1 unreadable row was skipped/);
  });

  it("debits a network fee only for an explicitly Failed send, never a pending or unknown one", () => {
    const r = parseInvestmentWorkbook([
      ...data,
      op("2026-09-23T15:00:00.000Z", "Pending", "OUT", "7", "0.5", "H7", "14.00", "17.50"),
      op("2026-09-24T15:00:00.000Z", "Mystery", "OUT", "8", "0.25", "H8", "16.00", "20.00"),
    ])!;
    expect(r.sections[0].rows[0].shares).toBe(75.123405); // same as without them: no fee assumed
    expect(r.activity).toHaveLength(3);
    expect(r.notes!.join(" ")).toMatch(/3 failed or unconfirmed operations were left out; the network fee of 1 failed send was still subtracted/);
  });
});

// ─── Vanguard holdings + activity download ─────────────────────────────────────
// Every account, security and amount below is invented. Workbooks go through the real xlsx
// library (write, then read back with the app's own options) rather than hand-built rows.

/** Builds a one-sheet .xlsx from rows (strings stay text cells, numbers become numeric cells)
 *  and reads it back exactly as the import page does. */
function viaXlsx(aoa: (string | number)[][]): string[][] {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const read = XLSX.read(buf, { type: "array", cellDates: false });
  return workbookSheetRows(read, read.SheetNames[0]);
}

const VG_HOLDINGS_HEADER = ["Account Number", "Investment Name", "Symbol", "Shares", "Share Price", "Total Value"];
const VG_ACTIVITY_HEADER = ["Account Number", "Trade Date", "Settlement Date", "Transaction Type", "Transaction Description",
  "Investment Name", "Symbol", "Shares", "Share Price", "Principal Amount", "Commissions and Fees", "Net Amount", "Accrued Interest", "Account Type"];
const act = (acct: string, trade: string | number, settle: string | number, type: string, desc: string, sym: string, net: string | number, extra: Partial<Record<"shares" | "price" | "principal" | "fees" | "accrued", string | number>> = {}) =>
  [acct, trade, settle, type, desc, sym ? `SYNTHETIC ${sym} FUND` : "", sym, extra.shares ?? "", extra.price ?? "", extra.principal ?? "", extra.fees ?? "", net, extra.accrued ?? 0, "CASH"];

const vgWorkbook = (): (string | number)[][] => [
  ["Synthetic brokerage download - invented data"],
  [],
  VG_HOLDINGS_HEADER,
  ["000123456789", "SYNTHETIC TOTAL MARKET FUND", "ZZTMX", "10", "100.00", "1,000.00"],
  ["000123456789", "SYNTHETIC BOND FUND", "ZZBDX", "5", "20", "110.00"],
  [],
  ["88880001", "SYNTHETIC TOTAL MARKET FUND", "ZZTMX", 2, 100, 200],
  ["88880001", "SYNTHETIC MONEY MARKET SETTLEMENT FUND", "ZZMMX", "", "", "50.25"],
  ["88880001", "", "", "", "", ""],
  [],
  ["space"],
  ["space"],
  VG_ACTIVITY_HEADER,
  act("000123456789", "01/15/2026", "01/15/2026", "Dividend", "Dividend Received", "ZZTMX", "12.34"),
  act("000123456789", "01/15/2026", "01/15/2026", "Reinvestment", "Dividend Reinvestment", "ZZTMX", "-12.34", { shares: "0.1234", price: "100" }),
  act("000123456789", 46037, 46038, "Sell", "Sell", "ZZBDX", "10.00", { shares: "-1", price: "12", principal: "12.00", fees: "2.00" }),
  act("000123456789", "2026-01-20", "2026-01-20", "Sweep out", "Sweep into settlement account", "ZZMMX", "-50.00"),
  act("88880001", "2026-01-20", "2026-01-20", "Sweep in", "Sweep into settlement account", "ZZMMX", "50.00"),
  act("88880001", "2026-01-21", "2026-01-22", "Withdrawal", "Withdrawal", "", "25.00"),
  act("88880001", "2026-01-22", "2026-01-22", "Distribution", "Non roth ira distribution", "", "-30.00"),
  act("88880001", "2026-01-23", "", "Corp Action (Cusip Change)", "Cusip change", "ZZTMX", ""),
  act("88880001", "2026-01-23", "", "Corp Action(Spinoff)", "Spinoff", "ZZTMX", "0"),
  act("88880001", "2026-01-24", "2026-01-24", "Margin Thing", "Unknown activity", "", "1.00"),
  act("88880001", "2026-01-25", "2026-01-25", "Dividend", "Dividend Received", "ZZTMX", "3.00"),
  act("88880001", "2026-01-25", "2026-01-25", "Dividend", "Dividend Received", "ZZTMX", "3.00"),
  act("88880001", "not a date", "", "Dividend", "Dividend Received", "ZZTMX", "1.00"),
  act("88880001", "2026-01-26", "", "Dividend", "positive or negative amounts", "ZZTMX", "positive or negative amounts"),
];

describe("Vanguard holdings + activity workbook", () => {
  it("is detected and parsed through the real xlsx reader (was unsupported before)", () => {
    const rows = viaXlsx(vgWorkbook());
    expect(detectInvestmentFormat(rows)).toBe("vanguard");
    const parsed = parseInvestmentWorkbook(rows);
    expect(parsed).not.toBeNull();
    expect(parsed!.sections.map((s) => s.rows.length)).toEqual([2, 2]);
  });

  it("matches the import page's own sheet reader", () => {
    const wb = XLSX.read(XLSX.write((() => { const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet(vgWorkbook()), "S"); return b; })(), { type: "array", bookType: "xlsx" }), { type: "array" });
    expect(workbookSheetRows(wb, "S")).toEqual(viaXlsx(vgWorkbook()));
  });

  it("groups holdings by account, keeps account numbers as text and values at Total Value", () => {
    const p = parseVanguardExport(viaXlsx(vgWorkbook()))!;
    expect(p.accountNumbers).toEqual(["000123456789", "88880001"]);
    expect(p.asOfDate).toBe("");
    expect(p.asOfDateUnknown).toBe(true);
    const [a, b] = p.sections;
    expect(a.accountNumber).toBe("000123456789");
    expect(a.rows.map((r) => [r.symbol, r.marketValue, r.costBasis])).toEqual([["ZZTMX", 1000, null], ["ZZBDX", 110, null]]);
    expect(a.totalMarketValue).toBe(1110);
    expect(b.rows.map((r) => [r.symbol, r.marketValue, r.securityType])).toEqual([["ZZTMX", 200, "mutual_fund"], ["ZZMMX", 50.25, "cash"]]);
    // Same symbol in two accounts stays two holdings, one per account.
    expect(p.sections.flatMap((s) => s.rows).filter((r) => r.symbol === "ZZTMX")).toHaveLength(2);
    const notes = p.notes!.join("\n");
    expect(notes).toContain("1 holdings row was left out");
    expect(notes).toContain("1 holding's Shares x Share Price differs from Total Value");
    expect(notes).toContain("1 row above the first table was ignored");
    expect(notes).toContain("no valuation date or currency");
  });

  it("keeps activity signed as in the file, both dates and every source cell, without guessing", () => {
    const p = parseVanguardExport(viaXlsx(vgWorkbook()))!;
    const byDesc = (d: string) => p.activity.filter((a) => a.description === d);
    expect(p.activity.map((a) => [a.activityType, a.amount, a.accountNumber])).toEqual([
      ["dividend", 12.34, "000123456789"],
      ["reinvest", -12.34, "000123456789"],
      ["sell", 10, "000123456789"],
      ["transfer", -50, "000123456789"],
      ["transfer", 50, "88880001"],
      ["withdrawal", 25, "88880001"],
      ["other", -30, "88880001"],
      ["other", 0, "88880001"],
      ["other", 0, "88880001"],
      ["other", 1, "88880001"],
      ["dividend", 3, "88880001"],
      ["dividend", 3, "88880001"],
    ]);
    const sell = byDesc("Sell")[0];
    // Excel serial dates, settlement kept apart from trade; fees preserved, never subtracted again.
    expect([sell.date, sell.settleDate, sell.realizedGain, sell.costBasis]).toEqual(["2026-01-15", "2026-01-16", null, null]);
    expect(sell.sourceFields).toMatchObject({ "Principal Amount": "12.00", "Commissions and Fees": "2.00", "Net Amount": "10.00", "Accrued Interest": "0", "Account Type": "CASH" });
    expect(byDesc("Cusip change")[0].sourceFields!["Net Amount"]).toBeUndefined();
    const notes = p.notes!.join("\n");
    expect(notes).toContain("2 activity rows were left out");
    expect(notes).toContain("1 activity row has a Net Amount sign that doesn't match");
    expect(notes).toContain("1 distribution was saved as Other");
    expect(notes).toContain("2 corporate actions (CUSIP change, spinoff...) were saved for reference as Other, with no cash, gain or cost basis applied (1 with no Net Amount");
    expect(notes).toContain("1 activity row has a transaction type Compass doesn't recognize");
    // Holdings are never marked cash just because the activity's Account Type says CASH.
    expect(p.sections[0].rows.every((r) => r.securityType !== "cash")).toBe(true);
  });

  it("gives identical legitimate rows distinct keys and a reformatted re-download the same keys", () => {
    const p = parseVanguardExport(viaXlsx(vgWorkbook()))!;
    const keys = p.activity.map((a) => a.importKey!);
    expect(new Set(keys).size).toBe(keys.length);
    const twins = p.activity.filter((a) => a.date === "2026-01-25").map((a) => a.importKey!);
    expect(twins[1]).toBe(`${twins[0]}#1`);
    // Reformatted: reordered columns, other date/money formatting and case - same rows.
    const order = [3, 0, 2, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const reformatted = vgWorkbook().map((row) => {
      if (row[0] === "Account Number" && row.length === 14) return order.map((i) => row[i]);
      if (row.length !== 14) return row;
      const r = [...row];
      r[3] = String(r[3]).toUpperCase();
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(r[1]))) { const [y, m, d] = String(r[1]).split("-"); r[1] = `${m}/${d}/${y}`; }
      if (/^-?\d+(\.\d+)?$/.test(String(r[11]))) r[11] = Number(r[11]);
      return order.map((i) => r[i]);
    });
    const again = parseVanguardExport(viaXlsx(reformatted))!;
    expect(again.activity.map((a) => a.importKey)).toEqual(keys);
    // An overlapping later download (a subset of the same rows) maps onto existing keys only.
    const overlap = vgWorkbook().filter((row, i) => i < 13 || String(row[1]) === "2026-01-25");
    const subset = parseVanguardExport(viaXlsx(overlap))!.activity.map((a) => a.importKey);
    expect(subset.every((k) => keys.includes(k!))).toBe(true);
    expect(subset).toHaveLength(2);
  });

  it("flags account numbers Excel stored as numbers and rounded, without inventing digits", () => {
    const rows = viaXlsx([VG_HOLDINGS_HEADER, [123456789012345678, "SYNTHETIC FUND", "ZZTMX", 1, 1, 1]]);
    const p = parseVanguardExport(rows)!;
    expect(p.accountNumbers![0]).not.toBe("123456789012345678");
    expect(p.notes!.join("\n")).toContain("1 account number needs review");
  });

  it("recognizes a placeholder-only template but imports nothing from it", () => {
    const rows = viaXlsx([
      VG_HOLDINGS_HEADER,
      ["account 1"], ["account 1"], [], ["account 2"],
      ["space"], ["space"],
      VG_ACTIVITY_HEADER,
      ["account 1", "", "", "dividend", "dividend received", "", "", "", "", "positive or negative amounts", "", "positive or negative amounts", 0, "cash"],
      ["account 2", "", "", "sweep out", "sweep into settlement account", "", "", "", "", "negative", "", "negative", 0, "cash"],
    ]);
    expect(detectInvestmentFormat(rows)).toBe("vanguard");
    const p = parseVanguardExport(rows)!;
    expect([p.sections.length, p.activity.length, p.accountNumbers]).toEqual([0, 0, []]);
    expect(p.notes!.join("\n")).toMatch(/3 holdings rows were left out[\s\S]*2 activity rows were left out/);
  });

  it("keeps long text IDs, flags numeric IDs and rejects malformed money/yearless dates", () => {
    const p = parseVanguardExport(viaXlsx([
      ["Total Value", "Symbol", "Shares", "Investment Name", "Account Number", "Share Price"],
      ["10.00", "ZZONE", 1, "SYNTHETIC ONE", "00012345678901234567890", 10],
      ["20.00", "ZZTWO", 2, "SYNTHETIC TWO", 12345, 10],
      ["1.2.3", "BAD", 1, "Malformed", "001", 1],
      ["1,23", "BAD", 1, "Ambiguous decimal comma", "001", 1],
      [".", "BAD", 1, "Missing digits", "001", 1],
      VG_ACTIVITY_HEADER,
      act("001", "1", "", "dividend", "Yearless", "ZZONE", 1),
      act("001", "02/31/2026", "", "dividend", "Invalid", "ZZONE", 1),
      act("001", "01/02/2026", "01/03/2026", "dividend", "Review month first", "ZZONE", "(2.00)"),
    ]))!;
    expect(p.accountNumbers).toContain("00012345678901234567890");
    expect(p.sections.map((s) => s.totalMarketValue)).toEqual([10, 20]);
    expect(p.activity.map((a) => [a.date, a.amount])).toEqual([["2026-01-02", -2]]);
    expect(p.notes!.join(" ")).toContain("1 account number needs review");
    expect(p.notes!.join(" ")).toContain("3 holdings rows were left out");
    expect(p.notes!.join(" ")).toContain("2 activity rows were left out");
    expect(p.notes!.join(" ")).toContain("month/day/year");
  });

  it("respects the workbook's 1904 date epoch while preserving the original serial cells", () => {
    const wb = XLSX.utils.book_new();
    wb.Workbook = { WBProps: { date1904: true } };
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      VG_ACTIVITY_HEADER, act("001", 44575, 44576, "Dividend", "Synthetic", "ZZONE", 2),
    ]), "S");
    const read = XLSX.read(XLSX.write(wb, { type: "array", bookType: "xlsx" }), { type: "array" });
    const p = parseVanguardExport(workbookSheetRows(read, "S"))!;
    expect(p.activity[0].date).toBe("2026-01-15");
    expect(p.activity[0].sourceFields!["Trade Date"]).toBe("44575");
  });

  it("decodes numeric date cells with short-year formatting and accounting amounts", () => {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      VG_ACTIVITY_HEADER, act("001", 46037, 46038, "Sell", "Synthetic", "ZZONE", -1234.5),
    ]);
    sheet.B2.z = "m/d/yy";
    sheet.C2.z = "m/d/yy";
    sheet.L2.z = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
    XLSX.utils.book_append_sheet(wb, sheet, "S");
    const read = XLSX.read(XLSX.write(wb, { type: "array", bookType: "xlsx" }), { type: "array" });
    const p = parseVanguardExport(workbookSheetRows(read, "S"))!;
    expect(p.activity).toHaveLength(1);
    expect([p.activity[0].date, p.activity[0].settleDate, p.activity[0].amount]).toEqual(["2026-01-15", "2026-01-16", -1234.5]);
  });

  it("requires a separate destination for every source account", () => {
    expect(defaultSourceAccountName("000123456789")).toBe("Vanguard ••6789");
    const accts = ["1111", "2222"];
    expect(sourceRoutingProblem(accts, { "1111": { mode: "new", name: "A" }, "2222": { mode: "new", name: "B" } })).toBeNull();
    expect(sourceRoutingProblem(accts, { "1111": { mode: "existing", accountId: 7 }, "2222": { mode: "existing", accountId: 7 } })).toMatch(/same Compass account/);
    expect(sourceRoutingProblem(accts, { "1111": { mode: "new", name: "A" }, "2222": { mode: "new", name: " a " } })).toMatch(/same Compass account/);
    expect(sourceRoutingProblem(accts, { "1111": { mode: "new", name: "A" } })).toMatch(/2222/);
  });
});
