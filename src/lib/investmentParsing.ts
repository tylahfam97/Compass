// ─── Investment / brokerage statement parsing ──────────────────────────────────
// Extracted from ImportPage.tsx so the parsers are independently testable (same reason
// importParsing.ts exists). Every parser takes the `string[][]` shape that CSV, XLSX and
// `extractPdfRows()` all normalize to, and returns a `ParsedInvestment`.

import { parseAmount, parseDate } from "./importParsing";
import type { ActivityType, SecurityType } from "./types";

export interface InvestmentRow {
  securityType: SecurityType;
  symbol: string | null;
  description: string;
  shares: number | null;
  price: number | null;
  marketValue: number | null;
  costBasis: number | null;
  tradeDate: string | null;
  dividendPerShare: number | null;
  estAnnualIncome: number | null;
}

export interface InvestmentSection {
  title: string;
  securityType: SecurityType;
  headerRow: string[];
  rawRows: string[][];
  colMap: Record<string, number>;
  rows: InvestmentRow[];
  totalMarketValue: number;
}

/** One line of a statement's transaction/activity table. `amount` is signed dollars (credits
 *  positive, debits negative). The cost-basis/realized-gain fields are only populated by
 *  statements that print a per-lot realized gain table alongside the sale itself. */
export interface ParsedActivity {
  date: string;
  settleDate: string | null;
  activityType: ActivityType;
  rawActivityType: string;
  symbol: string | null;
  description: string;
  quantity: number | null;
  price: number | null;
  amount: number;
  costBasis: number | null;
  realizedGain: number | null;
  acquiredDate: string | null;
  term: "short" | "long" | null;
}

/** A statement's period-level totals ("what happened to this account this period"). Every
 *  field is nullable because no single statement format prints all of them. */
export interface ParsedSummary {
  periodStart: string | null;
  periodEnd: string;
  beginningValue: number | null;
  endingValue: number | null;
  changeInValue: number | null;
  cashBalance: number | null;
  deposits: number | null;
  withdrawals: number | null;
  transfers: number | null;
  income: number | null;
  dividends: number | null;
  interest: number | null;
  fees: number | null;
  realizedGain: number | null;
  realizedGainYtd: number | null;
  unrealizedGain: number | null;
}

export interface ParsedInvestment {
  asOfDate: string;
  sections: InvestmentSection[];
  activity: ParsedActivity[];
  summary: ParsedSummary | null;
  /** The account's name as printed on the statement, used to suggest an account in the wizard. */
  accountLabel: string | null;
  accountNumber: string | null;
}

/** Builds a positions-only result for the formats that are a portfolio export rather than a
 *  full statement (no activity, no period totals). */
function positionsOnly(asOfDate: string, sections: InvestmentSection[]): ParsedInvestment {
  return { asOfDate, sections, activity: [], summary: null, accountLabel: null, accountNumber: null };
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}

/** Maps a section title (as printed in the export) to a broad security type. */
export function classifySection(title: string): SecurityType {
  const key = title.trim().toLowerCase();
  if (key.includes("stock")) return "stock";
  if (key.includes("etf") || key.includes("exchange")) return "etf";
  if (key.includes("mutual fund") || key.includes("fund")) return "mutual_fund";
  if (key.includes("cash")) return "cash";
  return "other";
}

/**
 * Asset-class sub-heading labels that can appear mid-section (e.g. under
 * "Stocks") to group holdings. They only ever have a value in the first
 * column, but so can a legitimate holding whose other fields are blank -
 * so we only skip rows that exactly match this known vocabulary.
 */
export const ASSET_CLASS_LABELS = new Set([
  "common stock", "preferred stock", "adr", "american depositary receipt",
  "exchange traded fund", "exchange-traded fund", "closed end fund",
  "mutual fund", "money market fund", "municipal bond", "corporate bond",
  "government bond", "treasury", "reit", "master limited partnership", "mlp",
  "warrant", "warrants", "option", "options", "unit investment trust",
]);

/** Column-name aliases (lowercased, trimmed) mapped to a canonical field. Matching is exact
 *  equality against a header cell, so a longer alias can never be shadowed by a shorter one. */
export const HOLDING_HEADER_ALIASES: Record<string, string[]> = {
  description: ["description", "security description"],
  symbol: ["symbol", "symbol/cusip", "security (symbol)"],
  shares: ["shares", "quantity"],
  price: ["last price ($)", "estimated price", "price", "share price"],
  marketValue: ["market value", "estimated market value"],
  costBasis: ["cost basis", "total cost"],
  tradeDate: ["trade date1", "trade date"],
  dividendPerShare: ["dividend"],
  estAnnualIncome: ["est. annual income", "est ann income"],
};

/** Field order + display labels for the manual column-remap UI. */
export const HOLDING_FIELDS: { key: string; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "symbol", label: "Symbol" },
  { key: "shares", label: "Shares" },
  { key: "price", label: "Price" },
  { key: "marketValue", label: "Market Value" },
  { key: "costBasis", label: "Cost Basis" },
  { key: "tradeDate", label: "Trade Date" },
  { key: "dividendPerShare", label: "Dividend/Share" },
  { key: "estAnnualIncome", label: "Est. Annual Income" },
];

export function buildHoldingHeaderMap(headerRow: string[]): Record<string, number> {
  const norm = headerRow.map((h) => (h ?? "").toLowerCase().trim());
  const map: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HOLDING_HEADER_ALIASES)) {
    for (const alias of aliases) {
      const idx = norm.findIndex((h) => h === alias);
      if (idx >= 0) { map[field] = idx; break; }
    }
  }
  return map;
}

/** An em/en dash is how brokerage statements print "no value" - treat it as empty, not as a
 *  number, so it doesn't get parsed into a misleading $0.00. */
const BLANK_CELL_RE = /^(n\/a|[—–-]+)$/i;

export function cellOrNull(row: string[], idx: number | undefined): string | null {
  if (idx === undefined) return null;
  const v = (row[idx] ?? "").trim();
  return !v || BLANK_CELL_RE.test(v) ? null : v;
}

export function parseMoneyOrNull(row: string[], idx: number | undefined): number | null {
  const v = cellOrNull(row, idx);
  return v === null ? null : parseAmount(v);
}

