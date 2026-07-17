import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  Calendar, Tag, DollarSign, BarChart2, Upload, Loader2, CheckCircle2, Info,
  Landmark, CreditCard, TrendingUp,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  getDb, applyCategorizationRules, recomputeCalculatedBalances,
  listAccountsForProfile, resolveAccountId,
} from "@/lib/db";
import type { AccountChoice } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { CategorizationRule, SecurityType, Account } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import { takePendingImportFiles } from "@/lib/pendingImport";
import InfoTooltip from "@/components/InfoTooltip";
import ManageAccountsPanel from "@/components/ManageAccountsPanel";

type Step =
  | "upload" | "checking"
  | "wizard:account"
  | "wizard:data" | "wizard:date" | "wizard:desc" | "wizard:amount" | "wizard:balance" | "wizard:preview"
  | "wizard:investment-preview"
  | "importing" | "done";

/** Linear order used for "Back" navigation - separate from WIZARD_STEPS (which only drives the
 *  numbered bubble bar for the bank/credit column-mapping flow). */
const STEP_ORDER: Step[] = [
  "upload", "wizard:account", "wizard:data", "wizard:date", "wizard:desc",
  "wizard:amount", "wizard:balance", "wizard:preview",
];

/** Returns the step a "Back" button on `step` should navigate to. */
function backTargetFor(step: Step): Step {
  if (step === "wizard:investment-preview") return "wizard:account";
  const idx = STEP_ORDER.indexOf(step);
  return idx > 0 ? STEP_ORDER[idx - 1] : "upload";
}

type ImportKind = "bank" | "credit" | "investment";

interface ColMap {
  dateCol: number;
  descCol: number;
  amountCol: number;
  typeCol: number; // -1 = no transaction-type column
  balanceCol: number; // -1 = no running balance column
  invertAmounts: boolean; // true for banks that export expenses as positive (Discover, Amex)
}

interface BankPreset {
  name: string;
  dateKeywords: string[];
  descKeywords: string[];
  amountKeywords: string[];
  typeKeywords?: string[];
  balanceKeywords?: string[];
  invertAmounts?: boolean;
  note?: string;
  /** Distinctive column names (beyond date/desc/amount) used to auto-detect this preset
   *  with confidence, even if the user never manually selects it. */
  fingerprintKeywords?: string[];
}

const BANK_PRESETS: Record<string, BankPreset> = {
  "chase-checking": {
    name: "Chase (Checking / Savings)",
    dateKeywords: ["posting date"],
    descKeywords: ["description"],
    amountKeywords: ["amount"],
    balanceKeywords: ["balance"],
  },
  "chase-credit": {
    name: "Chase (Credit Card)",
    dateKeywords: ["transaction date"],
    descKeywords: ["description"],
    amountKeywords: ["amount"],
  },
  "capital-one": {
    name: "Capital One",
    dateKeywords: ["transaction date"],
    descKeywords: ["description"],
    amountKeywords: ["debit"],
    typeKeywords: [],
    note: "Capital One uses separate Debit and Credit columns. Select the Debit column as the amount - expenses will be positive numbers.",
    invertAmounts: true,
  },
  "wells-fargo": {
    name: "Wells Fargo",
    dateKeywords: ["date"],
    descKeywords: ["description"],
    amountKeywords: ["amount"],
    balanceKeywords: ["balance"],
  },
  "bank-of-america": {
    name: "Bank of America",
    dateKeywords: ["date"],
    descKeywords: ["description"],
    amountKeywords: ["amount"],
    balanceKeywords: ["running bal"],
    note: "Bank of America statements include summary rows at the top - Compass skips them automatically.",
  },
  "navy-federal": {
    name: "Navy Federal",
    dateKeywords: ["tran date"],
    descKeywords: ["description"],
    amountKeywords: ["debit"],
    invertAmounts: true,
    note: "Navy Federal has header rows before the transaction table - Compass skips them automatically.",
  },
  "discover": {
    name: "Discover",
    dateKeywords: ["trans. date", "trans date"],
    descKeywords: ["description"],
    amountKeywords: ["amount"],
    invertAmounts: true,
    note: "Discover exports expenses as positive numbers. Compass will flip the signs automatically.",
  },
  "amex": {
    name: "American Express",
    dateKeywords: ["date"],
    descKeywords: ["description"],
    amountKeywords: ["amount"],
    invertAmounts: true,
    note: "Amex exports expenses as positive numbers. Compass will flip the signs automatically.",
    fingerprintKeywords: ["extended details", "appears on your statement as"],
  },
  "venmo": {
    name: "Venmo",
    dateKeywords: ["datetime"],
    descKeywords: ["note"],
    amountKeywords: ["amount (total)"],
    note: "Use the full CSV export from Venmo's website (not the app). Transfers to your bank may appear as income.",
  },
  "cash-app": {
    name: "Cash App",
    dateKeywords: ["date"],
    descKeywords: ["name"],
    amountKeywords: ["net amount"],
  },
  "paypal": {
    name: "PayPal",
    dateKeywords: ["date"],
    descKeywords: ["name"],
    amountKeywords: ["net"],
    note: "Export a filtered USD-only CSV from PayPal for best results.",
  },
};

