import { describe, it, expect } from "vitest";
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