export function parseSharesOrNull(row: string[], idx: number | undefined): number | null {
  const v = cellOrNull(row, idx);
  if (v === null) return null;
  const n = parseFloat(v.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

export function parseTradeDateOrNull(row: string[], idx: number | undefined): string | null {
  const v = cellOrNull(row, idx);
  if (v === null) return null;
  const iso = parseDate(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/** Builds a single holding row from a raw data row using a (possibly user-edited) column map. */
export function buildInvestmentRow(dataRow: string[], colMap: Record<string, number>, securityType: SecurityType): InvestmentRow | null {
  const dCol0 = (dataRow[0] ?? "").trim();
  const description = cellOrNull(dataRow, colMap.description) ?? dCol0;
  if (!description) return null;
  return {
    securityType,
    symbol: cellOrNull(dataRow, colMap.symbol),
    description,
    shares: parseSharesOrNull(dataRow, colMap.shares),
    price: parseMoneyOrNull(dataRow, colMap.price),
    marketValue: parseMoneyOrNull(dataRow, colMap.marketValue),
    costBasis: parseMoneyOrNull(dataRow, colMap.costBasis),
    tradeDate: parseTradeDateOrNull(dataRow, colMap.tradeDate),
    dividendPerShare: parseMoneyOrNull(dataRow, colMap.dividendPerShare),
    estAnnualIncome: parseMoneyOrNull(dataRow, colMap.estAnnualIncome),
  };
}

/** Counts how many of a section's raw rows have a non-blank value in a given column - lets the
 *  "Fix columns" picker show whether a candidate column actually has data before you pick it. */
export function columnFillCount(rawRows: string[][], idx: number): number {
  return rawRows.reduce((n, row) => n + ((row[idx] ?? "").toString().trim() ? 1 : 0), 0);
}

/** True when none of a section's value fields (everything but description/symbol) has any data. */
export function sectionHasNoValueData(rows: InvestmentRow[]): boolean {
  return rows.every((r) =>
    r.shares === null && r.price === null && r.marketValue === null && r.costBasis === null &&
    r.tradeDate === null && r.dividendPerShare === null && r.estAnnualIncome === null
  );
}

/** Detects a brokerage statement's "Priced as of ..." date from the first few rows. */
export function detectStatementDate(rows: string[][]): string | null {
  for (const row of rows.slice(0, 6)) {
    for (const cell of row) {
      if (!cell) continue;
      const m = cell.match(/priced as of.*?(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (m) { const iso = parseDate(m[1]); return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null; }
    }
  }
  return null;
}

/** Classify a broker-supplied security-type string to our internal SecurityType. */
export function classifyFlatSecurityType(raw: string): SecurityType {
  const s = raw.trim().toLowerCase();
  if (s.includes("mutual fund") || s.includes("money market")) return "mutual_fund";
  if (s.includes("etf") || s.includes("exchange traded")) return "etf";
  if (s.includes("stock") || s.includes("common stock")) return "stock";
  if (s.includes("cash")) return "cash";
  return "other";
}

/**
 * Last-resort security-type guess for exports whose own type column is blank (Fidelity's
 * positions CSV leaves it empty on every row). Ticker conventions are reliable enough for
 * the broad stock/etf/mutual_fund buckets the Investments page groups by.
 */
export function inferSecurityType(symbol: string | null, description: string): SecurityType {
  const sym = (symbol ?? "").trim().toUpperCase();
  const desc = description.trim().toUpperCase();
  if (/MONEY MARKET|CASH RESERVES|GOVERNMENT CASH|SWEEP|BANK DEPOSIT/.test(desc)) return "cash";
  // US mutual funds use a 5-letter ticker ending in X; CUSIPs are 9 alphanumerics.
  if (/^[A-Z]{4}X$/.test(sym)) return "mutual_fund";
  if (/^[A-Z0-9]{9}$/.test(sym)) return "mutual_fund";
  if (/\bETF\b|\bISHARES\b|\bSPDR\b|\bINDEX SHARES\b/.test(desc)) return "etf";
  if (/\bFUND\b|\bFD\b|\bIDX\b|\bINDEX\b/.test(desc)) return "mutual_fund";
  if (/^[A-Z.]{1,5}$/.test(sym)) return "stock";
  return "other";
}

/**
 * Builds a synthetic InvestmentSection from a flat array of rows, grouped by a
 * derived title. Used by the Fidelity and Thrivent parsers.
 */
export function buildFlatSection(
  title: string,
  securityType: SecurityType,
  headerRow: string[],
  colMap: Record<string, number>,
  rawRows: string[][],
  perRowSecurityType?: (row: string[], built: InvestmentRow) => SecurityType
): InvestmentSection {
  const rows = rawRows
    .map((r) => {
      const built = buildInvestmentRow(r, colMap, securityType);
      if (built && perRowSecurityType) built.securityType = perRowSecurityType(r, built);
      return built;
    })
    .filter((r): r is InvestmentRow => r !== null);
  return {
    title, securityType, headerRow, rawRows, colMap, rows,
    totalMarketValue: rows.reduce((s, r) => s + (r.marketValue ?? 0), 0),
  };
}

// ─── Thrivent brokerage positions export (flat CSV) ────────────────────────────

/**
 * Parses a Thrivent brokerage positions export (flat CSV, one row per holding).
 * Groups results into sections by Security Type.
 * Returns null if the file doesn't look like a Thrivent export.
 *
 * Expected headers (0-based indices used due to duplicate "Currency Code" names):
 *   1  Security ID,          3  Security Description, 5  Recent Quantity, 6  Recent Price,
 *   10 Recent Market Value,  14 Account Type,         15 Cost,            27 Security Type,
 *   29 Symbol
 */
export function parseThriventPositionsCSV(data: string[][]): ParsedInvestment | null {
  const headerRow = data[0];
  if (!headerRow) return null;
  const norm = headerRow.map((h) => (h ?? "").toLowerCase().trim());
  if (!norm.includes("security description") || !norm.includes("security type")) return null;

  const colMap: Record<string, number> = {
    description: norm.indexOf("security description"),
    symbol:      norm.lastIndexOf("symbol"),        // last occurrence avoids "Security ID"
    shares:      norm.indexOf("recent quantity"),
    price:       norm.indexOf("recent price"),
    marketValue: norm.indexOf("recent market value"),
    costBasis:   norm.indexOf("cost"),
  };
  // "cost" might match "account type" column name fragments - pin to known safe range
  // If recent market value was found at col 10, cost should be around col 15
  const mvIdx = colMap.marketValue;
  if (colMap.costBasis >= 0 && mvIdx >= 0 && colMap.costBasis <= mvIdx) {
    // cost column appeared before market value - re-search after market value
    const afterMv = norm.slice(mvIdx + 1).indexOf("cost");
    colMap.costBasis = afterMv >= 0 ? mvIdx + 1 + afterMv : -1;
  }

  const secTypeIdx = norm.indexOf("security type");
  const acctTypeIdx = norm.indexOf("account type");
  const securityIdIdx = norm.indexOf("security id");

  // Bucket rows by security type
  const buckets = new Map<string, string[][]>();
  for (const row of data.slice(1)) {
    const desc = (row[colMap.description] ?? "").trim();
    if (!desc) continue;
    const rawType = (secTypeIdx >= 0 ? row[secTypeIdx] ?? "" : "").trim() || "Other";
    if (!buckets.has(rawType)) buckets.set(rawType, []);
    buckets.get(rawType)!.push(row);
  }

  if (buckets.size === 0) return null;

  const sections: InvestmentSection[] = [];
  for (const [rawType, rows] of buckets) {
    const securityType = classifyFlatSecurityType(rawType);
    const title = rawType === "Common Stock/ETF" ? "Stocks & ETFs" : rawType;
    const section = buildFlatSection(title, securityType, headerRow, colMap, rows, (row, built) => {
      // Thrivent files a cash sweep as a mutual fund with Account Type "Cash" - the fund's own
      // type column can't distinguish it, but the Investments page's Cash bucket needs it to.
      if (acctTypeIdx >= 0 && (row[acctTypeIdx] ?? "").trim().toLowerCase() === "cash" &&
          inferSecurityType(built.symbol, built.description) === "cash") {
        return "cash";
      }
      // "Common Stock/ETF" is one combined bucket covering both - classifying the whole section
      // by its title would file every individual stock under ETFs.
      if (/stock/i.test(rawType) && /etf/i.test(rawType)) {
        return inferSecurityType(built.symbol, built.description);
      }
      return securityType;
    });
    // Fall back to the CUSIP/security ID when a holding has no ticker symbol.
    if (securityIdIdx >= 0) {
      section.rows.forEach((r, i) => {
        if (!r.symbol) r.symbol = (section.rawRows[i]?.[securityIdIdx] ?? "").trim() || null;
      });
    }
    if (section.rows.length > 0) sections.push(section);
  }

  return sections.length > 0 ? positionsOnly(detectStatementDate(data) ?? todayIso(), sections) : null;
}

// ─── Fidelity brokerage positions export (flat CSV) ────────────────────────────

/** Fidelity stamps its positions export with a "Date downloaded Jul-16-2026 2:16 p.m ET"
 *  footer - the true as-of date of the snapshot, which is otherwise unrecoverable. */
function detectFidelityDownloadDate(data: string[][]): string | null {
  for (const row of data) {
    for (const cell of row) {
      const m = (cell ?? "").match(/date downloaded\s+([A-Za-z]{3})-(\d{1,2})-(\d{4})/i);
      if (!m) continue;
      const iso = parseDate(`${m[1]} ${m[2]}, ${m[3]}`);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    }
  }
  return null;
}

/**
 * Parses a Fidelity brokerage positions export (flat CSV, one row per holding,
 * potentially spanning multiple accounts). Groups results into one section per
 * account name.
 * Returns null if the file doesn't look like a Fidelity export.
 *
 * Expected headers: Account number, Account name, Symbol, Description, Quantity,
 *   Last price, Last price change, Current value, ..., Cost basis total, Average cost basis, Type
 */
export function parseFidelityPositionsCSV(data: string[][]): ParsedInvestment | null {
  const headerRow = data[0];
  if (!headerRow) return null;
  const norm = headerRow.map((h) => (h ?? "").toLowerCase().trim());
  if (!norm.includes("cost basis total") || !norm.includes("account name")) return null;

  const colMap: Record<string, number> = {
    description: norm.indexOf("description"),
    symbol:      norm.indexOf("symbol"),
    shares:      norm.indexOf("quantity"),
    price:       norm.indexOf("last price"),
    marketValue: norm.indexOf("current value"),
    costBasis:   norm.indexOf("cost basis total"),
  };
  const typeIdx    = norm.indexOf("type");
  const accountIdx = norm.indexOf("account name");

  // Bucket rows by account name
  const buckets = new Map<string, string[][]>();
  for (const row of data.slice(1)) {
    const desc = (row[colMap.description] ?? "").trim();
    if (!desc) continue;
    const account = (accountIdx >= 0 ? row[accountIdx] ?? "" : "").trim() || "Portfolio";
    // Strip trailing quote/apostrophe artifacts sometimes present in Fidelity exports
    const cleanAccount = account.replace(/['"]+$/, "").trim() || "Portfolio";
    if (!buckets.has(cleanAccount)) buckets.set(cleanAccount, []);
    buckets.get(cleanAccount)!.push(row);
  }

  if (buckets.size === 0) return null;

  const sections: InvestmentSection[] = [];
  for (const [account, rows] of buckets) {
    // Derive a representative security type for the section from the first row that has one
    let securityType: SecurityType = "other";
    if (typeIdx >= 0) {
      for (const row of rows) {
        const t = (row[typeIdx] ?? "").trim();
        if (t) { securityType = classifyFlatSecurityType(t); break; }
      }
    }
    // Fidelity leaves the Type column blank on every row of a retirement-plan export, which
    // would otherwise dump the entire account into the Investments page's "Other" bucket.
    const section = buildFlatSection(account, securityType, headerRow, colMap, rows, (row, built) => {
      const t = typeIdx >= 0 ? (row[typeIdx] ?? "").trim() : "";
      return t ? classifyFlatSecurityType(t) : inferSecurityType(built.symbol, built.description);
    });
    if (section.rows.length > 0) sections.push(section);
  }

  return sections.length > 0
    ? positionsOnly(detectFidelityDownloadDate(data) ?? todayIso(), sections)
    : null;
}

// ─── Principal Financial Group 401(k)/retirement-plan quarterly statement (PDF) ─

/**
 * Principal's "Investments" table asset-class category names (risk buckets, not security
 * types - every holding underneath them is a mutual fund investment option, unlike WFA's
 * sections which are already named by security type). Used both to detect the format and to
 * find each new grouping's boundary while walking the extracted rows.
 */
const RETIREMENT_ASSET_CLASS_TITLES = new Set([
  "short-term fixed income", "fixed income", "balanced/asset allocation",
  "large u.s. equity", "small/mid u.s. equity", "global/international equity", "other",
]);

const MONEY_CELL_RE = /^\(?-?\$?[\d,]+\.\d{2}\)?$/;
function isMoneyCell(s: string): boolean {
  return MONEY_CELL_RE.test((s ?? "").trim());
}

/**
 * True for any row ending in 5 consecutive money cells - Principal's "Investments" table
 * always lays out [Balance as of <start>, Additions, Deducted/Adjusted Fees, Gain/Loss,
 * Balance as of <end>] as the last 5 logical columns, whether or not a description happens to
 * fit on the same physical PDF line as those values. Short fund/total names fit on one line
 * (`leadingText` is the whole label); long ones wrap onto the line before AND after their own
 * values line, in which case this particular line has no leading text at all.
 */
function principalValuesRow(row: string[]): { leadingText: string; values: number[] } | null {
  if (row.length < 5) return null;
  const tail = row.slice(row.length - 5);
  if (!tail.every(isMoneyCell)) return null;
  return { leadingText: row.slice(0, row.length - 5).join(" ").trim(), values: tail.map((c) => parseAmount(c)) };
}

// Recurring page boilerplate (plan/contract/participant header block, sidebar disclaimers,
// page footer) that appears interleaved with the real "Investments" table content every time
// the table spans a page break - none of it is a holding, an asset-class heading, or a values
// row, so it's simplest to just recognize and skip it outright rather than trying to bound the
// table region page-by-page.
const PRINCIPAL_BOILERPLATE_RES: RegExp[] = [
  /401\(k\)\s*plan/i,
  /^please review this statement/i,
  /^contract number/i,
  /^_$/,
  /^[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}$/, // e.g. "January 1, 2026 March 31, 2026"
  /^discrepancies within/i,
  /^participant name/i,
  /^days,\s*corrections/i,
  /^current basis\.?$/i,
  /^investments(\s*\(continued\))?$/i,
  /principal\.com/i,
  /^and notify us promptly/i,
];
function isPrincipalBoilerplate(row: string[]): boolean {
  const joined = row.join(" ").trim();
  if (!joined) return true;
  return PRINCIPAL_BOILERPLATE_RES.some((re) => re.test(joined) || re.test((row[0] ?? "").trim()));
}

/** Cheap check used by `detectInvestmentFormat`: Principal's "Investments" table header row
 *  ("Asset Class" / "Balance as of ..."), reconstructed from the statement's text layer. */
export function looksLikePrincipalStatement(data: string[][]): boolean {
  return data.some(
    (row) => (row[0] ?? "").trim().toLowerCase() === "asset class" && row.some((c) => /balance as of/i.test(c ?? ""))
  );
}

/**
 * Parses a Principal Financial Group 401(k)/retirement-plan "Quarterly statement" PDF's
 * "Investments" table. Returns one `InvestmentSection` per asset-class grouping (e.g. "Large
 * U.S. Equity"), mirroring how the statement itself groups holdings - all rows are classified
 * as `mutual_fund` since a retirement-plan lineup is effectively always mutual funds (unlike
 * WFA sections, Principal's asset-class titles describe risk bucket, not security type, so
 * `classifySection`'s generic keyword matching doesn't apply here). There's no symbol, share
 * count, price, or cost-basis data on this statement (only a period's beginning/ending balance
 * per fund), so those fields are left null - the description combines the fund name with its
 * advisor/fund-family name as printed (e.g. "Vanguard 500 Index Admiral Fd — Vanguard Group").
 * Returns null if no recognizable "Asset Class" header row is found.
 */
export function parsePrincipalStatement(data: string[][]): ParsedInvestment | null {
  const headerIdx = data.findIndex(
    (row) => (row[0] ?? "").trim().toLowerCase() === "asset class" && row.some((c) => /balance as of/i.test(c ?? ""))
  );
  if (headerIdx < 0) return null;

  // The period start/end dates sit in the header's 3rd physical line, e.g.
  // ["Advisor/Investment","01/01/2026","Adjusted Fees","03/31/2026"].
  let asOfDate = todayIso();
  let periodStart: string | null = null;
  const dateHeaderRow = data[headerIdx + 2];
  if (dateHeaderRow) {
    const iso = parseDate(dateHeaderRow[dateHeaderRow.length - 1] ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) asOfDate = iso;
    const startIso = parseDate(dateHeaderRow[1] ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(startIso)) periodStart = startIso;
  }

  let totalAssetsIdx = data.findIndex((row) => (row[0] ?? "").trim().toLowerCase() === "total assets");
  if (totalAssetsIdx < 0) totalAssetsIdx = data.length;

  const sectionsByTitle = new Map<string, { description: string; marketValue: number }[]>();
  let currentAssetClass: string | null = null;
  let pendingText: string[] = [];

  for (let i = headerIdx + 3; i < totalAssetsIdx; i++) {
    const row = data[i];
    const c0 = (row[0] ?? "").trim();
    const c0Lower = c0.toLowerCase();

    // A repeated header block (the table continues onto a later page) - skip its 3 lines.
    if (c0Lower === "asset class" && row.some((c) => /balance as of/i.test(c ?? ""))) {
      i += 2;
      pendingText = [];
      continue;
    }
    if (isPrincipalBoilerplate(row)) continue;
    if (RETIREMENT_ASSET_CLASS_TITLES.has(c0Lower) && row.length === 1) {
      currentAssetClass = c0;
      pendingText = [];
      continue;
    }

    const valuesRow = principalValuesRow(row);
    if (valuesRow) {
      const { leadingText, values } = valuesRow;
      const marketValue = values[4];
      let advisor: string | null = null;
      let label: string;
      if (leadingText) {
        label = leadingText;
        if (pendingText.length >= 1 && !/^total\b/i.test(leadingText)) advisor = pendingText[pendingText.length - 1];
      } else if (pendingText.length >= 2) {
        advisor = pendingText[pendingText.length - 2];
        label = pendingText[pendingText.length - 1];
      } else if (pendingText.length === 1) {
        label = pendingText[0];
      } else {
        label = "";
      }

      // A values-only line (no leading text) means the label didn't fit on one line and
      // continues on the very next line - consume it, unless that next line is clearly the
      // start of something else (defensive; shouldn't happen in a well-formed statement).
      let fullLabel = label;
      if (!leadingText) {
        const next = data[i + 1];
        const nextC0 = (next?.[0] ?? "").trim();
        const nextIsContinuation =
          i + 1 < totalAssetsIdx && next && next.length === 1 && nextC0 &&
          !RETIREMENT_ASSET_CLASS_TITLES.has(nextC0.toLowerCase()) &&
          !isPrincipalBoilerplate(next) && !principalValuesRow(next);
        if (nextIsContinuation) {
          fullLabel = `${label} ${nextC0}`.trim();
          i++;
        }
      }

      pendingText = [];
      // "Total <asset class>" rows are per-section subtotals, not individual holdings - skip.
      if (!/^total\b/i.test(fullLabel) && currentAssetClass && fullLabel) {
        const description = advisor ? `${fullLabel} — ${advisor}` : fullLabel;
        const arr = sectionsByTitle.get(currentAssetClass) ?? [];
        arr.push({ description, marketValue });
        sectionsByTitle.set(currentAssetClass, arr);
      }
      continue;
    }

    if (c0) pendingText.push(c0);
  }

  if (sectionsByTitle.size === 0) return null;

  // Principal's "Contributions" section (earlier in the statement, outside the range scanned
  // above) reports cumulative "Total contributions" - "Since joining" as its own column - the
  // true, correct cost basis for the WHOLE account (money actually put in, employee + employer,
  // since day one), unlike a per-quarter Additions figure which would wrongly count new payroll
  // contributions as investment gains. Principal doesn't break this total down per fund, so it's
  // allocated proportionally by each fund's current share of the total account value - this
  // doesn't distort the ACCOUNT-level return (which is all `computeInvestmentReturn` actually
  // uses, summing cost basis and market value back up across every holding) even though it
  // necessarily shows the same blended ROI% on every individual fund on the Investments page.
  const contributionsRow = data.find((row) => (row[0] ?? "").trim().toLowerCase() === "total contributions");
  const sinceJoiningCell = contributionsRow?.[1];
  const totalContributions = sinceJoiningCell && isMoneyCell(sinceJoiningCell) ? parseAmount(sinceJoiningCell) : null;
  const totalMarketValueAllSections = [...sectionsByTitle.values()]
    .flat()
    .reduce((s, h) => s + h.marketValue, 0);

  const sections: InvestmentSection[] = [...sectionsByTitle.entries()].map(([title, holdings]) => {
    const rows: InvestmentRow[] = holdings.map((h) => ({
      securityType: "mutual_fund", symbol: null, description: h.description, shares: null,
      price: null, marketValue: h.marketValue,
      costBasis: totalContributions !== null && totalMarketValueAllSections > 0
        ? totalContributions * (h.marketValue / totalMarketValueAllSections)
        : null,
      tradeDate: null, dividendPerShare: null, estAnnualIncome: null,
    }));
    return {
      title, securityType: "mutual_fund", headerRow: ["Description", "Market Value"],
      rawRows: holdings.map((h) => [h.description, h.marketValue.toFixed(2)]),
      colMap: { description: 0, marketValue: 1 }, rows,
      totalMarketValue: rows.reduce((s, r) => s + (r.marketValue ?? 0), 0),
    };
  });

  // The "Total Assets" row carries the whole account's period totals in the same 5-column
  // layout as every fund row: [balance at start, additions, fees, gain/loss, balance at end].
  const totalsRow = totalAssetsIdx < data.length ? principalValuesRow(data[totalAssetsIdx]) : null;
  const summary: ParsedSummary | null = totalsRow
    ? {
        periodStart, periodEnd: asOfDate,
        beginningValue: totalsRow.values[0], endingValue: totalsRow.values[4],
        changeInValue: totalsRow.values[4] - totalsRow.values[0],
        cashBalance: null,
        deposits: totalsRow.values[1], withdrawals: null, transfers: null,
        income: null, dividends: null, interest: null,
        fees: totalsRow.values[2],
        realizedGain: null, realizedGainYtd: null, unrealizedGain: totalsRow.values[3],
      }
    : null;

  return { asOfDate, sections, activity: [], summary, accountLabel: null, accountNumber: null };
}

// ─── E*TRADE / Morgan Stanley "CLIENT STATEMENT" (PDF) ──────────────────────────

/** A statement money cell: "$1,192.53", "(1,667.00)", "$(419.86)", "1,247.14", or an em-dash
 *  meaning "none". Deliberately requires exactly 2 decimals so the chart axis labels that
 *  `extractPdfRows` interleaves between the Account Summary rows ("1.8", "0.9") don't match. */
const ETRADE_MONEY_RE = /^\$?\(?-?\$?[\d,]+\.\d{2}\)?$/;
function isEtradeMoney(s: string): boolean {
  const v = (s ?? "").trim();
  return ETRADE_MONEY_RE.test(v) || BLANK_CELL_RE.test(v);
}
/** A price cell - same as money but with a broker's extra precision ("$8.6450"). */
const ETRADE_PRICE_RE = /^\$[\d,]+\.\d+$/;
/** A share quantity as E*TRADE prints it, always to 3 decimals and never $-prefixed. */
const ETRADE_QUANTITY_RE = /^-?[\d,]+\.\d{3}$/;
const ETRADE_SHORT_DATE_RE = /^\d{1,2}\/\d{1,2}$/;
const ETRADE_PERCENT_RE = /^-?[\d,]+(\.\d+)?%$/;

const MONTHS = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];

export function looksLikeEtradeStatement(data: string[][]): boolean {
  return data.some(
    (row) =>
      row.some((c) => (c ?? "").trim().toUpperCase() === "CLIENT STATEMENT") &&
      row.some((c) => /^For the Period\b/i.test((c ?? "").trim()))
  );
}

/** Reads "For the Period April 1- June 30, 2026" / "For the Period July 1-31, 2026" into an
 *  ISO start/end pair. Only the end year is printed, so a period spanning New Year (e.g.
 *  "December 1- January 31, 2027") backs the start year off by one. */
function parseEtradePeriod(data: string[][]): { start: string; end: string } | null {
  for (const row of data) {
    for (const cell of row) {
      const m = (cell ?? "").trim().match(
        /^For the Period\s+([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*(?:([A-Za-z]+)\s+)?(\d{1,2}),\s*(\d{4})$/i
      );
      if (!m) continue;
      const startMonth = MONTHS.indexOf(m[1].toLowerCase());
      const endMonth = m[3] ? MONTHS.indexOf(m[3].toLowerCase()) : startMonth;
      if (startMonth < 0 || endMonth < 0) continue;
      const endYear = parseInt(m[5], 10);
      const startYear = startMonth > endMonth ? endYear - 1 : endYear;
      const iso = (y: number, mo: number, d: number) =>
        `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      return {
        start: iso(startYear, startMonth, parseInt(m[2], 10)),
        end: iso(endYear, endMonth, parseInt(m[4], 10)),
      };
    }
  }
  return null;
}

/** Resolves an activity table's year-less "M/D" date against the statement period. A settlement
 *  date a day or two past period end is normal; a January date on a December statement belongs
 *  to the next year. */
function resolveEtradeShortDate(cell: string, periodStart: string, periodEnd: string): string | null {
  const m = cell.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const endYear = parseInt(periodEnd.slice(0, 4), 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  const candidates = [endYear, endYear - 1, endYear + 1].map((y) => `${y}-${pad(month)}-${pad(day)}`);
  const startMs = Date.parse(periodStart);
  const endMs = Date.parse(periodEnd);
  let best = candidates[0];
  let bestDistance = Infinity;
  for (const c of candidates) {
    const ms = Date.parse(c);
    const distance = ms < startMs ? startMs - ms : ms > endMs ? ms - endMs : 0;
    if (distance < bestDistance) { bestDistance = distance; best = c; }
  }
  return best;
}

/** Section/table headings E*TRADE prints in full caps on their own line. Used both to switch
 *  the current holdings bucket and to bound each activity table. */
const ETRADE_HOLDING_SECTIONS: { match: RegExp; title: string; type: SecurityType }[] = [
  { match: /^CASH, BANK DEPOSIT PROGRAM AND MONEY MARKET FUNDS$/i, title: "Cash, Bank Deposit Program & Money Market Funds", type: "cash" },
  { match: /^(COMMON|PREFERRED)? ?STOCKS$/i, title: "Stocks", type: "stock" },
  { match: /^EXCHANGE[- ]TRADED FUNDS$/i, title: "Exchange-Traded Funds", type: "etf" },
  { match: /^(OPEN-END |CLOSED-END )?MUTUAL FUNDS$/i, title: "Mutual Funds", type: "mutual_fund" },
  { match: /^(CORPORATE|MUNICIPAL|GOVERNMENT) (BONDS|SECURITIES)$/i, title: "Bonds", type: "other" },
  { match: /^(OPTIONS|ALTERNATIVE INVESTMENTS|STRUCTURED INVESTMENTS|OTHER SECURITIES)$/i, title: "Other Securities", type: "other" },
];

/** Rows that end the HOLDINGS region entirely. */
const ETRADE_HOLDINGS_END_RE = /^(TOTAL VALUE|ALLOCATION OF ASSETS|STOCK PLAN SUMMARY|ACTIVITY|MESSAGES)$/i;

/** Recurring per-page header block plus the wrapped column-header fragments that
 *  `extractPdfRows` emits as their own lines. None are holdings. */
function isEtradeNoise(row: string[]): boolean {
  const c0 = (row[0] ?? "").trim();
  if (!c0) return true;
  if (/^Page \d+ of \d+$/i.test(c0)) return true;
  if (/^CLIENT STATEMENT$/i.test(c0)) return true;
  if (/^For the Period\b/i.test(c0)) return true;
  if (/^\d{3}-\d{6}-\d{3}$/.test(c0)) return true;
  if (/^Account (Detail|Summary)$/i.test(c0)) return true;
  if (/^(Percentage|of Holdings|Unrealized|Current|7-Day|APY %|Market Value|Total Cost|Est Ann Income|Accrued Interest|Yield %|Gain\/\(Loss\)|Quantity|Share Price|Comments|Thousands)$/i.test(c0)) return true;
  if (ETRADE_PERCENT_RE.test(c0)) return true; // subtotal rows lead with "% of Holdings"
  if (isEtradeMoney(c0)) return true;
  // A holding's detail line, e.g. "127.000 shs from Stock Plan; Asset Class: Equities".
  if (row.length === 1 && /Asset Class:|^\s*[\d,.]+\s+shs\b/i.test(c0)) return true;
  return false;
}

/** True for the disclosure paragraphs E*TRADE prints between section headings - a single long
 *  sentence-shaped cell, never a table row. */
function isEtradeProse(row: string[]): boolean {
  if (row.length > 1) return false;
  const c0 = (row[0] ?? "").trim();
  return c0.length > 60 && /[a-z]/.test(c0);
}

/** Pulls a ticker out of "AVEANNA HEALTHCARE HLDGS INC (AVAH)". */
function splitEtradeSymbol(description: string): { description: string; symbol: string | null } {
  const m = description.match(/^(.*?)\s*\(([A-Z][A-Z0-9.\-]{0,9})\)\s*$/);
  if (!m) return { description, symbol: null };
  return { description: m[1].trim(), symbol: m[2] };
}

function parseEtradeHoldings(data: string[][]): InvestmentSection[] {
  const startIdx = data.findIndex((row) => (row[0] ?? "").trim().toUpperCase() === "HOLDINGS");
  if (startIdx < 0) return [];

  // Sections are appended up front and mutated in place; empty ones are dropped at the end.
  const sections: InvestmentSection[] = [];
  let colMap: Record<string, number> | null = null;

  for (let i = startIdx + 1; i < data.length; i++) {
    const row = data[i];
    const c0 = (row[0] ?? "").trim();

    if (row.length === 1 && ETRADE_HOLDINGS_END_RE.test(c0)) break;

    const sectionDef = row.length === 1 ? ETRADE_HOLDING_SECTIONS.find((s) => s.match.test(c0)) : undefined;
    if (sectionDef) {
      const open = sections[sections.length - 1];
      // "STOCKS" recurs as a subtotal label after the table ends - don't reopen it.
      if (open && open.title === sectionDef.title) continue;
      colMap = null;
      sections.push({
        title: sectionDef.title, securityType: sectionDef.type,
        headerRow: [], rawRows: [], colMap: {}, rows: [], totalMarketValue: 0,
      });
      continue;
    }

    const current = sections[sections.length - 1];
    if (!current) continue;

    // An explicit column header ("Security Description | Quantity | Share Price | ...").
    if (row.some((c) => (c ?? "").trim().toLowerCase() === "security description")) {
      colMap = buildHoldingHeaderMap(row);
      current.headerRow = row;
      current.colMap = colMap;
      continue;
    }

    if (isEtradeProse(row) || isEtradeNoise(row)) continue;
    const valueCell = row.slice(1).find((c) => isEtradeMoney(c) && !BLANK_CELL_RE.test((c ?? "").trim()));
    if (!valueCell) continue;

    let built: InvestmentRow | null;
    if (colMap) {
      built = buildInvestmentRow(row, colMap, current.securityType);
    } else {
      // The Cash/BDP table's header is split across four physical lines by `extractPdfRows`,
      // so there's no single header row to map - take the description and the first money
      // cell positionally instead.
      built = {
        securityType: current.securityType, symbol: null, description: c0, shares: null,
        price: null, marketValue: parseAmount(valueCell), costBasis: null,
        tradeDate: null, dividendPerShare: null, estAnnualIncome: null,
      };
      current.headerRow = ["Description", "Market Value"];
      current.colMap = { description: 0, marketValue: row.indexOf(valueCell) };
    }
    if (!built) continue;

    const split = splitEtradeSymbol(built.description);
    built.description = split.description;
    built.symbol = built.symbol ?? split.symbol;
    current.rows.push(built);
    current.rawRows.push(row);
    current.totalMarketValue += built.marketValue ?? 0;
  }
  return sections.filter((s) => s.rows.length > 0);
}

/** Maps E*TRADE's printed activity-type wording onto our internal activity taxonomy. */
export function classifyEtradeActivity(raw: string, description: string, amount: number): ActivityType {
  const s = `${raw} ${description}`.toLowerCase();
  if (/^sold|\bsell\b|sold short/.test(raw.toLowerCase())) return "sell";
  if (/^bought|\bbuy\b|purchase/.test(raw.toLowerCase())) return "buy";
  if (/reinvest/.test(s)) return "reinvest";
  if (/dividend/.test(s)) return "dividend";
  if (/interest/.test(s)) return "interest";
  if (/withholding|tax/.test(s)) return "tax";
  if (/\bfee\b|commission|service charge/.test(s)) return "fee";
  if (/transfer (into|out of) account|security transfer|journal/.test(s)) return "transfer";
  if (/automatic (investment|redemption)|bank deposit program|sweep/.test(s)) return "transfer";
  if (/ach|wire|online transfer|electronic transfer|deposit|withdraw/.test(s)) {
    return amount >= 0 ? "deposit" : "withdrawal";
  }
  return "other";
}

/**
 * Parses one of E*TRADE's activity tables. Column counts vary per row (a cash transfer has no
 * settlement date, quantity or price, while a trade has all three), so fields are peeled off
 * the ends rather than read from fixed positions.
 */
function parseEtradeActivityRow(row: string[], periodStart: string, periodEnd: string): ParsedActivity | null {
  const cells = row.map((c) => (c ?? "").trim());
  if (!ETRADE_SHORT_DATE_RE.test(cells[0])) return null;

  const date = resolveEtradeShortDate(cells[0], periodStart, periodEnd);
  if (!date) return null;

  let i = 1;
  let settleDate: string | null = null;
  if (ETRADE_SHORT_DATE_RE.test(cells[i] ?? "")) {
    settleDate = resolveEtradeShortDate(cells[i], periodStart, periodEnd);
    i++;
  }
  const rawActivityType = cells[i] ?? "";
  if (!rawActivityType) return null;

  const rest = cells.slice(i + 1);
  if (rest.length === 0) return null;

  const amountCell = rest[rest.length - 1];
  if (!isEtradeMoney(amountCell)) return null;
  rest.pop();
  const amount = BLANK_CELL_RE.test(amountCell) ? 0 : parseAmount(amountCell);

  let price: number | null = null;
  let quantity: number | null = null;
  if (rest.length >= 2 && ETRADE_PRICE_RE.test(rest[rest.length - 1]) && ETRADE_QUANTITY_RE.test(rest[rest.length - 2])) {
    price = parseAmount(rest.pop()!);
    quantity = parseFloat(rest.pop()!.replace(/,/g, ""));
  } else if (rest.length >= 1 && ETRADE_QUANTITY_RE.test(rest[rest.length - 1])) {
    quantity = parseFloat(rest.pop()!.replace(/,/g, ""));
  }

  const joined = rest.filter(Boolean).join(" — ");
  const split = splitEtradeSymbol(rest[0] ?? "");
  return {
    date, settleDate,
    activityType: classifyEtradeActivity(rawActivityType, joined, amount),
    rawActivityType,
    symbol: split.symbol,
    description: joined || rawActivityType,
    quantity, price, amount,
    costBasis: null, realizedGain: null, acquiredDate: null, term: null,
  };
}

/** Activity tables worth importing. "UNSETTLED PURCHASES/SALES ACTIVITY" is deliberately
 *  excluded - it re-lists trades that already appear in CASH FLOW ACTIVITY BY DATE, so
 *  importing it would double-count every trade made near a period boundary. */
const ETRADE_ACTIVITY_TABLES = [
  /^CASH FLOW ACTIVITY BY DATE$/i,
  /^MONEY MARKET FUND \(MMF\) AND BANK DEPOSIT PROGRAM ACTIVITY$/i,
  /^SECURITY TRANSFERS$/i,
  /^DIVIDENDS, INTEREST AND OTHER INCOME$/i,
  /^CORPORATE ACTIONS$/i,
];
// A table ends at its own "NET ..." total line or at the next major heading. Deliberately does
// NOT include a bare "ACTIVITY" - `extractPdfRows` emits the wrapped "Activity Date" column
// header as a lone "Activity" cell on the line right after the table title.
const ETRADE_ACTIVITY_END_RE = /^(NET\b.*|MESSAGES|UNSETTLED PURCHASES\/SALES ACTIVITY|TRANSFERS, CORPORATE ACTIONS AND ADDITIONAL ACTIVITY|HOLDINGS|ALLOCATION OF ASSETS)$/i;

function parseEtradeActivity(data: string[][], periodStart: string, periodEnd: string): ParsedActivity[] {
  const out: ParsedActivity[] = [];
  for (let i = 0; i < data.length; i++) {
    const c0 = (data[i][0] ?? "").trim();
    if (data[i].length !== 1 || !ETRADE_ACTIVITY_TABLES.some((re) => re.test(c0))) continue;
    for (let j = i + 1; j < data.length; j++) {
      const row = data[j];
      if (ETRADE_ACTIVITY_END_RE.test((row[0] ?? "").trim())) { i = j; break; }
      const parsed = parseEtradeActivityRow(row, periodStart, periodEnd);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/**
 * Reads a labelled Account Summary figure. E*TRADE prints most labels and their values on one
 * line, but wraps a few ("Change in Value", "Net Credits/Debits/Transfers") so the values land
 * on the following line - with the market-value chart's axis labels interleaved around them.
 * Hence the lookahead for the first following line that is entirely money cells.
 */
function etradeSummaryValues(data: string[][], label: string, lookahead = 3): number[] {
  const target = label.toLowerCase();
  for (const [i, row] of data.entries()) {
    if ((row[0] ?? "").trim().toLowerCase() !== target) continue;
    const inline = row.slice(1).filter((c) => isEtradeMoney(c));
    if (inline.length > 0) return inline.map((c) => (BLANK_CELL_RE.test(c.trim()) ? 0 : parseAmount(c)));
    for (let j = i + 1; j <= i + lookahead && j < data.length; j++) {
      const next = data[j];
      if (next.length > 0 && next.every((c) => isEtradeMoney(c))) {
        return next.map((c) => (BLANK_CELL_RE.test(c.trim()) ? 0 : parseAmount(c)));
      }
    }
    return [];
  }
  return [];
}

function etradeSummaryValue(data: string[][], label: string, index = 0): number | null {
  const values = etradeSummaryValues(data, label);
  return index < values.length ? values[index] : null;
}

/** The account's own name/number, printed under the client name on every detail page. */
function parseEtradeAccountIdentity(data: string[][]): { label: string | null; number: string | null } {
  for (const [i, row] of data.entries()) {
    const c0 = (row[0] ?? "").trim();
    if (row.length !== 1 || !/^\d{3}-\d{6}-\d{3}$/.test(c0)) continue;
    const prev = (data[i - 1]?.[0] ?? "").trim();
    return { label: prev && data[i - 1].length === 1 ? prev : null, number: c0 };
  }
  return { label: null, number: null };
}

/**
 * Parses an E*TRADE (Morgan Stanley) "CLIENT STATEMENT" PDF: portfolio holdings, the period's
 * transaction activity, and the Account Summary period totals (beginning/ending value, cash
 * flows, income, and realized/unrealized gain).
 *
 * The statement prints per-lot cost basis only online, not on the statement itself, so a sale's
 * realized gain is available at the account level (GAIN/(LOSS) SUMMARY -> `ParsedSummary`) but
 * never per activity row. Returns null if the file isn't an E*TRADE client statement.
 */
export function parseEtradeStatement(data: string[][]): ParsedInvestment | null {
  if (!looksLikeEtradeStatement(data)) return null;
  const period = parseEtradePeriod(data);
  if (!period) return null;

  const sections = parseEtradeHoldings(data);
  const activity = parseEtradeActivity(data, period.start, period.end);
  const identity = parseEtradeAccountIdentity(data);

  const shortTerm = etradeSummaryValues(data, "Short-Term Gain");
  const longTerm = etradeSummaryValues(data, "Long-Term Gain");
  const sumAt = (index: number): number | null => {
    const parts = [shortTerm[index], longTerm[index]].filter((v): v is number => v !== undefined);
    return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
  };

  const summary: ParsedSummary = {
    periodStart: period.start,
    periodEnd: period.end,
    beginningValue: etradeSummaryValue(data, "TOTAL BEGINNING VALUE"),
    endingValue: etradeSummaryValue(data, "TOTAL ENDING VALUE"),
    changeInValue: etradeSummaryValue(data, "Change in Value"),
    cashBalance: etradeSummaryValue(data, "CLOSING CASH, BDP, MMFs"),
    deposits: etradeSummaryValue(data, "Credits"),
    withdrawals: etradeSummaryValue(data, "Debits"),
    transfers: etradeSummaryValue(data, "Security Transfers"),
    income: etradeSummaryValue(data, "TOTAL INCOME AND DISTRIBUTIONS"),
    dividends: null,
    interest: null,
    fees: null,
    realizedGain: sumAt(0),
    realizedGainYtd: sumAt(1),
    unrealizedGain: sumAt(2),
  };

  if (sections.length === 0 && activity.length === 0) return null;
  return {
    asOfDate: period.end,
    sections,
    activity,
    summary,
    accountLabel: identity.label,
    accountNumber: identity.number,
  };
}

// ─── Format dispatch ───────────────────────────────────────────────────────────

export type InvestmentFormat = "thrivent" | "fidelity" | "principal" | "etrade" | "wells-fargo";

/**
 * Detects the format of an investment CSV/XLSX/PDF based on distinctive header names or
 * statement markers. Unrecognized files fall through to the Wells Fargo Advisors sectioned
 * parser, which is the most generic ("title row -> header row -> data rows -> total row").
 */
export function detectInvestmentFormat(data: string[][]): InvestmentFormat {
  // Look for a flat header row in the first 3 rows
  for (const row of data.slice(0, 3)) {
    const norm = row.map((h) => (h ?? "").toLowerCase().trim());
    if (norm.includes("security description") && norm.includes("security type")) return "thrivent";
    if (norm.includes("cost basis total") && norm.includes("account name")) return "fidelity";
  }
  // The PDF statement formats put their tables several pages in (after a cover page, account
  // snapshot and disclosure pages), so - unlike the flat CSV formats above - they can't be
  // detected from the first few rows alone; scan the whole extracted PDF text instead.
  if (looksLikePrincipalStatement(data)) return "principal";
  if (looksLikeEtradeStatement(data)) return "etrade";
  return "wells-fargo";
}

/** Human-readable list of supported formats, shown when detection fails. */
export const SUPPORTED_INVESTMENT_FORMATS =
  "Wells Fargo Advisors (XLSX), Fidelity and Thrivent (CSV), Principal (PDF quarterly statement), and E*TRADE / Morgan Stanley (PDF client statement)";

/**
 * Dispatcher: detects the brokerage export format and routes to the appropriate parser.
 * Returns null if no supported format is detected.
 */
export function parseInvestmentWorkbook(data: string[][]): ParsedInvestment | null {
  const fmt = detectInvestmentFormat(data);
  if (fmt === "thrivent")  return parseThriventPositionsCSV(data);
  if (fmt === "fidelity")  return parseFidelityPositionsCSV(data);
  if (fmt === "principal") return parsePrincipalStatement(data);
  if (fmt === "etrade")    return parseEtradeStatement(data);

  // Wells Fargo Advisors: sectioned format
  const asOfDate = detectStatementDate(data) ?? todayIso();
  const sections: InvestmentSection[] = [];

  let i = 0;
  while (i < data.length) {
    const row = data[i];
    const col0 = (row[0] ?? "").trim();
    const restBlank = row.slice(1).every((c) => !c || !c.trim());
    const isTotalRow = /^total\b/i.test(col0);

    if (col0 && restBlank && !isTotalRow) {
      const headerRow = data[i + 1];
      const looksLikeHeader = headerRow?.some((c) => (c ?? "").toLowerCase().trim() === "description");
      if (looksLikeHeader) {
        const title = col0;
        const securityType = classifySection(title);
        const colMap = buildHoldingHeaderMap(headerRow);
        const rows: InvestmentRow[] = [];
        const rawRows: string[][] = [];
        let j = i + 2;
        for (; j < data.length; j++) {
          const dataRow = data[j];
          const dCol0 = (dataRow[0] ?? "").trim();
          if (/^total\b/i.test(dCol0)) { j++; break; }
          if (!dCol0 && dataRow.every((c) => !c || !c.trim())) continue; // blank separator row
          if (ASSET_CLASS_LABELS.has(dCol0.toLowerCase())) continue; // asset-class sub-heading

          const built = buildInvestmentRow(dataRow, colMap, securityType);
          if (!built) continue;
          rows.push(built);
          rawRows.push(dataRow);
        }
        if (rows.length > 0) {
          sections.push({
            title, securityType, headerRow, rawRows, colMap, rows,
            totalMarketValue: rows.reduce((s, r) => s + (r.marketValue ?? 0), 0),
          });
        }
        i = j;
        continue;
      }
    }
    i++;
  }

  return sections.length > 0 ? positionsOnly(asOfDate, sections) : null;
}