function applyPreset(preset: BankPreset, headers: string[]): Partial<ColMap> {
  const h = headers.map((s) => s.toLowerCase().trim());
  const findByKeywords = (keywords: string[]): number => {
    for (const kw of keywords) {
      const idx = h.findIndex((s) => s.includes(kw));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const result: Partial<ColMap> = {};
  const d = findByKeywords(preset.dateKeywords);
  if (d >= 0) result.dateCol = d;
  const desc = findByKeywords(preset.descKeywords);
  if (desc >= 0) result.descCol = desc;
  const amt = findByKeywords(preset.amountKeywords);
  if (amt >= 0) result.amountCol = amt;
  if (preset.typeKeywords && preset.typeKeywords.length > 0) {
    const t = findByKeywords(preset.typeKeywords);
    result.typeCol = t;
  }
  if (preset.balanceKeywords) {
    const b = findByKeywords(preset.balanceKeywords);
    result.balanceCol = b;
  }
  if (preset.invertAmounts !== undefined) result.invertAmounts = preset.invertAmounts;
  return result;
}

/**
 * Auto-detects a bank preset purely from distinctive column names, so imports work correctly
 * (e.g. Amex's expenses-as-positive sign convention) even if the user never clicks the preset
 * button. Only presets with a `fingerprintKeywords` list participate, to avoid false positives
 * from generic column names shared across many banks (date/description/amount).
 */
function detectPresetByFingerprint(headers: string[]): string | null {
  const norm = headers.map((h) => (h ?? "").toLowerCase());
  for (const [id, preset] of Object.entries(BANK_PRESETS)) {
    if (!preset.fingerprintKeywords || preset.fingerprintKeywords.length === 0) continue;
    if (preset.fingerprintKeywords.every((kw) => norm.some((h) => h.includes(kw)))) return id;
  }
  return null;
}

interface ParsedData {
  headers: string[];
  rows: string[][];
}

interface Summary {
  imported: number;
  skipped: number;
}

interface ImportSession {
  id: number;
  filename: string;
  imported_at: string;
  row_count: number;
  skipped_count: number;
  kind: "bank" | "investment";
}

const WIZARD_STEPS = [
  { step: "wizard:account" as const, num: 1, label: "Account" },
  { step: "wizard:data"    as const, num: 2, label: "Find Data" },
  { step: "wizard:date"    as const, num: 3, label: "Date" },
  { step: "wizard:desc"    as const, num: 4, label: "Description" },
  { step: "wizard:amount"  as const, num: 5, label: "Amount" },
  { step: "wizard:balance" as const, num: 6, label: "Balance" },
  { step: "wizard:preview" as const, num: 7, label: "Preview" },
];

function wizardNum(step: string): number {
  return WIZARD_STEPS.find((s) => s.step === step)?.num ?? 0;
}

function computeHeaderSig(headers: string[]): string {
  return [...headers].map((h) => h.toLowerCase().trim()).sort().join("|");
}

/** Keywords used to identify a real transaction header row. */
const HEADER_KEYWORDS = [
  "date", "description", "amount", "payee", "debit", "credit",
  "balance", "memo", "transaction", "posting",
];

/**
 * Scan the first 15 rows and return the index of the row that looks most
 *
 * Handles formats like Bank of America that prepend a summary block before
 * the real transaction table.
 */
function findRealHeaderRow(data: string[][]): number {
  for (let i = 0; i < Math.min(data.length, 15); i++) {
    const row = data[i].map((c) => (c ?? "").toLowerCase().trim());
    const hits = row.filter((cell) =>
      HEADER_KEYWORDS.some((kw) => cell.includes(kw))
    ).length;
    if (hits >= 2) return i;
  }
  return 0;
}

/** Slice raw CSV data at `skip` and return {headers, rows}, or null if too short. */
function deriveHeaders(data: string[][], skip: number): ParsedData | null {
  const sliced = data.slice(skip);
  if (sliced.length < 2) return null;
  const [first, ...rest] = sliced;
  const looksLikeHeader = first.some((c) =>
    isNaN(parseFloat((c ?? "").replace(/[$,]/g, "")))
  );
  const headers = looksLikeHeader ? first : first.map((_, i) => `Column ${i + 1}`);
  const rows    = looksLikeHeader ? rest : sliced;
  return { headers, rows };
}

function autoDetect(headers: string[]): ColMap {
  const h = headers.map((s) => s.toLowerCase());
  const find = (...terms: string[]) =>
    Math.max(0, h.findIndex((s) => terms.some((t) => s.includes(t))));
  // typeCol: look for a column whose name contains "type" but NOT "amount",
  // as used by banks that have separate "Transaction Type" (Debit/Credit) columns.
  const typeCol = h.findIndex((s) => s.includes("type") && !s.includes("amount"));
  const balanceCol = h.findIndex((s) => s.includes("balance"));
  return {
    dateCol: find("date"),
    descCol: find("description", "payee", "name", "merchant", "memo"),
    amountCol: find("amount", "debit", "credit"),
    typeCol,
    balanceCol,
    invertAmounts: false,
  };
}

function parseAmount(s: string): number {
  const neg = s.includes("(") || s.trimStart().startsWith("-");
  const n = parseFloat(s.replace(/[$,\s()]/g, ""));
  return isNaN(n) ? 0 : neg ? -Math.abs(n) : Math.abs(n);
}

function parseDate(s: string): string {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().split("T")[0];
}

async function hashRow(row: string[]): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(row.join("||"))
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Scans the date column and returns the most common YYYY-MM, preferring the most recent on a tie. */
function detectDominantMonth(rows: string[][], dateColIdx: number): string | null {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const raw = row[dateColIdx];
    if (!raw) continue;
    const iso = parseDate(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const ym = iso.slice(0, 7);
    counts[ym] = (counts[ym] ?? 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  // Sort by count desc, then by month desc (most recent wins tie)
  entries.sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
  return entries[0][0];
}

/** Returns all unique YYYY-MM values found in the date column, sorted ascending. */
function detectAllMonths(rows: string[][], dateColIdx: number): string[] {
  const months = new Set<string>();
  for (const row of rows) {
    const raw = row[dateColIdx];
    if (!raw) continue;
    const iso = parseDate(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    months.add(iso.slice(0, 7));
  }
  return [...months].sort();
}

// ─── Investment portfolio import (Wells Fargo Advisors "Portfolio Positions") ─

interface InvestmentRow {
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

interface InvestmentSection {
  title: string;
  securityType: SecurityType;
  headerRow: string[];
  rawRows: string[][];
  colMap: Record<string, number>;
  rows: InvestmentRow[];
  totalMarketValue: number;
}

interface ParsedInvestment {
  asOfDate: string;
  sections: InvestmentSection[];
}

/** Maps a section title (as printed in the export) to a broad security type. */
function classifySection(title: string): SecurityType {
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
const ASSET_CLASS_LABELS = new Set([
  "common stock", "preferred stock", "adr", "american depositary receipt",
  "exchange traded fund", "exchange-traded fund", "closed end fund",
  "mutual fund", "money market fund", "municipal bond", "corporate bond",
  "government bond", "treasury", "reit", "master limited partnership", "mlp",
  "warrant", "warrants", "option", "options", "unit investment trust",
]);

/** Column-name aliases (lowercased, trimmed) mapped to a canonical field. */
const HOLDING_HEADER_ALIASES: Record<string, string[]> = {
  description: ["description"],
  symbol: ["symbol", "symbol/cusip"],
  shares: ["shares", "quantity"],
  price: ["last price ($)", "estimated price", "price"],
  marketValue: ["market value", "estimated market value"],
  costBasis: ["cost basis"],
  tradeDate: ["trade date1", "trade date"],
  dividendPerShare: ["dividend"],
  estAnnualIncome: ["est. annual income"],
};

/** Field order + display labels for the manual column-remap UI. */
const HOLDING_FIELDS: { key: string; label: string }[] = [
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

function buildHoldingHeaderMap(headerRow: string[]): Record<string, number> {
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

function cellOrNull(row: string[], idx: number | undefined): string | null {
  if (idx === undefined) return null;
  const v = (row[idx] ?? "").trim();
  return !v || v.toUpperCase() === "N/A" ? null : v;
}

function parseMoneyOrNull(row: string[], idx: number | undefined): number | null {
  const v = cellOrNull(row, idx);
  return v === null ? null : parseAmount(v);
}

function parseSharesOrNull(row: string[], idx: number | undefined): number | null {
  const v = cellOrNull(row, idx);
  if (v === null) return null;
  const n = parseFloat(v.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

function parseTradeDateOrNull(row: string[], idx: number | undefined): string | null {
  const v = cellOrNull(row, idx);
  if (v === null) return null;
  const iso = parseDate(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/** Builds a single holding row from a raw data row using a (possibly user-edited) column map. */
function buildInvestmentRow(dataRow: string[], colMap: Record<string, number>, securityType: SecurityType): InvestmentRow | null {
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
function columnFillCount(rawRows: string[][], idx: number): number {
  return rawRows.reduce((n, row) => n + ((row[idx] ?? "").toString().trim() ? 1 : 0), 0);
}

/** True when none of a section's value fields (everything but description/symbol) has any data. */
function sectionHasNoValueData(rows: InvestmentRow[]): boolean {
  return rows.every((r) =>
    r.shares === null && r.price === null && r.marketValue === null && r.costBasis === null &&
    r.tradeDate === null && r.dividendPerShare === null && r.estAnnualIncome === null
  );
}

/** Detects a brokerage statement's "Priced as of ..." date from the first few rows. */
function detectStatementDate(rows: string[][]): string | null {
  for (const row of rows.slice(0, 6)) {
    for (const cell of row) {
      if (!cell) continue;
      const m = cell.match(/priced as of.*?(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (m) { const iso = parseDate(m[1]); return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null; }
    }
  }
  return null;
}

/** Classify a Fidelity/Thrivent security-type string to our internal SecurityType. */
function classifyFlatSecurityType(raw: string): SecurityType {
  const s = raw.trim().toLowerCase();
  if (s.includes("mutual fund") || s.includes("money market")) return "mutual_fund";
  if (s.includes("etf") || s.includes("exchange traded")) return "etf";
  if (s.includes("stock") || s.includes("common stock")) return "stock";
  if (s.includes("cash")) return "cash";
  return "other";
}

/**
 * Builds a synthetic InvestmentSection from a flat array of rows, grouped by a
 * derived title. Used by the Fidelity and Thrivent parsers.
 */
function buildFlatSection(
  title: string,
  securityType: SecurityType,
  headerRow: string[],
  colMap: Record<string, number>,
  rawRows: string[][]
): InvestmentSection {
  const rows = rawRows
    .map((r) => buildInvestmentRow(r, colMap, securityType))
    .filter((r): r is InvestmentRow => r !== null);
  return {
    title, securityType, headerRow, rawRows, colMap, rows,
    totalMarketValue: rows.reduce((s, r) => s + (r.marketValue ?? 0), 0),
  };
}

/**
 * Parses a Fidelity brokerage positions export (flat CSV, one row per holding).
 * Groups results into sections by Security Type.
 * Returns null if the file doesn't look like a Fidelity export.
 *
 * Expected headers (0-based indices used due to duplicate "Currency Code" names):
 *   3  Security Description, 5  Recent Quantity, 6  Recent Price,
 *   10 Recent Market Value,  15 Cost,            27 Security Type,  29 Symbol
 */
function parseFidelityCSV(data: string[][]): ParsedInvestment | null {
  const headerRow = data[0];
  if (!headerRow) return null;
  const norm = headerRow.map((h) => (h ?? "").toLowerCase().trim());
  if (!norm.includes("security description") || !norm.includes("security type")) return null;

  const today = new Date().toISOString().split("T")[0];

  // Build a simple index map using header names where unique, falling back to known indices
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
    const section = buildFlatSection(title, securityType, headerRow, colMap, rows);
    if (section.rows.length > 0) sections.push(section);
  }

  return sections.length > 0 ? { asOfDate: today, sections } : null;
}

/**
 * Parses a Thrivent brokerage positions export (flat CSV, one row per holding,
 * potentially spanning multiple accounts). Groups results into one section per
 * account name.
 * Returns null if the file doesn't look like a Thrivent export.
 *
 * Expected headers: Account number, Account name, Symbol, Description, Quantity,
 *   Last price, Last price change, Current value, ..., Cost basis total, Average cost basis, Type
 */
function parseThriventCSV(data: string[][]): ParsedInvestment | null {
  const headerRow = data[0];
  if (!headerRow) return null;
  const norm = headerRow.map((h) => (h ?? "").toLowerCase().trim());
  if (!norm.includes("cost basis total") || !norm.includes("account name")) return null;

  const today = new Date().toISOString().split("T")[0];

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
    // Strip trailing quote/apostrophe artifacts sometimes present in Thrivent exports
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
    const section = buildFlatSection(account, securityType, headerRow, colMap, rows);
    if (section.rows.length > 0) sections.push(section);
  }

  return sections.length > 0 ? { asOfDate: today, sections } : null;
}

/**
 * Detects the format of an investment CSV/XLSX based on distinctive header names.
 * Returns "fidelity" | "thrivent" | "wells-fargo".
 */
function detectInvestmentFormat(data: string[][]): "fidelity" | "thrivent" | "wells-fargo" {
  // Look for a flat header row in the first 3 rows
  for (const row of data.slice(0, 3)) {
    const norm = row.map((h) => (h ?? "").toLowerCase().trim());
    if (norm.includes("security description") && norm.includes("security type")) return "fidelity";
    if (norm.includes("cost basis total") && norm.includes("account name")) return "thrivent";
  }
  return "wells-fargo";
}

/**
 * Dispatcher: detects the brokerage export format and routes to the appropriate
 * parser. Supports Wells Fargo Advisors (sectioned XLSX), Fidelity (flat CSV),
 * and Thrivent (flat CSV, multi-account).
 * Returns null if no supported format is detected.
 */
function parseInvestmentWorkbook(data: string[][]): ParsedInvestment | null {
  const fmt = detectInvestmentFormat(data);
  if (fmt === "fidelity")  return parseFidelityCSV(data);
  if (fmt === "thrivent")  return parseThriventCSV(data);

  // Wells Fargo Advisors: sectioned format
  const asOfDate = detectStatementDate(data) ?? new Date().toISOString().split("T")[0];
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

  return sections.length > 0 ? { asOfDate, sections } : null;
}

const IMPORT_KINDS: { id: ImportKind; label: string; hint: string; Icon: typeof Landmark }[] = [
  { id: "bank", label: "Bank Statement", hint: "Checking or savings CSV/XLSX export", Icon: Landmark },
  { id: "credit", label: "Credit Card Statement", hint: "Credit card CSV/XLSX export", Icon: CreditCard },
  { id: "investment", label: "Investment / Brokerage", hint: "Portfolio positions export (stocks, ETFs)", Icon: TrendingUp },
];

export default function ImportPage() {
  const navigate = useNavigate();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;
  const [step, setStep] = useState<Step>("upload");
  const [importKind, setImportKind] = useState<ImportKind | null>(null);
  const [rawData, setRawData] = useState<string[][] | null>(null);
  const [skipRows, setSkipRows] = useState(0);
  const [parsed, setParsed] = useState<ParsedData | null>(null);
  const [invParsed, setInvParsed] = useState<ParsedInvestment | null>(null);
  const [colMapOverrides, setColMapOverrides] = useState<Record<string, Record<string, number>>>({});
  const [fixColumnsOpen, setFixColumnsOpen] = useState<Set<string>>(new Set());
  const [accountChoice, setAccountChoice] = useState<AccountChoice | null>(null);
  const [existingAccountsForType, setExistingAccountsForType] = useState<Account[]>([]);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [currentFilename, setCurrentFilename] = useState("");
  const [colMap, setColMap] = useState<ColMap>({ dateCol: 0, descCol: 1, amountCol: 2, typeCol: -1, balanceCol: -1, invertAmounts: false });
  const [currentBalanceInput, setCurrentBalanceInput] = useState("");
  const [profileFound, setProfileFound] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetMonth, setTargetMonth] = useState(currentYM);
  const [importHistory, setImportHistory] = useState<ImportSession[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [wizardDir, setWizardDir] = useState<"forward" | "back">("forward");
  const [batchQueue, setBatchQueue] = useState<File[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [batchAutoMode, setBatchAutoMode] = useState(false);
  const [totalBatchCount, setTotalBatchCount] = useState(0);
  const batchSavedColMapRef = useRef<ColMap | null>(null);

  // Auto-detect the dominant month whenever the parsed data or date column changes
  const detectedMonth = useMemo(
    () => (parsed ? detectDominantMonth(parsed.rows, colMap.dateCol) : null),
    [parsed, colMap.dateCol]
  );
  const allMonths = useMemo(
    () => (parsed ? detectAllMonths(parsed.rows, colMap.dateCol) : []),
    [parsed, colMap.dateCol]
  );
  const isMultiMonth = allMonths.length > 1;
  useEffect(() => {
    if (detectedMonth) setTargetMonth(detectedMonth);
  }, [detectedMonth]);

  // On entering the "which account" step, load this profile's existing accounts of the
  // relevant type and suggest a match based on the detected bank preset/institution name -
  // but never clobber a choice the user already made (e.g. navigating back to this step).
  useEffect(() => {
    if (step !== "wizard:account") return;
    const accountType = importKind === "credit" ? "credit" : importKind === "investment" ? "investment" : "checking";
    (async () => {
      try {
        const accounts = await listAccountsForProfile(profileId, accountType);
        setExistingAccountsForType(accounts);
        if (accountChoice) return;
        const detectedName = selectedPresetId ? BANK_PRESETS[selectedPresetId]?.name ?? null : null;
        if (detectedName) {
          const needle = detectedName.toLowerCase();
          const match = accounts.find(
            (a) => a.name.toLowerCase().includes(needle) || a.institution.toLowerCase().includes(needle)
          );
          if (match) {
            setAccountChoice({ mode: "existing", accountId: match.id, name: match.name });
            return;
          }
        }
        setAccountChoice({
          mode: "new",
          name: detectedName ?? (accountType === "investment" ? "Investment Account" : accountType === "credit" ? "New Credit Card" : "New Account"),
          institution: detectedName ?? "Imported",
        });
      } catch { /* leave account choice as-is */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // When there's no balance column, prefill the account's current balance anchor (the real
  // balance as of the day it was entered) so returning to the step shows what's already saved.
  useEffect(() => {
    if (step !== "wizard:balance" || colMap.balanceCol >= 0) return;
    if (!accountChoice || accountChoice.mode !== "existing") { setCurrentBalanceInput(""); return; }
    (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<{ balance_anchor_cents: number | null }[]>(
          "SELECT balance_anchor_cents FROM accounts WHERE id=?",
          [accountChoice.accountId]
        );
        const cents = rows[0]?.balance_anchor_cents;
        setCurrentBalanceInput(cents != null ? (cents / 100).toFixed(2) : "");
      } catch { /* leave blank */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);


  // Re-derives each section's holding rows after applying any manual column-map overrides
  // the user made in the "Fix columns" panel, falling back to the auto-detected mapping.
  const derivedSections = useMemo(() => {
    if (!invParsed) return [];
    return invParsed.sections.map((section) => {
      const override = colMapOverrides[section.title];
      if (!override) return section;
      const mergedColMap: Record<string, number> = { ...section.colMap };
      for (const [field, idx] of Object.entries(override)) {
        if (idx < 0) delete mergedColMap[field];
        else mergedColMap[field] = idx;
      }
      const rows = section.rawRows
        .map((raw) => buildInvestmentRow(raw, mergedColMap, section.securityType))
        .filter((r): r is InvestmentRow => r !== null);
      return {
        ...section,
        colMap: mergedColMap,
        rows,
        totalMarketValue: rows.reduce((s, r) => s + (r.marketValue ?? 0), 0),
      };
    });
  }, [invParsed, colMapOverrides]);

  // Grand totals across every (possibly remapped) section of a parsed investment workbook.
  const invTotals = useMemo(() => {
    let marketValue = 0, estAnnualIncome = 0, count = 0;
    for (const section of derivedSections) {
      for (const row of section.rows) {
        marketValue += row.marketValue ?? 0;
        estAnnualIncome += row.estAnnualIncome ?? 0;
        count++;
      }
    }
    return { marketValue, estAnnualIncome, count };
  }, [derivedSections]);

  const loadHistory = useCallback(async () => {
    const db = await getDb();
    const rows = await db.select<ImportSession[]>(
      `SELECT id, filename, imported_at, row_count, skipped_count, COALESCE(kind, 'bank') as kind
       FROM import_sessions WHERE profile_id=?
       ORDER BY imported_at DESC LIMIT 15`,
      [profileId]
    );
    setImportHistory(rows);
  }, [profileId]);

  useEffect(() => { loadHistory().catch(console.error); }, [loadHistory]);

  // On mount: drain any files queued by other pages (e.g. CSV drop on Transactions tab)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pending = takePendingImportFiles();
    if (pending.length === 0) return;
    const [first, ...rest] = pending;
    setBatchQueue(rest);
    processFile(first);
  }, []); // intentionally empty - runs once on mount only

  /** Navigate between wizard steps with direction tracking for the slide animation. */
  const wizardGo = (target: Step, dir: "forward" | "back" = "forward") => {
    setWizardDir(dir);
    setStep(target);
    setMaxStepReached((m) => Math.max(m, wizardNum(target)));
  };

  const undoImport = async (sessionId: number) => {
    const db = await getDb();
    const session = importHistory.find((s) => s.id === sessionId);
    if (session?.kind === "investment") {
      await db.execute("DELETE FROM holdings WHERE import_session_id=?", [sessionId]);
    } else {
      // Recompute the affected account(s)' running balances after removing this batch of
      // transactions, so Overview/Dashboard/Trends don't keep showing stale balances.
      const affectedAccounts = await db.select<{ account_id: number }[]>(
        "SELECT DISTINCT account_id FROM transactions WHERE import_session_id=?",
        [sessionId]
      );
      await db.execute("DELETE FROM transactions WHERE import_session_id=?", [sessionId]);
      for (const { account_id } of affectedAccounts) {
        await recomputeCalculatedBalances(account_id);
      }
    }
    await db.execute("DELETE FROM import_sessions WHERE id=?", [sessionId]);
    setConfirmDeleteId(null);
    await loadHistory();
  };

  /** Writes every parsed holding row into the `holdings` table as a new dated snapshot. */
  const handleInvestmentImport = async (profileIdOverride?: number) => {
    if (!invParsed) return;
    const targetProfileId = profileIdOverride ?? profileId;
    setStep("importing");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const db = await getDb();
      const accountId = await resolveAccountId(
        targetProfileId,
        "investment",
        accountChoice ?? { mode: "new", name: "Investment Account", institution: "Imported" }
      );
      // Once a new account is actually created, lock the choice onto that concrete row -
      // otherwise a batch of files would each independently create ANOTHER "new" account
      // instead of sharing the one just created.
      setAccountChoice((prev) => (prev?.mode === "existing" && prev.accountId === accountId ? prev : { mode: "existing", accountId, name: prev?.name ?? "Investment Account" }));
      const sessionResult = await db.execute(
        "INSERT INTO import_sessions (filename, row_count, skipped_count, profile_id, kind) VALUES (?, 0, 0, ?, 'investment')",
        [currentFilename, targetProfileId]
      );
      const sessionId = sessionResult.lastInsertId as number;

      let imported = 0;
      for (const section of derivedSections) {
        for (const row of section.rows) {
          await db.execute(
            `INSERT INTO holdings
               (account_id, profile_id, import_session_id, as_of_date, security_type, symbol, description,
                shares, price_cents, market_value_cents, cost_basis_cents, trade_date,
                dividend_per_share_cents, est_annual_income_cents)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              accountId, targetProfileId, sessionId, invParsed.asOfDate, row.securityType, row.symbol, row.description,
              row.shares,
              row.price !== null ? Math.round(row.price * 100) : null,
              row.marketValue !== null ? Math.round(row.marketValue * 100) : null,
              row.costBasis !== null ? Math.round(row.costBasis * 100) : null,
              row.tradeDate,
              row.dividendPerShare !== null ? Math.round(row.dividendPerShare * 100) : null,
              row.estAnnualIncome !== null ? Math.round(row.estAnnualIncome * 100) : null,
            ]
          );
          imported++;
        }
      }

      await db.execute("UPDATE import_sessions SET row_count=? WHERE id=?", [imported, sessionId]);
      setSummary({ imported, skipped: 0 });
      await loadHistory();
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("wizard:investment-preview");
    }
  };

  const processFile = useCallback((file: File) => {
    setError(null);
    setStep("checking");
    setCurrentFilename(file.name);

    const isXlsx = /\.xlsx?$/i.test(file.name);
    if (isXlsx) {
      file.arrayBuffer().then((buf) => {
        try {
          const wb = XLSX.read(buf, { type: "array", cellDates: false });
          // raw:false returns each cell's formatted display text (e.g. "$1,234.56", "07/15/2026")
          // instead of the underlying number/date serial, matching what our string-based
          // parsers (parseAmount/parseDate) expect. Every cell is also defensively coerced to
          // a string so a stray number/Date object can never crash downstream .trim() calls.
          const sheetToRows = (name: string): string[][] => {
            const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false }) as unknown[][];
            return raw.map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))));
          };

          let data: string[][];
          if (importKind === "investment" && wb.SheetNames.length > 1) {
            // Some brokerage exports include multiple tabs (Summary, Positions, Activity...) -
            // use whichever sheet actually contains a recognizable Portfolio Positions table.
            const withPositions = wb.SheetNames.find((name) => parseInvestmentWorkbook(sheetToRows(name)) !== null);
            data = sheetToRows(withPositions ?? wb.SheetNames[0]);
          } else {
            data = sheetToRows(wb.SheetNames[0]);
          }

          if (data.length < 2) {
            setError("Spreadsheet appears empty or has too few rows.");
            setStep("upload");
            return;
          }
          if (importKind === "investment") finishParsingInvestmentData(data);
          else finishParsingData(data);
        } catch {
          setError("Could not read the spreadsheet. Make sure it is a valid .xlsx or .xls file.");
          setStep("upload");
        }
      }).catch(() => {
        setError("Failed to read the file.");
        setStep("upload");
      });
      return;
    }

    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (result) => {
        const data = result.data as string[][];
        if (data.length < 2) {
          setError("File appears empty or has too few rows.");
          setStep("upload");
          return;
        }
        if (importKind === "investment") finishParsingInvestmentData(data);
        else finishParsingData(data);
      },
      error: (err) => {
        setError(err.message);
        setStep("upload");
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, importKind]);

  /** Parses a brokerage portfolio-positions export and advances to its review step. */
  const finishParsingInvestmentData = useCallback((data: string[][]) => {
    const result = parseInvestmentWorkbook(data);
    if (!result) {
      setError("We couldn't detect a supported portfolio format. Supported formats: Wells Fargo Advisors (XLSX), Fidelity, and Thrivent (CSV).");
      setStep("upload");
      return;
    }
    setInvParsed(result);
    setColMapOverrides({});
    setFixColumnsOpen(new Set());
    setAccountChoice(null);
    setExistingAccountsForType([]);
    setMaxStepReached(1);
    setWizardDir("forward");
    setStep("wizard:account");
  }, []);

  const toggleFixColumns = (title: string) => {
    setFixColumnsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  };

  /** Applies a manual column-map override for one field within one section. -1 clears the override. */
  const setColumnOverride = (title: string, field: string, idx: number) => {
    setColMapOverrides((prev) => ({
      ...prev,
      [title]: { ...prev[title], [field]: idx },
    }));
  };

  /** Shared logic to detect headers, load presets, and advance to the wizard after parsing. */
  const finishParsingData = useCallback((data: string[][]) => {
    const initialSkip = findRealHeaderRow(data);
    setRawData(data);
    setSkipRows(initialSkip);
    setAccountChoice(null);
    setExistingAccountsForType([]);
    setMaxStepReached(1);
    const derived = deriveHeaders(data, initialSkip);
    if (!derived) {
      setError("File appears empty after skipping summary rows.");
      setStep("upload");
      return;
    }
    setParsed(derived);
    const { headers } = derived;
    (async () => {
      try {
        const sig = computeHeaderSig(headers);
        const db = await getDb();
        const colProfiles = await db.select<{
          date_col: number; desc_col: number; amount_col: number;
          type_col: number; balance_col: number;
        }[]>(
          "SELECT date_col, desc_col, amount_col, COALESCE(type_col, -1) as type_col, COALESCE(balance_col, -1) as balance_col FROM column_profiles WHERE header_sig=? AND profile_id=?",
          [sig, profileId]
        );
        if (colProfiles.length > 0) {
          const p = colProfiles[0];
          // Restore invertAmounts from fingerprint detection even when a saved column
          // profile is found - it is not persisted in column_profiles so would otherwise
          // always revert to false on repeat imports (e.g. Amex).
          const fpId = detectPresetByFingerprint(headers);
          const restoredInvert = (fpId && BANK_PRESETS[fpId]?.invertAmounts) ? BANK_PRESETS[fpId].invertAmounts! : false;
          setColMap({ dateCol: p.date_col, descCol: p.desc_col, amountCol: p.amount_col, typeCol: p.type_col, balanceCol: p.balance_col, invertAmounts: restoredInvert });
          setProfileFound(true);
        } else {
          const base = autoDetect(headers);
          const presetId = selectedPresetId ?? detectPresetByFingerprint(headers);
          if (presetId && BANK_PRESETS[presetId]) {
            setColMap({ ...base, ...applyPreset(BANK_PRESETS[presetId], headers) });
            if (!selectedPresetId) setSelectedPresetId(presetId);
          } else {
            setColMap(base);
          }
          setProfileFound(false);
        }
      } catch {
        setColMap(autoDetect(headers));
        setProfileFound(false);
      }
      setStep("wizard:account");
    })();
  }, [profileId, selectedPresetId]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files).filter((f) => /\.(csv|xlsx?)$/i.test(f.name));
      if (files.length === 0) { setError("Please drop one or more .csv or .xlsx files."); return; }
      const [first, ...rest] = files;
      setBatchQueue(rest);
      processFile(first);
    },
    [processFile]
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const [first, ...rest] = files;
    setBatchQueue(rest);
    processFile(first);
    e.target.value = "";
  };

  const adjustSkipRows = (delta: number) => {
    if (!rawData) return;
    const newSkip = Math.max(0, Math.min(skipRows + delta, rawData.length - 2));
    setSkipRows(newSkip);
    const derived = deriveHeaders(rawData, newSkip);
    if (derived) {
      setParsed(derived);
      const base = autoDetect(derived.headers);
      const presetId = selectedPresetId ?? detectPresetByFingerprint(derived.headers);
      if (presetId && BANK_PRESETS[presetId]) {
        const overrides = applyPreset(BANK_PRESETS[presetId], derived.headers);
        setColMap({ ...base, ...overrides });
        if (!selectedPresetId) setSelectedPresetId(presetId);
      } else {
        setColMap(base);
      }
      setProfileFound(false);
    }
  };

  const handleImport = async () => {
    if (!parsed) return;
    setStep("importing");
    // Yield one animation frame so React can paint the loading UI before the
    // import loop starts - prevents the UI appearing frozen on large files.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const db = await getDb();
      const accountId = await resolveAccountId(
        profileId,
        importKind === "credit" ? "credit" : "checking",
        accountChoice ?? { mode: "new", name: "My Account", institution: "Imported" }
      );
      // Once a new account is actually created, lock the choice onto that concrete row -
      // otherwise batch/auto-import would each independently create ANOTHER "new" account
      // instead of sharing the one just created, splitting one card's transactions/balance
      // across several duplicate accounts.
      setAccountChoice((prev) => (prev?.mode === "existing" && prev.accountId === accountId ? prev : { mode: "existing", accountId, name: prev?.name ?? "My Account" }));
      if (colMap.balanceCol < 0 && currentBalanceInput.trim()) {
        // The entered value is the real balance AFTER all transactions, as of today (when it's
        // submitted) - not before them - so Compass can calculate correctly in both directions.
        // Credit cards are a liability - always store it negative, regardless of whether the
        // user typed it as a positive "amount owed" or already-negative number.
        const rawAnchorCents = Math.round(parseAmount(currentBalanceInput) * 100);
        const anchorCents = importKind === "credit" ? -Math.abs(rawAnchorCents) : rawAnchorCents;
        const anchorDate = new Date().toISOString().split("T")[0];
        await db.execute(
          "UPDATE accounts SET balance_anchor_cents=?, balance_anchor_date=? WHERE id=?",
          [anchorCents, anchorDate, accountId]
        );
      }
      const rules = await db.select<CategorizationRule[]>(
        "SELECT * FROM categorization_rules WHERE profile_id=? OR profile_id IS NULL ORDER BY priority DESC",
        [profileId]
      );

      // Create an import session record before the loop so we have an ID to reference
      const sessionResult = await db.execute(
        "INSERT INTO import_sessions (filename, row_count, skipped_count, profile_id) VALUES (?, 0, 0, ?)",
        [currentFilename, profileId]
      );
      const sessionId = sessionResult.lastInsertId as number;

      let imported = 0;
      let skipped = 0;

      for (const row of parsed.rows) {
        const requiredCols = [colMap.dateCol, colMap.descCol, colMap.amountCol];
        if (colMap.typeCol >= 0) requiredCols.push(colMap.typeCol);
        const maxIdx = Math.max(...requiredCols);
        if (row.length <= maxIdx) continue;
        const date = parseDate(row[colMap.dateCol] ?? "");
        const description = (row[colMap.descCol] ?? "").trim();
        const rawAmount = parseAmount(row[colMap.amountCol] ?? "0");
        let amount = rawAmount;
        if (colMap.typeCol >= 0) {
          const typeVal = (row[colMap.typeCol] ?? "").trim().toLowerCase();
          if (typeVal === "debit") amount = -Math.abs(rawAmount);
          else if (typeVal === "credit") amount = Math.abs(rawAmount);
        }
        if (colMap.invertAmounts) amount = -amount;
        if (!date || !description || !isFinite(amount) || amount === 0) continue;

        const amountCents = Math.round(amount * 100);
        const hash = await hashRow(row);
        const categoryId = applyCategorizationRules(description, rules, amountCents);
        // Credit card statements print the amount you owe as a positive number, but that's a
        // liability - always store it negative, regardless of the file's own sign convention.
        const balanceCents = colMap.balanceCol >= 0 && row[colMap.balanceCol]
          ? (() => { const c = Math.round(parseAmount(row[colMap.balanceCol]) * 100); return importKind === "credit" ? -Math.abs(c) : c; })()
          : null;

        try {
          await db.execute(
            `INSERT INTO transactions
               (account_id, date, amount_cents, description, category_id, import_hash,
                balance_cents, profile_id, import_session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [accountId, date, amountCents, description, categoryId, hash,
             balanceCents, profileId, sessionId]
          );
          imported++;
        } catch {
          skipped++;
        }
      }

      if (imported === 0) {
        // Nothing new - remove the empty session record
        await db.execute("DELETE FROM import_sessions WHERE id=?", [sessionId]);
      } else {
        // Update session with actual counts
        await db.execute(
          "UPDATE import_sessions SET row_count=?, skipped_count=? WHERE id=?",
          [imported, skipped, sessionId]
        );
      }

      // Save / update the column profile for next time
      const sig = computeHeaderSig(parsed.headers);
      await db.execute(
        `INSERT INTO column_profiles (header_sig, date_col, desc_col, amount_col, type_col, balance_col, profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(header_sig) DO UPDATE SET
           date_col    = excluded.date_col,
           desc_col    = excluded.desc_col,
           amount_col  = excluded.amount_col,
           type_col    = excluded.type_col,
           balance_col = excluded.balance_col`,
        [sig, colMap.dateCol, colMap.descCol, colMap.amountCol, colMap.typeCol, colMap.balanceCol, profileId]
      );

      // No native balance column - (re)calculate a running balance for every transaction on
      // this account from its balance anchor (or 0), so charts/dashboards still have a value.
      if (colMap.balanceCol < 0) {
        await recomputeCalculatedBalances(accountId);
      }

      setSummary({ imported, skipped });
      await loadHistory();
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("wizard:preview");
    }
  };

  /** Silently import a file using a previously approved column mapping (batch auto-mode). */
  const autoImportFile = useCallback(async (file: File, savedColMap: ColMap) => {
    setError(null);
    setCurrentFilename(file.name);
    setStep("importing");
    const data: string[][] = await new Promise((resolve, reject) => {
      Papa.parse<string[]>(file, {
        skipEmptyLines: true,
        complete: (r) => resolve(r.data as string[][]),
        error: (e) => reject(e),
      });
    });
    if (data.length < 2) { setStep("done"); setSummary({ imported: 0, skipped: 0 }); return; }
    const skip = findRealHeaderRow(data);
    const derived = deriveHeaders(data, skip);
    if (!derived) { setStep("done"); setSummary({ imported: 0, skipped: 0 }); return; }
    setRawData(data); setSkipRows(skip); setParsed(derived);
    try {
      const db = await getDb();
      const accountId = await resolveAccountId(
        profileId,
        importKind === "credit" ? "credit" : "checking",
        accountChoice ?? { mode: "new", name: "My Account", institution: "Imported" }
      );
      // Same fix as handleImport - lock onto the concrete account so the rest of this batch
      // (files processed automatically after this one) reuses it instead of creating duplicates.
      setAccountChoice((prev) => (prev?.mode === "existing" && prev.accountId === accountId ? prev : { mode: "existing", accountId, name: prev?.name ?? "My Account" }));
      const rules = await db.select<CategorizationRule[]>(
        "SELECT * FROM categorization_rules WHERE profile_id=? OR profile_id IS NULL ORDER BY priority DESC",
        [profileId]
      );
      const sessionResult = await db.execute(
        "INSERT INTO import_sessions (filename, row_count, skipped_count, profile_id) VALUES (?, 0, 0, ?)",
        [file.name, profileId]
      );
      const sessionId = sessionResult.lastInsertId as number;
      let imported = 0; let skipped = 0;
      for (const row of derived.rows) {
        const reqCols = [savedColMap.dateCol, savedColMap.descCol, savedColMap.amountCol];
        if (savedColMap.typeCol >= 0) reqCols.push(savedColMap.typeCol);
        if (row.length <= Math.max(...reqCols)) continue;
        const date = parseDate(row[savedColMap.dateCol] ?? "");
        const description = (row[savedColMap.descCol] ?? "").trim();
        const rawAmount = parseAmount(row[savedColMap.amountCol] ?? "0");
        let amount = rawAmount;
        if (savedColMap.typeCol >= 0) {
          const tv = (row[savedColMap.typeCol] ?? "").trim().toLowerCase();
          if (tv === "debit") amount = -Math.abs(rawAmount);
          else if (tv === "credit") amount = Math.abs(rawAmount);
        }
        if (savedColMap.invertAmounts) amount = -amount;
        if (!date || !description || !isFinite(amount) || amount === 0) continue;
        const amountCents = Math.round(amount * 100);
        const hash = await hashRow(row);
        const categoryId = applyCategorizationRules(description, rules, amountCents);
        const balanceCents = savedColMap.balanceCol >= 0 && row[savedColMap.balanceCol]
          ? (() => { const c = Math.round(parseAmount(row[savedColMap.balanceCol]) * 100); return importKind === "credit" ? -Math.abs(c) : c; })() : null;
        try {
          await db.execute(
            `INSERT INTO transactions (account_id, date, amount_cents, description, category_id,
               import_hash, balance_cents, profile_id, import_session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [accountId, date, amountCents, description, categoryId, hash, balanceCents, profileId, sessionId]
          );
          imported++;
        } catch { skipped++; }
      }
      if (imported === 0) {
        await db.execute("DELETE FROM import_sessions WHERE id=?", [sessionId]);
      } else {
        await db.execute(
          "UPDATE import_sessions SET row_count=?, skipped_count=? WHERE id=?",
          [imported, skipped, sessionId]
        );
      }
      if (savedColMap.balanceCol < 0) {
        await recomputeCalculatedBalances(accountId);
      }
      await loadHistory();
      setSummary({ imported, skipped });
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSummary({ imported: 0, skipped: 0 });
      setStep("done");
    }
  }, [profileId, loadHistory, importKind, accountChoice]);

  // When an import finishes in batch-auto mode, silently process the next queued file.
  useEffect(() => {
    if (step !== "done" || !batchAutoMode) return;
    if (batchQueue.length === 0) {
      setBatchAutoMode(false);
      batchSavedColMapRef.current = null;
      return;
    }
    const [next, ...rest] = batchQueue;
    setBatchQueue(rest);
    setStep("importing"); // show loading immediately before async work starts
    if (batchSavedColMapRef.current) autoImportFile(next, batchSavedColMapRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, batchAutoMode]);

  const reset = () => {
    setStep("upload");
    setRawData(null);
    setSkipRows(0);
    setParsed(null);
    setInvParsed(null);
    setColMapOverrides({});
    setFixColumnsOpen(new Set());
    setCurrentBalanceInput("");
    setAccountChoice(null);
    setExistingAccountsForType([]);
    setMaxStepReached(1);
    setCurrentFilename("");
    setSummary(null);
    setError(null);
    setProfileFound(false);
    setTargetMonth(currentYM());
    setConfirmDeleteId(null);
    setBatchQueue([]);
    setSelectedPresetId(null);
    setBatchAutoMode(false);
    setTotalBatchCount(0);
    batchSavedColMapRef.current = null;
  };

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <h1 className="text-2xl font-semibold mb-2">Import Statements</h1>
      <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
        Your data never leaves this device.
      </p>

      {step === "upload" && importKind === null && (
        <div className="space-y-3">
          <p className="text-sm font-medium">What are you importing?</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {IMPORT_KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setImportKind(k.id)}
                className="border rounded-xl p-5 text-center hover:border-[hsl(var(--primary))] hover:bg-[hsl(var(--muted))] transition-colors chart-clickable"
              >
                <div className="flex justify-center mb-2 text-[hsl(var(--primary))]"><k.Icon size={26} /></div>
                <p className="font-medium text-sm">{k.label}</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{k.hint}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {(step === "upload" || step === "checking") && importKind !== null && (
        <div>
          {step === "upload" && (
            <button onClick={() => setImportKind(null)} className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] mb-2">
              ‹ Change type
            </button>
          )}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => step === "upload" && document.getElementById("csv-input")?.click()}
            className={`border-2 border-dashed rounded-xl p-16 text-center select-none
                        transition-colors
                        ${step === "checking"
                          ? "opacity-60 cursor-wait"
                          : "cursor-pointer hover:border-[hsl(var(--primary))]"}`}
          >
            <div className="flex justify-center mb-4 text-[hsl(var(--muted-foreground))]">{step === "checking" ? (<Loader2 size={48} className="animate-spin" />) : (<Upload size={48} />)}</div>
            <p className="font-medium mb-1">
              {step === "checking"
                ? "Reading file..."
                : importKind === "investment"
                ? "Drop your portfolio positions export here or click to browse"
                : "Drop your CSV here or click to browse"}
            </p>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              {importKind === "investment"
                ? "Works with Wells Fargo Advisors portfolio positions exports"
                : "Works with exports from any bank or credit card"}
            </p>
          </div>
          <input
            id="csv-input"
            type="file"
            accept=".csv,.xlsx,.xls"
            multiple
            className="hidden"
            onChange={handleFileInput}
          />

          {/* Bank preset picker */}
          {step === "upload" && importKind !== "investment" && (
            <div className="mt-5 border rounded-xl p-4 space-y-3">
              <p className="text-sm font-medium">
                Select your bank <span className="text-[hsl(var(--muted-foreground))] font-normal">(optional - speeds up column detection)</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(BANK_PRESETS).map(([id, preset]) => (
                  <button
                    key={id}
                    onClick={() => setSelectedPresetId((prev) => (prev === id ? null : id))}
                    className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                      selectedPresetId === id
                        ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent"
                        : "hover:bg-[hsl(var(--muted))]"
                    }`}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
              {selectedPresetId && BANK_PRESETS[selectedPresetId]?.note && (
                <p className="text-xs text-[hsl(var(--muted-foreground))] border-t pt-2 flex items-start gap-1"><Info size={12} className="shrink-0 mt-0.5" /> {BANK_PRESETS[selectedPresetId].note}</p>
              )}
              {selectedPresetId && (
                <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle2 size={12} /> {BANK_PRESETS[selectedPresetId].name} selected - column mapping will be pre-filled.</p>
              )}
            </div>
          )}

          {error && <p className="mt-4 text-red-500 text-sm">{error}</p>}
        </div>
      )}

      {wizardNum(step) > 0 && parsed && (
        <div className="mb-6">
          <div className="flex items-center gap-1 mb-2">
            {WIZARD_STEPS.map((ws, i) => {
              const visited = ws.num <= maxStepReached;
              return (
                <div key={ws.step} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => visited && wizardGo(ws.step, ws.num < wizardNum(step) ? "back" : "forward")}
                    disabled={!visited}
                    aria-label={`Go to ${ws.label} step`}
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                      wizardNum(step) === ws.num
                        ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                        : wizardNum(step) > ws.num
                        ? "bg-green-500 text-white cursor-pointer hover:opacity-80"
                        : "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] cursor-not-allowed"
                    }`}>
                    {wizardNum(step) > ws.num ? "✓" : ws.num}
                  </button>
                  {i < WIZARD_STEPS.length - 1 && (
                    <div className={`h-0.5 w-6 transition-colors ${wizardNum(step) > ws.num ? "bg-green-500" : "bg-[hsl(var(--muted))]"}`} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              Step {wizardNum(step)} of {WIZARD_STEPS.length}
            </span>
            <span className="font-semibold">
              {WIZARD_STEPS.find((s) => s.step === step)?.label}
            </span>
            <span className="text-xs text-[hsl(var(--muted-foreground))] ml-auto">
              {currentFilename}
            </span>
          </div>
        </div>
      )}

      {step === "wizard:account" && (
        <div key="wizard:account" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--primary)/0.1)" }}>
              {importKind === "credit" ? <CreditCard size={18} className="text-[hsl(var(--primary))]" />
                : importKind === "investment" ? <TrendingUp size={18} className="text-[hsl(var(--primary))]" />
                : <Landmark size={18} className="text-[hsl(var(--primary))]" />}
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Which <span className="text-[hsl(var(--primary))]">account</span> is this?</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
                Compass tracks each account's balance separately - pick the right one so nothing gets mixed up or overwritten.
              </p>
            </div>
          </div>

          <div className="border rounded-xl p-5 space-y-4">
            {accountChoice?.mode === "existing" && (
              <div className="px-3 py-2.5 rounded-lg text-sm border border-green-300 bg-green-50
                              text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300 flex items-start gap-2">
                <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                <span>This looks like your existing <strong>{accountChoice.name}</strong> account - we'll add these transactions there.</span>
              </div>
            )}
            {accountChoice?.mode === "new" && existingAccountsForType.length > 0 && (
              <div className="px-3 py-2.5 rounded-lg text-sm border border-blue-300 bg-blue-50
                              text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300 flex items-start gap-2">
                <Info size={14} className="shrink-0 mt-0.5" />
                <span>This looks like a new account - we'll create <strong>{accountChoice.name || "it"}</strong>.</span>
              </div>
            )}

            {existingAccountsForType.length > 0 && (
              <div className="flex gap-3 text-sm">
                <button
                  onClick={() => setAccountChoice((prev) => ({
                    mode: "new",
                    name: prev?.name ?? (selectedPresetId ? BANK_PRESETS[selectedPresetId]?.name ?? "" : ""),
                    institution: prev?.mode === "new" ? prev.institution : (selectedPresetId ? BANK_PRESETS[selectedPresetId]?.name ?? "Imported" : "Imported"),
                  }))}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${(accountChoice?.mode ?? "new") === "new" ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                >
                  New account
                </button>
                <button
                  onClick={() => setAccountChoice({
                    mode: "existing",
                    accountId: existingAccountsForType[0].id,
                    name: existingAccountsForType[0].name,
                  })}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${accountChoice?.mode === "existing" ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                >
                  Existing account
                </button>
              </div>
            )}

            {accountChoice?.mode === "existing" ? (
              <select
                value={accountChoice.accountId}
                onChange={(e) => {
                  const acct = existingAccountsForType.find((a) => a.id === parseInt(e.target.value));
                  if (acct) setAccountChoice({ mode: "existing", accountId: acct.id, name: acct.name });
                }}
                className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                {existingAccountsForType.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.institution && a.institution !== "Imported" ? ` (${a.institution})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Account name</label>
                <input
                  type="text"
                  value={accountChoice?.name ?? ""}
                  onChange={(e) => setAccountChoice((prev) => ({
                    mode: "new",
                    name: e.target.value,
                    institution: prev?.mode === "new" ? prev.institution : "Imported",
                  }))}
                  placeholder={importKind === "credit" ? "e.g. Chase Sapphire" : importKind === "investment" ? "e.g. Fidelity Brokerage" : "e.g. Checking"}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                />
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo("upload", "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button
              onClick={() => wizardGo(importKind === "investment" ? "wizard:investment-preview" : "wizard:data", "forward")}
              disabled={!accountChoice || (accountChoice.mode === "new" && !accountChoice.name.trim())}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed">
              Continue
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "wizard:data" && parsed && (
        <div key="wizard:data" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Confirm the header row below looks right, then continue to map your columns.
          </p>

          {/* Header-only display - centered column pills */}
          <div className="border rounded-xl overflow-hidden">
            <div className="text-center py-2 bg-[hsl(var(--primary)/0.08)] border-b">
              <span className="text-xs font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
                Header row (row {skipRows + 1})
              </span>
            </div>
            <div className="py-5 flex flex-wrap justify-center gap-2 px-6">
              {parsed.headers.map((h, i) => (
                <span key={i} className="px-3 py-1.5 bg-[hsl(var(--muted))] border rounded-lg text-sm font-semibold">
                  {h || `Column ${i + 1}`}
                </span>
              ))}
            </div>
          </div>

          {/* Row navigation */}
          <div className="flex items-center justify-center gap-3 text-sm">
            <button onClick={() => adjustSkipRows(-1)} disabled={skipRows === 0} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors disabled:opacity-50">- Back</button>
            <span className="text-[hsl(var(--muted-foreground))]">
              Row <span className="font-mono font-bold text-[hsl(var(--foreground))]">{skipRows + 1}</span> of {rawData?.length ?? 0}
            </span>
            <button onClick={() => adjustSkipRows(1)} disabled={!rawData || skipRows >= rawData.length - 2}
              className="w-8 h-8 flex items-center justify-center border rounded-md disabled:opacity-30 hover:bg-[hsl(var(--muted))] transition-colors text-base">+</button>
            <span className="text-xs text-[hsl(var(--muted-foreground))] ml-2">
              {parsed.rows.length} data rows Â· {parsed.headers.length} columns
            </span>
          </div>

          {profileFound && (
            <div className="px-4 py-2.5 rounded-lg text-sm border border-green-300 bg-green-50
                            text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
                  Column layout recognized from a previous import.
            </div>
          )}

          <div className="flex gap-3 justify-center">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm font-medium hover:bg-[hsl(var(--muted))] transition-colors">
              Skip to Preview
            </button>
            <button onClick={() => wizardGo("wizard:date", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
              Continue
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "wizard:date" && parsed && (
        <div key="wizard:date" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--primary)/0.1)" }}>
              <Calendar size={18} className="text-[hsl(var(--primary))]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Which column is the <span className="text-[hsl(var(--primary))]">Date</span>?</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">Pick the column that contains the transaction date.</p>
            </div>
          </div>
          <div className="border rounded-xl p-5 space-y-4">
            <select value={colMap.dateCol}
              onChange={(e) => setColMap((m) => ({ ...m, dateCol: parseInt(e.target.value) }))}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>

          <div className="border rounded-xl overflow-hidden">
            <div className="text-center py-2.5 bg-[hsl(var(--primary)/0.08)] border-b">
              <span className="text-xs font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
                {parsed.headers[colMap.dateCol] || `Column ${colMap.dateCol + 1}`}
              </span>
            </div>
            <div className="divide-y">
              {parsed.rows.filter((r) => r[colMap.dateCol]).slice(0, 4).map((row, i) => {
                const raw = row[colMap.dateCol] ?? "";
                const iso = parseDate(raw);
                const ok = /^\d{4}-\d{2}-\d{2}$/.test(iso);
                return (
                  <div key={i} className="py-3 text-center">
                    <p className="font-mono text-sm text-[hsl(var(--muted-foreground))]">{raw}</p>
                    <p className={`text-base font-semibold mt-0.5 ${ok ? "text-green-600" : "text-red-500"}`}>
                      {ok ? formatDate(iso) : "Couldn't parse"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => wizardGo("wizard:desc", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
              Continue
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
              Skip to Preview
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "wizard:desc" && parsed && (
        <div key="wizard:desc" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--primary)/0.1)" }}>
              <Tag size={18} className="text-[hsl(var(--primary))]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Which column is the <span className="text-[hsl(var(--primary))]">Description</span>?</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">The merchant or payee name - used for auto-categorization.</p>
            </div>
          </div>
          <div className="border rounded-xl p-5 space-y-4">
            <select value={colMap.descCol}
              onChange={(e) => setColMap((m) => ({ ...m, descCol: parseInt(e.target.value) }))}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>

            <div className="border rounded-xl overflow-hidden">
              <div className="text-center py-2.5 bg-[hsl(var(--primary)/0.08)] border-b">
                <span className="text-xs font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
                  {parsed.headers[colMap.descCol] || `Column ${colMap.descCol + 1}`}
                </span>
              </div>
              <div className="divide-y">
                {parsed.rows.filter((r) => r[colMap.descCol]).slice(0, 4).map((row, i) => (
                  <div key={i} className="py-3 text-center px-6">
                    <p className="text-sm">{row[colMap.descCol]}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => wizardGo("wizard:amount", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
              Continue
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
              Skip to Preview
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "wizard:amount" && parsed && (
        <div key="wizard:amount" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--primary)/0.1)" }}>
              <DollarSign size={18} className="text-[hsl(var(--primary))]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Which column is the <span className="text-[hsl(var(--primary))]">Amount</span>?</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">Expenses should be negative, income positive.</p>
            </div>
          </div>
          <div className="border rounded-xl p-5 space-y-4">
            <select value={colMap.amountCol}
              onChange={(e) => setColMap((m) => ({ ...m, amountCol: parseInt(e.target.value) }))}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>

            <div className="border rounded-xl overflow-hidden">
              <div className="text-center py-2.5 bg-[hsl(var(--primary)/0.08)] border-b">
                <span className="text-xs font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
                  {parsed.headers[colMap.amountCol] || `Column ${colMap.amountCol + 1}`}
                </span>
              </div>
              <div className="divide-y">
                {parsed.rows.filter((r) => r[colMap.amountCol]).slice(0, 4).map((row, i) => {
                  const raw = row[colMap.amountCol] ?? "";
                  let amt = parseAmount(raw);
                  if (colMap.typeCol >= 0) {
                    const tv = (row[colMap.typeCol] ?? "").trim().toLowerCase();
                    if (tv === "debit") amt = -Math.abs(amt);
                    else if (tv === "credit") amt = Math.abs(amt);
                  }
                  if (colMap.invertAmounts) amt = -amt;
                  return (
                    <div key={i} className="py-3 text-center">
                      <p className="font-mono text-sm text-[hsl(var(--muted-foreground))]">{raw}</p>
                      <p className={`font-mono text-base font-semibold mt-0.5 ${amt < 0 ? "text-red-500" : amt > 0 ? "text-green-600" : "text-amber-500"}`}>
                        {formatCurrency(Math.round(amt * 100))}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Debit/Credit type column toggle */}
            <div className="pt-3 border-t space-y-3">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                Does your bank use a separate "Debit / Credit" column?
              </p>
              <div className="flex gap-3 text-sm">
                <button
                  onClick={() => setColMap((m) => ({ ...m, typeCol: -1 }))}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.typeCol === -1 ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                >
                  No - amounts are already signed
                </button>
                <button
                  onClick={() => {
                    const typeGuess = parsed.headers.findIndex((h) => h.toLowerCase().includes("type") && !h.toLowerCase().includes("amount"));
                    setColMap((m) => ({ ...m, typeCol: typeGuess >= 0 ? typeGuess : 0 }));
                  }}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.typeCol >= 0 ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                >
                  Yes - select that column
                </button>
              </div>
              {colMap.typeCol >= 0 && (
                <select value={colMap.typeCol}
                  onChange={(e) => setColMap((m) => ({ ...m, typeCol: parseInt(e.target.value) }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                  {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              )}
            </div>

            {/* Sign inversion toggle - for banks that export expenses as positive (Discover, Amex) */}
            <div className="pt-3 border-t space-y-2">
              {importKind === "credit" ? (
                <>
                  <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                    How does your statement show purchases vs. payments?
                  </p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    Compass needs <strong>purchases</strong> (charges that increase what you owe) to end up <strong>negative</strong>,
                    and <strong>payments toward the card</strong> (that reduce what you owe) to end up <strong>positive</strong> - the
                    same way money-out vs. money-in works on a checking account. Check a purchase row and a payment row in the preview
                    above: if purchases are already negative and payments already positive, leave this off. If it's the other way
                    around, flip it.
                  </p>
                  <div className="flex gap-3 text-sm">
                    <button
                      onClick={() => setColMap((m) => ({ ...m, invertAmounts: false }))}
                      className={`px-3 py-1.5 rounded-lg border transition-colors ${!colMap.invertAmounts ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                    >
                      No - purchases negative, payments positive
                    </button>
                    <button
                      onClick={() => setColMap((m) => ({ ...m, invertAmounts: true }))}
                      className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.invertAmounts ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                    >
                      Yes - flip (purchases positive, payments negative)
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                    Are expenses shown as positive numbers?
                  </p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    Some banks (Discover, Amex, Capital One) export purchases as positive values instead of negative. Enable this to flip all signs.
                  </p>
                  <div className="flex gap-3 text-sm">
                    <button
                      onClick={() => setColMap((m) => ({ ...m, invertAmounts: false }))}
                      className={`px-3 py-1.5 rounded-lg border transition-colors ${!colMap.invertAmounts ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                    >
                      No - standard signs
                    </button>
                    <button
                      onClick={() => setColMap((m) => ({ ...m, invertAmounts: true }))}
                      className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.invertAmounts ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                    >
                      Yes - flip signs
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => wizardGo("wizard:balance", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
              Continue
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
              Skip to Preview
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "wizard:balance" && parsed && (
        <div key="wizard:balance" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--primary)/0.1)" }}>
              <BarChart2 size={18} className="text-[hsl(var(--primary))]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Is there a <span className="text-[hsl(var(--primary))]">Balance</span> column? <span className="text-sm font-normal text-[hsl(var(--muted-foreground))]">Optional</span></h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">Running account balance - unlocks balance charts and low-balance alerts.</p>
            </div>
          </div>
          <div className="border rounded-xl p-5 space-y-4">
            <div className="flex gap-3 text-sm">
              <button
                onClick={() => setColMap((m) => ({ ...m, balanceCol: -1 }))}
                className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.balanceCol === -1 ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
              >
                No balance column
              </button>
              <button
                onClick={() => {
                  const guess = parsed.headers.findIndex((h) => h.toLowerCase().includes("balance"));
                  setColMap((m) => ({ ...m, balanceCol: guess >= 0 ? guess : 0 }));
                }}
                className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.balanceCol >= 0 ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
              >
                Yes, select it
              </button>
            </div>

            {colMap.balanceCol >= 0 && (
              <>
                <select value={colMap.balanceCol}
                  onChange={(e) => setColMap((m) => ({ ...m, balanceCol: parseInt(e.target.value) }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                  {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
                <div className="border rounded-xl overflow-hidden">
                  <div className="text-center py-2.5 bg-[hsl(var(--primary)/0.08)] border-b">
                    <span className="text-xs font-bold uppercase tracking-widest text-[hsl(var(--primary))]">
                      {parsed.headers[colMap.balanceCol] || `Column ${colMap.balanceCol + 1}`}
                    </span>
                  </div>
                  <div className="divide-y">
                    {parsed.rows.filter((r) => r[colMap.balanceCol]).slice(0, 4).map((row, i) => {
                      const raw = row[colMap.balanceCol] ?? "";
                      const amt = parseAmount(raw);
                      return (
                        <div key={i} className="py-3 text-center">
                          <p className="font-mono text-sm text-[hsl(var(--muted-foreground))]">{raw}</p>
                          <p className="font-mono text-base font-semibold mt-0.5 text-[hsl(var(--foreground))]">
                            {formatCurrency(Math.round(amt * 100))}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {colMap.balanceCol === -1 && (
              <div className="pt-3 border-t space-y-2">
                <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                  Current balance <span className="font-normal">(optional)</span>
                </p>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  Know your real account balance today, after these transactions? Enter it and Compass will calculate each transaction's running balance by working backward from today's date. Leave it blank and Compass will still calculate a relative running total starting from $0.
                </p>
                <div className="relative max-w-xs">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[hsl(var(--muted-foreground))]">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={currentBalanceInput}
                    onChange={(e) => setCurrentBalanceInput(e.target.value)}
                    className="w-full border rounded-lg pl-7 pr-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
              Continue to Preview
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "wizard:investment-preview" && invParsed && (
        <div key="wizard:investment-preview" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          {error && <p className="text-red-500 text-sm p-3 border border-red-300 rounded-lg">{error}</p>}

          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--primary)/0.1)" }}>
              <TrendingUp size={18} className="text-[hsl(var(--primary))]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Portfolio Positions</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">Priced as of {formatDate(invParsed.asOfDate)}</p>
            </div>
          </div>

          {accountChoice && (
            <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
              <CheckCircle2 size={12} />
              {accountChoice.mode === "existing"
                ? <>Adding a new snapshot to your existing <strong>{accountChoice.name}</strong> account.</>
                : <>Creating a new account: <strong>{accountChoice.name}</strong>.</>}
            </p>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div className="border rounded-xl p-4 text-center">
              <p className="text-xl font-bold">{formatCurrency(Math.round(invTotals.marketValue * 100))}</p>
              <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">Total Market Value</p>
            </div>
            <div className="border rounded-xl p-4 text-center">
              <p className="text-xl font-bold">{invTotals.count}</p>
              <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">Positions</p>
            </div>
            <div className="border rounded-xl p-4 text-center">
              <p className="text-xl font-bold">{formatCurrency(Math.round(invTotals.estAnnualIncome * 100))}</p>
              <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5 flex items-center justify-center gap-1">
                Est. Annual Income
                <InfoTooltip text="The brokerage's own projected annual income estimate as of the statement date - typically dividends, interest, and other distributions. It's a forward-looking estimate, not a record of income actually paid." />
              </p>
            </div>
            <div className="border rounded-xl p-4 text-center">
              <p className="text-xl font-bold">{derivedSections.length}</p>
              <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">Sections Found</p>
            </div>
          </div>

          {derivedSections.map((section) => {
            const isFixOpen = fixColumnsOpen.has(section.title);
            const noValueData = sectionHasNoValueData(section.rows);
            return (
            <div key={section.title} className="border rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-[hsl(var(--muted))] border-b text-xs font-medium uppercase tracking-wide flex items-center justify-between gap-2">
                <span>{section.title} ({section.rows.length})</span>
                <div className="flex items-center gap-3">
                  <span>{formatCurrency(Math.round(section.totalMarketValue * 100))}</span>
                  <button onClick={() => toggleFixColumns(section.title)}
                    className="text-[hsl(var(--primary))] hover:underline normal-case font-normal">
                    {isFixOpen ? "Done" : "Fix columns"}
                  </button>
                </div>
              </div>
              {noValueData && (
                <p className="px-4 py-2 text-xs text-amber-600 dark:text-amber-400 border-b flex items-start gap-1 normal-case font-normal">
                  <Info size={12} className="shrink-0 mt-0.5" />
                  This section's file columns are all empty for shares, price, market value, and dates - Compass found the holdings but no numbers to go with them. Check <strong>Fix columns</strong> below to confirm, or re-export the statement with those columns visible.
                </p>
              )}
              {isFixOpen && (
                <div className="px-4 py-3 border-b bg-[hsl(var(--muted))]/30 grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {HOLDING_FIELDS.map((field) => (
                    <label key={field.key} className="text-xs space-y-1">
                      <span className="text-[hsl(var(--muted-foreground))]">{field.label}</span>
                      <select
                        value={section.colMap[field.key] ?? -1}
                        onChange={(e) => setColumnOverride(section.title, field.key, parseInt(e.target.value))}
                        className="w-full border rounded-lg px-2 py-1 text-xs bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                      >
                        <option value={-1}>None</option>
                        {section.headerRow.map((h, i) => (
                          <option key={i} value={i}>
                            {(h || `Column ${i + 1}`)} - {columnFillCount(section.rawRows, i)}/{section.rawRows.length} filled
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-[hsl(var(--muted-foreground))]">
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Symbol</th>
                    <th className="px-4 py-2 font-medium text-right">Shares</th>
                    <th className="px-4 py-2 font-medium text-right">Market Value</th>
                    <th className="px-4 py-2 font-medium text-right">Trade Date</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.slice(0, 8).map((row, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-4 py-2 max-w-xs truncate text-xs">{row.description}</td>
                      <td className="px-4 py-2 text-xs font-mono">{row.symbol ?? "-"}</td>
                      <td className="px-4 py-2 text-right text-xs font-mono">{row.shares ?? "-"}</td>
                      <td className="px-4 py-2 text-right text-xs font-mono">{row.marketValue !== null ? formatCurrency(Math.round(row.marketValue * 100)) : "-"}</td>
                      <td className="px-4 py-2 text-right text-xs font-mono text-[hsl(var(--muted-foreground))]">{row.tradeDate ? formatDate(row.tradeDate) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {section.rows.length > 8 && (
                <div className="px-4 py-2 text-xs text-[hsl(var(--muted-foreground))] border-t">+ {section.rows.length - 8} more</div>
              )}
            </div>
            );
          })}

          <p className="text-xs text-[hsl(var(--muted-foreground))] flex items-start gap-1">
            <Info size={12} className="shrink-0 mt-0.5" />
            Dividend and "Est. Annual Income" figures reflect the brokerage's projected estimates, not a history of dividends actually paid.
          </p>

          <div className="flex gap-3">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => handleInvestmentImport()}
              className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg font-medium hover:opacity-90 transition-opacity">
              Import {invTotals.count} Positions
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">Cancel</button>
          </div>
        </div>
      )}

      {step === "wizard:preview" && parsed && (
        <div key="wizard:preview" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          {error && <p className="text-red-500 text-sm p-3 border border-red-300 rounded-lg">{error}</p>}

          {importKind === "credit" && accountChoice && (
            <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
              <CheckCircle2 size={12} />
              {accountChoice.mode === "existing"
                ? <>Adding to your existing <strong>{accountChoice.name}</strong> account.</>
                : <>Creating a new account: <strong>{accountChoice.name}</strong>.</>}
            </p>
          )}

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="border rounded-xl p-4 text-center">
              <p className="text-2xl font-bold">{parsed.rows.filter((r) => {
                const d = parseDate(r[colMap.dateCol] ?? "");
                const a = parseAmount(r[colMap.amountCol] ?? "0");
                return d && r[colMap.descCol]?.trim() && a !== 0;
              }).length}</p>
              <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">Transactions to import</p>
            </div>
            <div className="border rounded-xl p-4 text-center">
              <p className="text-2xl font-bold">{detectedMonth ?? targetMonth}</p>
              <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">Detected month</p>
            </div>
            <div className="border rounded-xl p-4 text-center">
              <p className="text-2xl font-bold">{parsed.headers.length}</p>
              <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">Columns mapped</p>
            </div>
          </div>

          {/* Full preview table */}
          <div className="border rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-[hsl(var(--muted))] border-b text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
              Preview - first 5 rows
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  {colMap.balanceCol >= 0 && <th className="px-4 py-2 font-medium text-right">Balance</th>}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 5).map((row, i) => {
                  const rawAmt = parseAmount(row[colMap.amountCol] ?? "0");
                  let amt = rawAmt;
                  if (colMap.typeCol >= 0) {
                    const tv = (row[colMap.typeCol] ?? "").trim().toLowerCase();
                    if (tv === "debit") amt = -Math.abs(rawAmt);
                    else if (tv === "credit") amt = Math.abs(rawAmt);
                  }
                  const balRaw = colMap.balanceCol >= 0 ? (row[colMap.balanceCol] ?? "") : "";
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-4 py-2 whitespace-nowrap text-[hsl(var(--muted-foreground))] text-xs">
                        {formatDate(parseDate(row[colMap.dateCol] ?? ""))}
                      </td>
                      <td className="px-4 py-2 max-w-xs truncate text-xs">{row[colMap.descCol]}</td>
                      <td className={`px-4 py-2 text-right font-mono text-xs ${amt < 0 ? "text-red-500" : "text-green-600"}`}>
                        {formatCurrency(Math.round(amt * 100))}
                      </td>
                      {colMap.balanceCol >= 0 && (
                        <td className="px-4 py-2 text-right font-mono text-xs text-[hsl(var(--muted-foreground))]">
                          {balRaw ? formatCurrency(Math.round(parseAmount(balRaw) * 100)) : "-"}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Statement month - single or multi-month */}
          {isMultiMonth ? (
            <div className="p-4 border rounded-xl" style={{ backgroundColor: "hsl(var(--primary)/0.05)" }}>
              <p className="text-sm font-semibold mb-2">This CSV spans {allMonths.length} months</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {allMonths.map((ym) => (
                  <span key={ym} className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                    style={{ backgroundColor: "hsl(var(--primary)/0.12)", color: "hsl(var(--primary))" }}>
                    {ym}
                  </span>
                ))}
              </div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">All transactions across every month will be imported.</p>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 border rounded-xl bg-[hsl(var(--muted))]/40">
              <span className="text-sm font-medium shrink-0">Statement month</span>
              <input type="month" value={targetMonth} onChange={(e) => setTargetMonth(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
              {detectedMonth && detectedMonth !== targetMonth && (
                <button onClick={() => setTargetMonth(detectedMonth)} className="text-xs text-[hsl(var(--primary))] hover:underline">
                  Reset to detected ({detectedMonth})
                </button>
              )}
            </div>
          )}

          <div className="flex gap-3 flex-wrap">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={handleImport}
              className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg font-medium hover:opacity-90 transition-opacity">
              Import {parsed.rows.length} Transactions
            </button>
            {batchQueue.length > 0 && (
              <button
                onClick={() => {
                  const total = batchQueue.length + 1;
                  setTotalBatchCount(total);
                  batchSavedColMapRef.current = { ...colMap };
                  setBatchAutoMode(true);
                  handleImport();
                }}
                className="px-5 py-2 bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]
                           border border-[hsl(var(--primary)/0.4)] rounded-lg text-sm font-medium
                           hover:bg-[hsl(var(--primary)/0.25)] transition-colors"
                title="Import this file then automatically import all remaining files using the same column settings"
              >
                Auto-Import All ({batchQueue.length + 1} Files)
              </button>
            )}
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">Cancel</button>
          </div>
        </div>
      )}

      {step === "importing" && (
        <div className="text-center py-16">
              <div className="flex justify-center mb-4 text-blue-500"><Info size={48} /></div>
          {batchAutoMode && totalBatchCount > 1 ? (
            <>
              <p className="font-medium mb-1">
                Importing file {totalBatchCount - batchQueue.length} of {totalBatchCount}...
              </p>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4 truncate max-w-sm mx-auto">
                {currentFilename}
              </p>
              <div className="w-64 mx-auto bg-[hsl(var(--muted))] rounded-full h-1.5">
                <div
                  className="bg-[hsl(var(--primary))] h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${((totalBatchCount - batchQueue.length) / totalBatchCount) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <p className="font-medium">Importing and categorizing transactions...</p>
          )}
        </div>
      )}

      {step === "done" && summary && (
        <div className="text-center py-12 wizard-enter-done">
          {summary.imported === 0 ? (
            <>
              <div className="flex justify-center mb-4 text-blue-500"><Info size={48} /></div>
              <p className="text-xl font-semibold mb-2">Already imported</p>
              <p className="text-[hsl(var(--muted-foreground))] mb-6">
                All {summary.skipped} rows from <strong>{currentFilename}</strong> already exist
                - this file has been imported before.
              </p>
            </>
          ) : (
            <>
              <div className="flex justify-center mb-4 wizard-enter-done"><CheckCircle2 size={48} className="text-green-500" /></div>
              <p className="text-xl font-semibold mb-2">Import complete!</p>
              <p className="text-[hsl(var(--muted-foreground))] mb-6">
                <span className="text-green-600 font-semibold">{summary.imported} transactions</span>{" "}
                imported
                {summary.skipped > 0 && `, ${summary.skipped} duplicates skipped`}.
                {!profileFound && (
                  <span className="block text-xs mt-1">
                    Column layout saved - this bank's CSV will be recognized automatically next time.
                  </span>
                )}
              </p>
            </>
          )}
          <div className="flex gap-3 justify-center">
            {summary.imported > 0 && (
              <button
                onClick={() => invParsed
                  ? navigate("/investments")
                  : navigate("/transactions", { state: isMultiMonth ? {} : { month: targetMonth } })}
                className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                           rounded-lg font-medium"
              >
                {invParsed ? "View Portfolio" : "View Transactions"}
              </button>
            )}
            {batchQueue.length > 0 ? (
              <button
                onClick={() => {
                  const [next, ...rest] = batchQueue;
                  // Reset wizard state but preserve the remaining queue
                  setStep("upload");
                  setRawData(null);
                  setSkipRows(0);
                  setParsed(null);
                  setSummary(null);
                  setError(null);
                  setProfileFound(false);
                  setTargetMonth(currentYM());
                  setConfirmDeleteId(null);
                  setBatchQueue(rest);
                  processFile(next);
                }}
                className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                           rounded-lg font-medium hover:opacity-90 transition-opacity"
              >
                Next File ({batchQueue.length} remaining)
              </button>
            ) : (
              <button
                onClick={reset}
                className="px-6 py-2 border rounded-lg font-medium hover:bg-[hsl(var(--muted))]
                           transition-colors"
              >
                Import Another
              </button>
            )}
          </div>
        </div>
      )}

      {importHistory.length > 0 && (step === "upload" || step === "done") && (
        <div className="mt-8">
          <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
            Import History
            <span className="text-xs font-normal text-[hsl(var(--muted-foreground))]">
              - undo removes all transactions from that import
            </span>
          </h2>
          <div className="border rounded-xl overflow-hidden text-sm">
            <table className="w-full">
              <thead>
                <tr className="bg-[hsl(var(--muted))] border-b text-left">
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium text-right">Rows</th>
                  <th className="px-4 py-2 w-24" />
                </tr>
              </thead>
              <tbody>
                {importHistory.map((s) => (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-[hsl(var(--muted)/0.5)]">
                    <td className="px-4 py-2 font-mono text-xs max-w-[200px] truncate" title={s.filename}>
                      <span className="inline-flex items-center gap-1.5">
                        {s.kind === "investment"
                          ? <TrendingUp size={12} className="shrink-0 text-[hsl(var(--primary))]" />
                          : <Landmark size={12} className="shrink-0 text-[hsl(var(--muted-foreground))]" />}
                        {s.filename}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-[hsl(var(--muted-foreground))] whitespace-nowrap">
                      {formatDate(s.imported_at.split("T")[0])}
                    </td>
                    <td className="px-4 py-2 text-right">{s.row_count}</td>
                    <td className="px-4 py-2 text-right">
                      {confirmDeleteId === s.id ? (
                        <span className="flex items-center justify-end gap-2 text-xs">
                          <button
                            onClick={() => undoImport(s.id)}
                            className="text-red-500 font-medium hover:underline"
                          >
                            Delete {s.row_count} rows
                          </button>
                          <span className="text-[hsl(var(--muted-foreground))]">/</span>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="hover:underline"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(s.id)}
                          className="text-xs text-[hsl(var(--muted-foreground))] hover:text-red-500
                                     transition-colors"
                        >
                          Undo
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(step === "upload" || step === "done") && (
        <div className="mt-6">
          <ManageAccountsPanel profileId={profileId} />
        </div>
      )}
    </div>
  );
}
