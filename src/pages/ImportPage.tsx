import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  Calendar, Tag, DollarSign, BarChart2, Upload, Loader2, CheckCircle2, Info,
  Landmark, CreditCard, TrendingUp, HandCoins, AlertTriangle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  getDb, applyCategorizationRules, recomputeCalculatedBalances,
  listAccountsForProfile, resolveAccountId, setAccountInterestRate, setAccountMinimumPayment,
  getManualTransactionsForAccount, shiftBalanceAnchorForTransactionChange,
} from "@/lib/db";
import type { AccountChoice } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import { parseDate, parseAmount, dedupeRowHash, hashRow, findDuplicateCandidates } from "@/lib/importParsing";
import type { DuplicateCandidate } from "@/lib/importParsing";
import {
  parseInvestmentWorkbook, buildInvestmentRow, columnFillCount, sectionHasNoValueData,
  HOLDING_FIELDS, SUPPORTED_INVESTMENT_FORMATS,
} from "@/lib/investmentParsing";
import type { InvestmentRow, ParsedInvestment } from "@/lib/investmentParsing";
import type { CategorizationRule, Account, ActivityType } from "@/lib/types";
import { TRANSFER_CATEGORY_ID, EXCLUDED_CATEGORY_ID } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import { takePendingImportFiles } from "@/lib/pendingImport";
import { parsePdfStatement, extractPdfRows, parseLoanStatementFile } from "@/lib/pdfParse";
import InfoTooltip from "@/components/InfoTooltip";
import ManageAccountsPanel from "@/components/ManageAccountsPanel";
import LoanUploaderModal from "@/components/LoanUploaderModal";

type Step =
  | "upload" | "checking"
  | "wizard:account"
  | "wizard:data" | "wizard:date" | "wizard:desc" | "wizard:amount" | "wizard:balance"
  | "wizard:reconcile" | "wizard:preview"
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

/** Reads a CSV/XLSX/PDF bank or credit-card statement into raw string[][] rows (header row
 *  first) - shared by the interactive wizard (processFile) and the "Auto-Import All" batch
 *  path (autoImportFile) so every supported file type behaves the same in both. PDFs only ever
 *  yield a synthetic Date/Description/Amount header (see parsePdfStatement) since there's no
 *  real column structure to detect in a statement's text layer. XLSX uses the first sheet -
 *  multi-sheet investment workbooks are handled separately in processFile's investment branch. */
async function readStatementRows(file: File): Promise<string[][]> {
  if (/\.pdf$/i.test(file.name)) {
    const { headers, rows } = await parsePdfStatement(file);
    return [headers, ...rows];
  }
  if (/\.xlsx?$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false }) as unknown[][];
    return raw.map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))));
  }
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (r) => resolve(r.data as string[][]),
      error: (e) => reject(e),
    });
  });
}

type ImportKind = "bank" | "credit" | "investment";

interface ColMap {
  dateCol: number;
  descCol: number;
  amountCol: number;
  typeCol: number; // -1 = no transaction-type column
  balanceCol: number; // -1 = no running balance column
  invertAmounts: boolean; // true for banks that export expenses as positive (Discover, Amex)
  debitCol: number; // -1 = no separate debit column (banks with two amount columns, e.g. Capital One)
  creditCol: number; // -1 = no separate credit column
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
  /** Present for banks that export separate Debit/Credit amount columns instead of one signed
   *  amount column - when set, these take priority over amountKeywords. */
  debitKeywords?: string[];
  creditKeywords?: string[];
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
    debitKeywords: ["debit"],
    creditKeywords: ["credit"],
    note: "Capital One uses separate Debit and Credit columns - Compass reads both, so payments/refunds are no longer dropped.",
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
  if (preset.debitKeywords || preset.creditKeywords) {
    const debit = preset.debitKeywords ? findByKeywords(preset.debitKeywords) : -1;
    const credit = preset.creditKeywords ? findByKeywords(preset.creditKeywords) : -1;
    if (debit >= 0) result.debitCol = debit;
    if (credit >= 0) result.creditCol = credit;
  }
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
  /** How many imported rows were auto-categorized as Transfers/Excluded (e.g. a credit-card
   *  payment) - shown on the "done" screen so it's clear those won't double-count against
   *  income/expense totals. */
  transferCount?: number;
  /** Rows that failed for a reason OTHER than being an already-imported duplicate (e.g. a
   *  genuine constraint/data error) - kept separate from `skipped` so the summary never
   *  reassures the user that a real failure was "just a duplicate". */
  errors?: { index: number; message: string }[];
  /** From the reconcile step - rows the user chose to skip because they already had a
   *  matching manual entry, and manual entries the user chose to replace with the imported
   *  version instead. Both default to 0/undefined when no possible duplicates were found. */
  keptManualCount?: number;
  replacedManualCount?: number;
  /** Statement activity lines (trades, dividends, transfers) written alongside the holdings
   *  snapshot - only brokerage statements carry these, portfolio exports never do. */
  activityImported?: number;
}

interface ImportSession {
  id: number;
  filename: string;
  imported_at: string;
  row_count: number;
  skipped_count: number;
  kind: "bank" | "investment" | "loan";
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
  // The reconcile step is an interstitial gate shown only when duplicates are found - it
  // shares Preview's bubble number rather than getting its own, so skipping it entirely
  // (the common case) doesn't shift every later step's number.
  if (step === "wizard:reconcile") return 7;
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
    debitCol: -1,
    creditCol: -1,
  };
}

/** Computes the signed dollar amount for one row, given the active column mapping. When
 *  `debitCol`/`creditCol` are both set (banks with two amount columns, e.g. Capital One), a
 *  non-blank debit cell means an expense (negative) and a non-blank credit cell means a credit
 *  (positive) - whichever cell actually has a value wins, since a row typically populates only
 *  one of the two. Falls back to the existing single-amount-column logic otherwise. */
function computeRowAmount(row: string[], colMap: ColMap): number {
  if (colMap.debitCol >= 0 || colMap.creditCol >= 0) {
    const debitRaw = colMap.debitCol >= 0 ? (row[colMap.debitCol] ?? "").trim() : "";
    const creditRaw = colMap.creditCol >= 0 ? (row[colMap.creditCol] ?? "").trim() : "";
    if (debitRaw) return -Math.abs(parseAmount(debitRaw));
    if (creditRaw) return Math.abs(parseAmount(creditRaw));
    return 0;
  }
  const rawAmount = parseAmount(row[colMap.amountCol] ?? "0");
  let amount = rawAmount;
  if (colMap.typeCol >= 0) {
    const typeVal = (row[colMap.typeCol] ?? "").trim().toLowerCase();
    if (typeVal === "debit") amount = -Math.abs(rawAmount);
    else if (typeVal === "credit") amount = Math.abs(rawAmount);
  }
  if (colMap.invertAmounts) amount = -amount;
  return amount;
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

// ─── Investment portfolio import ───────────────────────────────────────────────
// The parsers themselves live in src/lib/investmentParsing.ts so they're testable.

/** Display labels for a statement activity line's type. */
const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  buy: "Buy", sell: "Sell", dividend: "Dividend", reinvest: "Reinvestment",
  interest: "Interest", deposit: "Deposit", withdrawal: "Withdrawal",
  transfer: "Transfer", fee: "Fee", tax: "Tax", other: "Other",
};

const IMPORT_KINDS: { id: ImportKind; label: string; hint: string; Icon: typeof Landmark }[] = [
  { id: "bank", label: "Bank Statement", hint: "Checking or savings CSV/XLSX export", Icon: Landmark },
  { id: "credit", label: "Credit Card Statement", hint: "Credit card CSV/XLSX export", Icon: CreditCard },
  { id: "investment", label: "Investment / Brokerage", hint: "Portfolio positions export or a brokerage/401(k) statement (holdings, trades, dividends)", Icon: TrendingUp },
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
  // Optional APR/minimum payment entered/edited on the "which account" step for credit imports
  // only - purely informational (same as a loan's rate/payment), lets credit cards join
  // Avalanche/Cash-flow ranking on the Debt Dashboard without a separate settings screen.
  const [creditInterestRateInput, setCreditInterestRateInput] = useState("");
  const [creditMinimumPaymentInput, setCreditMinimumPaymentInput] = useState("");
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [currentFilename, setCurrentFilename] = useState("");
  const [isPdfImport, setIsPdfImport] = useState(false);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [colMap, setColMap] = useState<ColMap>({ dateCol: 0, descCol: 1, amountCol: 2, typeCol: -1, balanceCol: -1, invertAmounts: false, debitCol: -1, creditCol: -1 });
  const [currentBalanceInput, setCurrentBalanceInput] = useState("");
  // Best-effort "New/Current Balance" figure read straight off a credit-card PDF statement
  // (findLabeledValue-based, same machinery as the loan uploader) - only ever used to prefill
  // `currentBalanceInput`, never saved without the user seeing/confirming it first.
  const [parsedStatementBalance, setParsedStatementBalance] = useState<string | null>(null);
  // Possible duplicates of already-existing manual transactions, found when leaving the
  // "Balance" step - only ever populated (and the reconcile step only ever shown) when at
  // least one is found; each item's `resolution` defaults to "keep_both" (never destructive
  // unless the user explicitly says otherwise).
  const [dupCandidates, setDupCandidates] = useState<(DuplicateCandidate & { resolution: "keep_both" | "keep_manual" | "keep_imported" })[]>([]);
  const [profileFound, setProfileFound] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  // Set when an import would land on a snapshot date this account already has - the preview
  // step then asks whether to replace it rather than silently doubling every position.
  const [duplicateSnapshot, setDuplicateSnapshot] = useState<{ accountId: number; count: number; profileIdOverride?: number } | null>(null);
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
  const [showLoanUploader, setShowLoanUploader] = useState(false);
  // Remembers which concrete account the previous file in THIS import session resolved to,
  // keyed by account type - `finishParsingData`/`finishParsingInvestmentData` reset
  // `accountChoice` to null for every new file (so a genuinely different file can be
  // re-detected fresh), but a multi-file batch is overwhelmingly likely to be several
  // statements for the SAME account. Without this, a file that doesn't match any bank preset
  // (common for credit cards) falls back to "new account" on every file after the first,
  // silently creating a duplicate account per file instead of reusing the one the user
  // already picked/created and entered a balance for.
  const lastResolvedAccountRef = useRef<{ accountType: string; accountId: number } | null>(null);

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
  // relevant type and suggest a match - preferring the account this same import session
  // already resolved to (if any) over a fresh bank-preset/institution-name guess, since a
  // multi-file batch is almost always several statements for the SAME account - but never
  // clobber a choice the user already made (e.g. navigating back to this step).
  useEffect(() => {
    if (step !== "wizard:account") return;
    const accountType = importKind === "credit" ? "credit" : importKind === "investment" ? "investment" : "checking";
    (async () => {
      try {
        const accounts = await listAccountsForProfile(profileId, accountType);
        setExistingAccountsForType(accounts);
        if (accountChoice) return;
        if (lastResolvedAccountRef.current?.accountType === accountType) {
          const prior = accounts.find((a) => a.id === lastResolvedAccountRef.current!.accountId);
          if (prior) {
            setAccountChoice({ mode: "existing", accountId: prior.id, name: prior.name });
            if (importKind === "credit") {
              setCreditInterestRateInput(prior.interest_rate_bps != null ? (prior.interest_rate_bps / 100).toFixed(2) : "");
              setCreditMinimumPaymentInput(prior.minimum_payment_cents != null ? (prior.minimum_payment_cents / 100).toFixed(2) : "");
            }
            return;
          }
        }
        const detectedName = selectedPresetId ? BANK_PRESETS[selectedPresetId]?.name ?? null : null;
        if (detectedName) {
          const needle = detectedName.toLowerCase();
          const match = accounts.find(
            (a) => a.name.toLowerCase().includes(needle) || a.institution.toLowerCase().includes(needle)
          );
          if (match) {
            setAccountChoice({ mode: "existing", accountId: match.id, name: match.name });
            if (importKind === "credit") {
              setCreditInterestRateInput(match.interest_rate_bps != null ? (match.interest_rate_bps / 100).toFixed(2) : "");
              setCreditMinimumPaymentInput(match.minimum_payment_cents != null ? (match.minimum_payment_cents / 100).toFixed(2) : "");
            }
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

  // When there's no balance column, prefill "Current balance" - preferring a figure freshly
  // parsed off this statement (credit-card PDFs only) over the account's last-saved anchor.
  // Either way, the stored anchor by itself is stale the moment this step is reached: it
  // reflects the balance BEFORE this batch's transactions, but the field means "balance AFTER
  // these transactions" - so it's added to this batch's own signed total (every row here is
  // new, not yet reflected in the stored anchor at all). Submitting the suggested value
  // unedited must already be correct, exactly like every other parsed field in this wizard -
  // this only ever pre-fills the editable input below, never saves anything by itself.
  useEffect(() => {
    if (step !== "wizard:balance" || colMap.balanceCol >= 0) return;
    if (parsedStatementBalance) { setCurrentBalanceInput(parsedStatementBalance); return; }
    if (!accountChoice || accountChoice.mode !== "existing") { setCurrentBalanceInput(""); return; }
    (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<{ balance_anchor_cents: number | null }[]>(
          "SELECT balance_anchor_cents FROM accounts WHERE id=?",
          [accountChoice.accountId]
        );
        const cents = rows[0]?.balance_anchor_cents;
        if (cents == null) { setCurrentBalanceInput(""); return; }
        const newRowsCents = parsed
          ? parsed.rows.reduce((sum, row) => sum + Math.round(computeRowAmount(row, colMap) * 100), 0)
          : 0;
        setCurrentBalanceInput(((cents + newRowsCents) / 100).toFixed(2));
      } catch { /* leave blank */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, parsedStatementBalance, parsed]);


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

  /** Gate between the wizard's column-mapping steps and Preview - checks incoming rows against
   *  this account's existing manually-added transactions for possible duplicates (see
   *  importParsing.ts) and, only if any are found, detours through the reconcile step instead
   *  of going straight to Preview. A brand-new account has no manual transactions to conflict
   *  with, so this is a no-op (straight to Preview) in that case. */
  const proceedToPreview = async () => {
    if (!parsed || !accountChoice || accountChoice.mode !== "existing") {
      wizardGo("wizard:preview", "forward");
      return;
    }
    const manualTxns = await getManualTransactionsForAccount(accountChoice.accountId);
    if (manualTxns.length === 0) {
      wizardGo("wizard:preview", "forward");
      return;
    }
    const importedRows = parsed.rows
      .map((row, rowIndex) => {
        const date = parseDate(row[colMap.dateCol] ?? "");
        const description = (row[colMap.descCol] ?? "").trim();
        const amount = computeRowAmount(row, colMap);
        if (!date || !description || !isFinite(amount) || amount === 0) return null;
        return { rowIndex, date, description, amountCents: Math.round(amount * 100) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const candidates = findDuplicateCandidates(importedRows, manualTxns);
    if (candidates.length === 0) {
      wizardGo("wizard:preview", "forward");
      return;
    }
    setDupCandidates(candidates.map((c) => ({ ...c, resolution: "keep_both" as const })));
    wizardGo("wizard:reconcile", "forward");
  };

  const undoImport = async (sessionId: number) => {
    const db = await getDb();
    const session = importHistory.find((s) => s.id === sessionId);
    if (session?.kind === "investment") {
      await db.execute("DELETE FROM holdings WHERE import_session_id=?", [sessionId]);
      await db.execute("DELETE FROM investment_activity WHERE import_session_id=?", [sessionId]);
      await db.execute("DELETE FROM investment_summaries WHERE import_session_id=?", [sessionId]);
    } else if (session?.kind === "loan") {
      // Loan statement rows carry their own definitive balance_cents per upload (not a
      // computed running total from an anchor), so there's nothing to recompute after
      // removing one - the account's "latest balance" just falls back to whichever
      // statement (if any) remains.
      await db.execute("DELETE FROM transactions WHERE import_session_id=?", [sessionId]);
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

  /**
   * Writes a parsed statement: holdings as a new dated snapshot, plus the period's activity
   * rows and account-level totals for formats that carry them. `replaceExisting` re-imports a
   * snapshot date that already has holdings (the wizard asks first - never silent).
   */
  const handleInvestmentImport = async (profileIdOverride?: number, replaceExisting = false) => {
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
      lastResolvedAccountRef.current = { accountType: "investment", accountId };

      // A holdings snapshot has no content hash to dedup on (unlike transactions), so a repeat
      // import of the same statement would silently double every position. Ask, don't guess.
      const [existing] = await db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM holdings WHERE account_id=? AND as_of_date=?",
        [accountId, invParsed.asOfDate]
      );
      if ((existing?.n ?? 0) > 0) {
        if (!replaceExisting) {
          setDuplicateSnapshot({ accountId, count: existing.n, profileIdOverride });
          setStep("wizard:investment-preview");
          return;
        }
        await db.execute("DELETE FROM holdings WHERE account_id=? AND as_of_date=?", [accountId, invParsed.asOfDate]);
      }
      setDuplicateSnapshot(null);

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

      // Unlike holdings, activity lines DO have stable content to hash, so re-importing an
      // overlapping statement skips rows it already has instead of duplicating them.
      let activityImported = 0;
      let activitySkipped = 0;
      for (const act of invParsed.activity) {
        const importHash = await hashRow([
          "inv", act.date, act.rawActivityType, act.description,
          String(act.quantity ?? ""), String(act.amount),
        ]);
        try {
          await db.execute(
            `INSERT INTO investment_activity
               (account_id, profile_id, import_session_id, trade_date, settle_date, activity_type,
                raw_activity_type, symbol, description, quantity, price_cents, amount_cents,
                cost_basis_cents, realized_gain_cents, acquired_date, term, import_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              accountId, targetProfileId, sessionId, act.date, act.settleDate, act.activityType,
              act.rawActivityType, act.symbol, act.description, act.quantity,
              act.price !== null ? Math.round(act.price * 100) : null,
              Math.round(act.amount * 100),
              act.costBasis !== null ? Math.round(act.costBasis * 100) : null,
              act.realizedGain !== null ? Math.round(act.realizedGain * 100) : null,
              act.acquiredDate, act.term, importHash,
            ]
          );
          activityImported++;
        } catch {
          activitySkipped++; // UNIQUE(account_id, import_hash) - already imported
        }
      }

      if (invParsed.summary) {
        const s = invParsed.summary;
        const cents = (v: number | null) => (v !== null ? Math.round(v * 100) : null);
        await db.execute(
          `INSERT INTO investment_summaries
             (account_id, profile_id, import_session_id, period_start, period_end,
              beginning_value_cents, ending_value_cents, change_in_value_cents, cash_balance_cents,
              deposits_cents, withdrawals_cents, transfers_cents, income_cents, dividends_cents,
              interest_cents, fees_cents, realized_gain_cents, realized_gain_ytd_cents,
              unrealized_gain_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, period_end) DO UPDATE SET
             import_session_id=excluded.import_session_id,
             period_start=excluded.period_start,
             beginning_value_cents=excluded.beginning_value_cents,
             ending_value_cents=excluded.ending_value_cents,
             change_in_value_cents=excluded.change_in_value_cents,
             cash_balance_cents=excluded.cash_balance_cents,
             deposits_cents=excluded.deposits_cents,
             withdrawals_cents=excluded.withdrawals_cents,
             transfers_cents=excluded.transfers_cents,
             income_cents=excluded.income_cents,
             dividends_cents=excluded.dividends_cents,
             interest_cents=excluded.interest_cents,
             fees_cents=excluded.fees_cents,
             realized_gain_cents=excluded.realized_gain_cents,
             realized_gain_ytd_cents=excluded.realized_gain_ytd_cents,
             unrealized_gain_cents=excluded.unrealized_gain_cents`,
          [
            accountId, targetProfileId, sessionId, s.periodStart, s.periodEnd,
            cents(s.beginningValue), cents(s.endingValue), cents(s.changeInValue), cents(s.cashBalance),
            cents(s.deposits), cents(s.withdrawals), cents(s.transfers), cents(s.income),
            cents(s.dividends), cents(s.interest), cents(s.fees),
            cents(s.realizedGain), cents(s.realizedGainYtd), cents(s.unrealizedGain),
          ]
        );
      }

      await db.execute("UPDATE import_sessions SET row_count=?, skipped_count=? WHERE id=?",
        [imported + activityImported, activitySkipped, sessionId]);
      setSummary({ imported, skipped: activitySkipped, activityImported });
      await loadHistory();
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("wizard:investment-preview");
    }
  };

  const processFile = useCallback((file: File) => {
    setError(null);

    const MAX_IMPORT_FILE_BYTES = 75 * 1024 * 1024; // 75MB - generous for any real statement export
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setError(`"${file.name}" is too large to import (${(file.size / (1024 * 1024)).toFixed(0)}MB, limit is 75MB). Split it into smaller statements and try again.`);
      return;
    }

    setStep("checking");
    setCurrentFilename(file.name);

    const isPdf = /\.pdf$/i.test(file.name);
    setIsPdfImport(isPdf);
    if (isPdf) {
      if (importKind === "investment") {
        extractPdfRows(file).then((data) => {
          if (data.length < 2) {
            setError("Couldn't find any recognizable holdings table in that PDF. It may be a scanned/image statement (no selectable text) - try a CSV/XLSX export from your brokerage instead.");
            setStep("upload");
            return;
          }
          finishParsingInvestmentData(data);
        }).catch(() => {
          setError("Could not read that PDF. Make sure it's a valid, text-based statement.");
          setStep("upload");
        });
        return;
      }
      parsePdfStatement(file).then(({ rows, looksLikeLoanStatement }) => {
        if (rows.length === 0) {
          setError(
            looksLikeLoanStatement
              ? "Couldn't find an itemized transaction table in that PDF - it looks like a loan statement, which tracks a balance over time rather than individual transactions. Use the \"Loan Statement\" option on the import screen instead."
              : "Couldn't find any transactions in that PDF. It may be a scanned/image statement (no selectable text), which isn't supported - try a CSV/XLSX export from your bank instead."
          );
          setStep("upload");
          return;
        }
        finishParsingData([["Date", "Description", "Amount"], ...rows]);
        // Credit-card statements almost never have a per-transaction running-balance column,
        // so this is the only shot at pre-filling "Current balance" from the statement itself
        // rather than the account's last-saved anchor - kicked off after finishParsingData (which
        // resets parsedStatementBalance to null for the new file) so it can't be clobbered by that
        // reset resolving out of order.
        if (importKind === "credit") {
          parseLoanStatementFile(file).then((fields) => {
            if (fields.balance) setParsedStatementBalance(fields.balance);
          }).catch(() => { /* best-effort only - leave blank */ });
        }
      }).catch(() => {
        setError("Could not read that PDF. Make sure it's a valid, text-based statement.");
        setStep("upload");
      });
      return;
    }

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
      setError(`We couldn't detect a supported portfolio format. Supported formats: ${SUPPORTED_INVESTMENT_FORMATS}.`);
      setStep("upload");
      return;
    }
    setInvParsed(result);
    setColMapOverrides({});
    setFixColumnsOpen(new Set());
    setAccountChoice(null);
    setExistingAccountsForType([]);
    setCreditInterestRateInput("");
    setCreditMinimumPaymentInput("");
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
    setCreditInterestRateInput("");
    setCreditMinimumPaymentInput("");
    setParsedStatementBalance(null);
    setDupCandidates([]);
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
          type_col: number; balance_col: number; invert_amounts: number;
          debit_col: number; credit_col: number;
        }[]>(
          `SELECT date_col, desc_col, amount_col, COALESCE(type_col, -1) as type_col,
                  COALESCE(balance_col, -1) as balance_col, COALESCE(invert_amounts, 0) as invert_amounts,
                  COALESCE(debit_col, -1) as debit_col, COALESCE(credit_col, -1) as credit_col
           FROM column_profiles WHERE header_sig=? AND profile_id=?`,
          [sig, profileId]
        );
        if (colProfiles.length > 0) {
          const p = colProfiles[0];
          // A stored TRUE always wins (an explicit user/preset choice, persisted since v28).
          // A stored FALSE could just mean "never explicitly saved" (migrated default), so it
          // still falls back to fingerprint detection - preserves old behavior (e.g. Amex) for
          // profiles saved before invertAmounts was persisted.
          const fpId = detectPresetByFingerprint(headers);
          const fingerprintInvert = (fpId && BANK_PRESETS[fpId]?.invertAmounts) ? BANK_PRESETS[fpId].invertAmounts! : false;
          const restoredInvert = p.invert_amounts === 1 ? true : fingerprintInvert;
          setColMap({
            dateCol: p.date_col, descCol: p.desc_col, amountCol: p.amount_col,
            typeCol: p.type_col, balanceCol: p.balance_col, invertAmounts: restoredInvert,
            debitCol: p.debit_col, creditCol: p.credit_col,
          });
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
      const files = Array.from(e.dataTransfer.files).filter((f) => /\.(csv|xlsx?|pdf)$/i.test(f.name));
      if (files.length === 0) { setError("Please drop one or more .csv, .xlsx, or .pdf files."); return; }
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
    if (!parsed || importSubmitting) return;
    setImportSubmitting(true);
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
      lastResolvedAccountRef.current = { accountType: importKind === "credit" ? "credit" : "checking", accountId };
      if (importKind === "credit" && creditInterestRateInput.trim()) {
        // Only touches the rate when the user actually typed one - an empty field on a later
        // import of the same card must never silently wipe out a rate set previously.
        await setAccountInterestRate(accountId, Math.round(parseFloat(creditInterestRateInput.trim()) * 100));
      }
      if (importKind === "credit" && creditMinimumPaymentInput.trim()) {
        // Same "only touch when typed" guard as the interest rate above.
        await setAccountMinimumPayment(accountId, Math.round(parseAmount(creditMinimumPaymentInput.trim()) * 100));
      }
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
      let transferCount = 0;
      // From the reconcile step (only ever non-zero when possible duplicates were found and
      // resolved) - tracked separately from `skipped` since that specifically means "already-
      // imported duplicate via content hash", a different situation from "user chose to keep
      // their manual entry instead".
      let keptManualCount = 0;
      let replacedManualCount = 0;
      let deletedAnyManual = false;
      const dupByRow = new Map(dupCandidates.map((c) => [c.rowIndex, c]));
      const rowErrors: { index: number; message: string }[] = [];

      const seenHashCounts = new Map<string, number>();
      const rowPayloads: { params: unknown[]; categoryId: number | null }[] = [];

      for (let rowIndex = 0; rowIndex < parsed.rows.length; rowIndex++) {
        const row = parsed.rows[rowIndex];
        const requiredCols = [colMap.dateCol, colMap.descCol];
        if (colMap.debitCol >= 0 || colMap.creditCol >= 0) {
          if (colMap.debitCol >= 0) requiredCols.push(colMap.debitCol);
          if (colMap.creditCol >= 0) requiredCols.push(colMap.creditCol);
        } else {
          requiredCols.push(colMap.amountCol);
        }
        if (colMap.typeCol >= 0) requiredCols.push(colMap.typeCol);
        const maxIdx = Math.max(...requiredCols);
        if (row.length <= maxIdx) continue;
        const date = parseDate(row[colMap.dateCol] ?? "");
        const description = (row[colMap.descCol] ?? "").trim();
        const amount = computeRowAmount(row, colMap);
        if (!date || !description || !isFinite(amount) || amount === 0) continue;

        const dup = dupByRow.get(rowIndex);
        if (dup?.resolution === "keep_manual") { keptManualCount++; continue; }
        if (dup?.resolution === "keep_imported") {
          // Remove the manual entry this row is replacing FIRST, shifting the balance anchor by
          // its removal exactly like any other manual delete (see shiftBalanceAnchorForTransactionChange) -
          // the new row below then gets inserted as if the manual one never existed.
          await db.execute("DELETE FROM transactions WHERE id=?", [dup.existingTxnId]);
          await shiftBalanceAnchorForTransactionChange(
            accountId,
            { date: dup.existingDate, amountCents: dup.existingAmountCents },
            null
          );
          replacedManualCount++;
          deletedAnyManual = true;
        }

        const amountCents = Math.round(amount * 100);
        const hash = await dedupeRowHash(row, seenHashCounts);
        const categoryId = applyCategorizationRules(description, rules, amountCents);
        // Credit card statements print the amount you owe as a positive number, but that's a
        // liability - always store it negative, regardless of the file's own sign convention.
        const balanceCents = colMap.balanceCol >= 0 && row[colMap.balanceCol]
          ? (() => { const c = Math.round(parseAmount(row[colMap.balanceCol]) * 100); return importKind === "credit" ? -Math.abs(c) : c; })()
          : null;

        rowPayloads.push({
          params: [accountId, date, amountCents, description, categoryId, hash, balanceCents, profileId, sessionId],
          categoryId,
        });
      }

      if (rowPayloads.length > 0) {
        const result = await db.importTransactionsBatch(
          rowPayloads.map((p) => ({
            sql: `INSERT INTO transactions
                    (account_id, date, amount_cents, description, category_id, import_hash,
                     balance_cents, profile_id, import_session_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: p.params,
          }))
        );
        const duplicateSet = new Set(result.duplicateIndices);
        const errorSet = new Set(result.errors.map((e) => e.index));
        rowErrors.push(...result.errors);
        rowPayloads.forEach((p, i) => {
          if (errorSet.has(i)) return;
          if (duplicateSet.has(i)) { skipped++; return; }
          imported++;
          if (p.categoryId === TRANSFER_CATEGORY_ID || p.categoryId === EXCLUDED_CATEGORY_ID) transferCount++;
        });
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
        `INSERT INTO column_profiles
           (header_sig, date_col, desc_col, amount_col, type_col, balance_col, profile_id,
            invert_amounts, debit_col, credit_col)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, header_sig) DO UPDATE SET
           date_col       = excluded.date_col,
           desc_col       = excluded.desc_col,
           amount_col     = excluded.amount_col,
           type_col       = excluded.type_col,
           balance_col    = excluded.balance_col,
           invert_amounts = excluded.invert_amounts,
           debit_col      = excluded.debit_col,
           credit_col     = excluded.credit_col`,
        [sig, colMap.dateCol, colMap.descCol, colMap.amountCol, colMap.typeCol, colMap.balanceCol, profileId,
         colMap.invertAmounts ? 1 : 0, colMap.debitCol, colMap.creditCol]
      );

      // No native balance column - (re)calculate a running balance for every transaction on
      // this account from its balance anchor (or 0), so charts/dashboards still have a value.
      // Also needed whenever a manual duplicate was deleted above, regardless of balanceCol -
      // the surrounding rows that relied on calculated balances still need to reflect its removal.
      if (colMap.balanceCol < 0 || deletedAnyManual) {
        await recomputeCalculatedBalances(accountId);
      }

      setSummary({ imported, skipped, transferCount, errors: rowErrors, keptManualCount, replacedManualCount });
      await loadHistory();
      setStep("done");
      setImportSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("wizard:preview");
      setImportSubmitting(false);
    }
  };

  /** Silently import a file using a previously approved column mapping (batch auto-mode). Does
   *  NOT run manual-duplicate reconciliation (see proceedToPreview/wizard:reconcile) - pausing
   *  an unattended batch mid-flight for input would break its whole "silent" contract, so this
   *  path always behaves like "keep both" for any manual entry a row might actually duplicate. */
  const autoImportFile = useCallback(async (file: File, savedColMap: ColMap) => {
    setError(null);
    setCurrentFilename(file.name);
    setStep("importing");
    let data: string[][];
    try {
      data = await readStatementRows(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSummary({ imported: 0, skipped: 0 });
      setStep("done");
      return;
    }
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
      lastResolvedAccountRef.current = { accountType: importKind === "credit" ? "credit" : "checking", accountId };
      const rules = await db.select<CategorizationRule[]>(
        "SELECT * FROM categorization_rules WHERE profile_id=? OR profile_id IS NULL ORDER BY priority DESC",
        [profileId]
      );
      const sessionResult = await db.execute(
        "INSERT INTO import_sessions (filename, row_count, skipped_count, profile_id) VALUES (?, 0, 0, ?)",
        [file.name, profileId]
      );
      const sessionId = sessionResult.lastInsertId as number;
      let imported = 0; let skipped = 0; let transferCount = 0;
      const rowErrors: { index: number; message: string }[] = [];
      const seenHashCounts = new Map<string, number>();
      const rowPayloads: { params: unknown[]; categoryId: number | null }[] = [];
      for (const row of derived.rows) {
        const reqCols = [savedColMap.dateCol, savedColMap.descCol];
        if (savedColMap.debitCol >= 0 || savedColMap.creditCol >= 0) {
          if (savedColMap.debitCol >= 0) reqCols.push(savedColMap.debitCol);
          if (savedColMap.creditCol >= 0) reqCols.push(savedColMap.creditCol);
        } else {
          reqCols.push(savedColMap.amountCol);
        }
        if (savedColMap.typeCol >= 0) reqCols.push(savedColMap.typeCol);
        if (row.length <= Math.max(...reqCols)) continue;
        const date = parseDate(row[savedColMap.dateCol] ?? "");
        const description = (row[savedColMap.descCol] ?? "").trim();
        const amount = computeRowAmount(row, savedColMap);
        if (!date || !description || !isFinite(amount) || amount === 0) continue;
        const amountCents = Math.round(amount * 100);
        const hash = await dedupeRowHash(row, seenHashCounts);
        const categoryId = applyCategorizationRules(description, rules, amountCents);
        const balanceCents = savedColMap.balanceCol >= 0 && row[savedColMap.balanceCol]
          ? (() => { const c = Math.round(parseAmount(row[savedColMap.balanceCol]) * 100); return importKind === "credit" ? -Math.abs(c) : c; })() : null;
        rowPayloads.push({
          params: [accountId, date, amountCents, description, categoryId, hash, balanceCents, profileId, sessionId],
          categoryId,
        });
      }
      if (rowPayloads.length > 0) {
        const result = await db.importTransactionsBatch(
          rowPayloads.map((p) => ({
            sql: `INSERT INTO transactions (account_id, date, amount_cents, description, category_id,
                    import_hash, balance_cents, profile_id, import_session_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: p.params,
          }))
        );
        const duplicateSet = new Set(result.duplicateIndices);
        const errorSet = new Set(result.errors.map((e) => e.index));
        rowErrors.push(...result.errors);
        rowPayloads.forEach((p, i) => {
          if (errorSet.has(i)) return;
          if (duplicateSet.has(i)) { skipped++; return; }
          imported++;
          if (p.categoryId === TRANSFER_CATEGORY_ID || p.categoryId === EXCLUDED_CATEGORY_ID) transferCount++;
        });
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
      setSummary({ imported, skipped, transferCount, errors: rowErrors });
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
    setDuplicateSnapshot(null);
    setColMapOverrides({});
    setFixColumnsOpen(new Set());
    setCurrentBalanceInput("");
    setAccountChoice(null);
    setExistingAccountsForType([]);
    setCreditInterestRateInput("");
    setCreditMinimumPaymentInput("");
    setParsedStatementBalance(null);
    setDupCandidates([]);
    setMaxStepReached(1);
    setCurrentFilename("");
    setIsPdfImport(false);
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
    lastResolvedAccountRef.current = null;
  };

  return (
    <div className="p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-2xl font-semibold mb-2">Import Statements</h1>
      <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
        Your data never leaves this device.
      </p>

      {(step === "upload" || step === "done") && (
        <div className="mb-6">
          <ManageAccountsPanel profileId={profileId} />
        </div>
      )}

      {step === "upload" && importKind === null && (
        <div className="space-y-3">
          <p className="text-sm font-medium">What are you importing?</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
            <button
              onClick={() => setShowLoanUploader(true)}
              className="border rounded-xl p-5 text-center hover:border-[hsl(var(--primary))] hover:bg-[hsl(var(--muted))] transition-colors chart-clickable"
            >
              <div className="flex justify-center mb-2 text-[hsl(var(--primary))]"><HandCoins size={26} /></div>
              <p className="font-medium text-sm">Loan Statement</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">Car, student, personal loan, or mortgage - balance snapshot, not itemized transactions</p>
            </button>
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
                : "Drop your CSV, XLSX, or PDF statement here or click to browse"}
            </p>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              {importKind === "investment"
                ? "Works with Wells Fargo Advisors, Fidelity, and Thrivent exports (CSV, XLSX, or PDF)"
                : "Works with exports from any bank or credit card"}
            </p>
          </div>
          <input
            id="csv-input"
            type="file"
            accept=".csv,.xlsx,.xls,.pdf"
            multiple
            className="hidden"
            onChange={handleFileInput}
          />

          {/* Bank preset picker */}
          {step === "upload" && importKind !== "investment" && (
            <div data-tour="import-presets" className="mt-5 border rounded-xl p-4 space-y-3">
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
                <p className="text-xs text-[hsl(var(--success))] flex items-center gap-1"><CheckCircle2 size={12} /> {BANK_PRESETS[selectedPresetId].name} selected - column mapping will be pre-filled.</p>
              )}
            </div>
          )}

          {error && <p className="mt-4 text-[hsl(var(--error))] text-sm">{error}</p>}
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
                        ? "bg-[hsl(var(--success))] text-white cursor-pointer hover:opacity-80"
                        : "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] cursor-not-allowed"
                    }`}>
                    {wizardNum(step) > ws.num ? "✓" : ws.num}
                  </button>
                  {i < WIZARD_STEPS.length - 1 && (
                    <div className={`h-0.5 w-6 transition-colors ${wizardNum(step) > ws.num ? "bg-[hsl(var(--success))]" : "bg-[hsl(var(--muted))]"}`} />
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
              <div className="px-3 py-2.5 rounded-lg text-sm border border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)]
                              text-[hsl(var(--success))] dark:border-[hsl(var(--success)/0.5)] dark:bg-[hsl(var(--success)/0.15)] flex items-start gap-2">
                <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                <span>This looks like your existing <strong>{accountChoice.name}</strong> account - we'll add these transactions there.</span>
              </div>
            )}
            {accountChoice?.mode === "new" && existingAccountsForType.length > 0 && (
              <div className="px-3 py-2.5 rounded-lg text-sm border border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.08)]
                              text-[hsl(var(--primary))] dark:border-[hsl(var(--primary)/0.5)] dark:bg-[hsl(var(--primary)/0.15)] flex items-start gap-2">
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
                  if (acct) {
                    setAccountChoice({ mode: "existing", accountId: acct.id, name: acct.name });
                    if (importKind === "credit") {
                      setCreditInterestRateInput(acct.interest_rate_bps != null ? (acct.interest_rate_bps / 100).toFixed(2) : "");
                      setCreditMinimumPaymentInput(acct.minimum_payment_cents != null ? (acct.minimum_payment_cents / 100).toFixed(2) : "");
                    }
                  }
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

            {importKind === "credit" && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                  Interest Rate (APR) <span className="normal-case">(optional)</span>
                </label>
                <input
                  type="number" step="0.01" min="0"
                  value={creditInterestRateInput}
                  onChange={(e) => setCreditInterestRateInput(e.target.value)}
                  placeholder="e.g. 24.99"
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
                />
                <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                  Purely informational - lets this card join Avalanche ranking on the Debt Dashboard. Never used to calculate interest.
                </p>
              </div>
            )}

            {importKind === "credit" && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
                  Minimum Payment <span className="normal-case">(optional)</span>
                </label>
                <input
                  type="number" step="0.01" min="0"
                  value={creditMinimumPaymentInput}
                  onChange={(e) => setCreditMinimumPaymentInput(e.target.value)}
                  placeholder="e.g. 35.00"
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
                />
                <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                  Purely informational - lets this card join Cash-flow-First ranking on the Debt Dashboard and improves the Debt Payoff plan's estimate.
                </p>
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
            <div className="px-4 py-2.5 rounded-lg text-sm border border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)]
                            text-[hsl(var(--success))] dark:border-[hsl(var(--success)/0.5)] dark:bg-[hsl(var(--success)/0.15)]">
                  Column layout recognized from a previous import.
            </div>
          )}

          <div className="flex gap-3 justify-center">
            <button onClick={() => wizardGo(backTargetFor(step), "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={proceedToPreview}
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
                    <p className={`text-base font-semibold mt-0.5 ${ok ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
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
            <button onClick={proceedToPreview}
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
            <button onClick={proceedToPreview}
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
                {parsed.rows.filter((r) => (colMap.debitCol >= 0 || colMap.creditCol >= 0)
                  ? (colMap.debitCol >= 0 && r[colMap.debitCol]) || (colMap.creditCol >= 0 && r[colMap.creditCol])
                  : r[colMap.amountCol]).slice(0, 6).map((row, i) => {
                  const raw = colMap.debitCol >= 0 || colMap.creditCol >= 0
                    ? (row[colMap.debitCol] || row[colMap.creditCol] || "")
                    : (row[colMap.amountCol] ?? "");
                  const amt = computeRowAmount(row, colMap);
                  const desc = colMap.descCol >= 0 ? (row[colMap.descCol] ?? "").trim() : "";
                  return (
                    <div key={i} className="py-3 px-3 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        {desc && (
                          <p className="text-xs text-[hsl(var(--foreground))] truncate" title={desc}>{desc}</p>
                        )}
                        <p className="font-mono text-xs text-[hsl(var(--muted-foreground))] truncate">{raw}</p>
                      </div>
                      <p className={`font-mono text-base font-semibold shrink-0 ${amt < 0 ? "text-[hsl(var(--error))]" : amt > 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--warning))]"}`}>
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
              <div className="flex gap-3 text-sm flex-wrap">
                <button
                  onClick={() => setColMap((m) => ({ ...m, typeCol: -1, debitCol: -1, creditCol: -1 }))}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.typeCol === -1 && colMap.debitCol === -1 && colMap.creditCol === -1 ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                >
                  No - amounts are already signed
                </button>
                <button
                  onClick={() => {
                    const typeGuess = parsed.headers.findIndex((h) => h.toLowerCase().includes("type") && !h.toLowerCase().includes("amount"));
                    setColMap((m) => ({ ...m, typeCol: typeGuess >= 0 ? typeGuess : 0, debitCol: -1, creditCol: -1 }));
                  }}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.typeCol >= 0 ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                >
                  Yes - one Transaction Type column
                </button>
                <button
                  onClick={() => {
                    const debitGuess = parsed.headers.findIndex((h) => h.toLowerCase().includes("debit"));
                    const creditGuess = parsed.headers.findIndex((h) => h.toLowerCase().includes("credit"));
                    setColMap((m) => ({ ...m, typeCol: -1, debitCol: debitGuess >= 0 ? debitGuess : 0, creditCol: creditGuess >= 0 ? creditGuess : 0 }));
                  }}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${colMap.debitCol >= 0 || colMap.creditCol >= 0 ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
                >
                  Yes - separate Debit and Credit columns
                </button>
              </div>
              {colMap.typeCol >= 0 && (
                <select value={colMap.typeCol}
                  onChange={(e) => setColMap((m) => ({ ...m, typeCol: parseInt(e.target.value) }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                  {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              )}
              {(colMap.debitCol >= 0 || colMap.creditCol >= 0) && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[hsl(var(--muted-foreground))]">Debit column (money out)</label>
                    <select value={colMap.debitCol}
                      onChange={(e) => setColMap((m) => ({ ...m, debitCol: parseInt(e.target.value) }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                      {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[hsl(var(--muted-foreground))]">Credit column (money in)</label>
                    <select value={colMap.creditCol}
                      onChange={(e) => setColMap((m) => ({ ...m, creditCol: parseInt(e.target.value) }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                      {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </div>
                </div>
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
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    Look at the description text now shown above each amount in the preview - a row whose description mentions
                    "PAYMENT" or your bank/card issuer's name is money paid <em>toward</em> the card, not a purchase.
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
            <button onClick={proceedToPreview}
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
                {parsedStatementBalance && (
                  <p className="text-xs text-[hsl(var(--primary))]">Pre-filled from your statement - double-check it before continuing.</p>
                )}
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
            <button onClick={proceedToPreview}
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
          {error && <p className="text-[hsl(var(--error))] text-sm p-3 border border-[hsl(var(--error)/0.4)] rounded-lg">{error}</p>}

          {isPdfImport && (
            <p className="text-xs text-[hsl(var(--warning))] flex items-start gap-1.5 p-3 border border-[hsl(var(--warning)/0.35)] rounded-lg bg-[hsl(var(--warning)/0.06)]">
              <Info size={13} className="shrink-0 mt-0.5" />
              PDF portfolio statements are read with text-extraction heuristics, not a guaranteed column layout -
              double-check the sections and columns below (use "Fix columns" if anything looks misaligned) before importing.
              A CSV/XLSX export from your brokerage is more reliable when available.
            </p>
          )}

          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--primary)/0.1)" }}>
              <TrendingUp size={18} className="text-[hsl(var(--primary))]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">
                {invParsed.summary ? "Statement Review" : "Portfolio Positions"}
              </h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
                {invParsed.accountLabel ? `${invParsed.accountLabel} · ` : ""}Priced as of {formatDate(invParsed.asOfDate)}
              </p>
            </div>
          </div>

          {accountChoice && (
            <p className="text-xs text-[hsl(var(--success))] flex items-center gap-1">
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
                <p className="px-4 py-2 text-xs text-[hsl(var(--warning))] border-b flex items-start gap-1 normal-case font-normal">
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

          {invParsed.summary && (
            <div className="border rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-[hsl(var(--muted))] border-b text-xs font-medium uppercase tracking-wide">
                Statement Period Totals
                {invParsed.summary.periodStart && (
                  <span className="normal-case font-normal text-[hsl(var(--muted-foreground))]">
                    {" "}· {formatDate(invParsed.summary.periodStart)} – {formatDate(invParsed.summary.periodEnd)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[hsl(var(--border))]">
                {([
                  ["Beginning Value", invParsed.summary.beginningValue],
                  ["Ending Value", invParsed.summary.endingValue],
                  ["Change in Value", invParsed.summary.changeInValue],
                  ["Cash Balance", invParsed.summary.cashBalance],
                  ["Deposits", invParsed.summary.deposits],
                  ["Withdrawals", invParsed.summary.withdrawals],
                  ["Income", invParsed.summary.income],
                  ["Realized Gain", invParsed.summary.realizedGain],
                ] as [string, number | null][])
                  .filter(([, v]) => v !== null)
                  .map(([label, v]) => (
                    <div key={label} className="bg-[hsl(var(--background))] px-4 py-3">
                      <p className="text-sm font-semibold font-mono">{formatCurrency(Math.round((v as number) * 100))}</p>
                      <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">{label}</p>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {invParsed.activity.length > 0 && (
            <div className="border rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-[hsl(var(--muted))] border-b text-xs font-medium uppercase tracking-wide">
                Activity ({invParsed.activity.length})
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-[hsl(var(--muted-foreground))]">
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium text-right">Quantity</th>
                    <th className="px-4 py-2 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invParsed.activity.slice(0, 8).map((act, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-4 py-2 text-xs font-mono whitespace-nowrap">{formatDate(act.date)}</td>
                      <td className="px-4 py-2 text-xs">{ACTIVITY_TYPE_LABELS[act.activityType]}</td>
                      <td className="px-4 py-2 max-w-xs truncate text-xs">{act.description}</td>
                      <td className="px-4 py-2 text-right text-xs font-mono">{act.quantity ?? "-"}</td>
                      <td className={`px-4 py-2 text-right text-xs font-mono ${act.amount < 0 ? "text-[hsl(var(--error))]" : ""}`}>
                        {formatCurrency(Math.round(act.amount * 100))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {invParsed.activity.length > 8 && (
                <div className="px-4 py-2 text-xs text-[hsl(var(--muted-foreground))] border-t">+ {invParsed.activity.length - 8} more</div>
              )}
            </div>
          )}

          {duplicateSnapshot && (
            <div className="p-3 border border-[hsl(var(--warning)/0.4)] rounded-lg bg-[hsl(var(--warning)/0.06)] space-y-2">
              <p className="text-xs text-[hsl(var(--warning))] flex items-start gap-1.5">
                <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                This account already has <strong>{duplicateSnapshot.count}</strong> position{duplicateSnapshot.count === 1 ? "" : "s"} recorded
                for {formatDate(invParsed.asOfDate)}. Importing again would double-count them.
              </p>
              <button
                onClick={() => handleInvestmentImport(duplicateSnapshot.profileIdOverride, true)}
                className="px-4 py-1.5 border border-[hsl(var(--warning)/0.5)] rounded-lg text-xs font-medium hover:bg-[hsl(var(--warning)/0.12)] transition-colors">
                Replace that snapshot
              </button>
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={() => { setDuplicateSnapshot(null); wizardGo(backTargetFor(step), "back"); }}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => handleInvestmentImport()}
              className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg font-medium hover:opacity-90 transition-opacity">
              Import {invTotals.count} Position{invTotals.count === 1 ? "" : "s"}
              {invParsed.activity.length > 0 && ` + ${invParsed.activity.length} Activity`}
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">Cancel</button>
          </div>
        </div>
      )}

      {step === "wizard:reconcile" && parsed && (
        <div key="wizard:reconcile" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: "hsl(var(--warning)/0.12)" }}>
              <AlertTriangle size={18} className="text-[hsl(var(--warning))]" />
            </div>
            <div>
              <h2 className="text-lg font-bold leading-tight">Possible duplicates found</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
                {dupCandidates.length} transaction{dupCandidates.length === 1 ? "" : "s"} in this file look like they might
                already be on this account as a manual entry (same amount, a close date, and a similar description).
                Choose what to keep for each - "Keep both" is safest if they're actually different.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {dupCandidates.map((c, i) => (
              <div key={c.existingTxnId} className="border rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="border rounded-lg p-3">
                    <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">Your manual entry</p>
                    <p className="font-medium truncate">{c.existingDescription}</p>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">{formatDate(c.existingDate)} · {formatCurrency(c.existingAmountCents)}</p>
                  </div>
                  <div className="border rounded-lg p-3">
                    <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">Being imported</p>
                    <p className="font-medium truncate">{c.importedDescription}</p>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">{formatDate(c.importedDate)} · {formatCurrency(c.importedAmountCents)}</p>
                  </div>
                </div>
                <div className="flex gap-2 text-xs flex-wrap">
                  {([
                    { key: "keep_both" as const, label: "Keep both (not a duplicate)" },
                    { key: "keep_manual" as const, label: "Keep my manual entry" },
                    { key: "keep_imported" as const, label: "Keep the imported one" },
                  ]).map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setDupCandidates((prev) => prev.map((p, pi) => (pi === i ? { ...p, resolution: opt.key } : p)))}
                      className={`px-2.5 py-1.5 rounded-lg border transition-colors ${
                        c.resolution === opt.key
                          ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent"
                          : "hover:bg-[hsl(var(--muted))]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo("wizard:balance", "back")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Back
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
              Continue
            </button>
            <button onClick={reset} className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "wizard:preview" && parsed && (
        <div key="wizard:preview" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          {error && <p className="text-[hsl(var(--error))] text-sm p-3 border border-[hsl(var(--error)/0.4)] rounded-lg">{error}</p>}

          {isPdfImport && (
            <p className="text-xs text-[hsl(var(--warning))] flex items-start gap-1.5 p-3 border border-[hsl(var(--warning)/0.35)] rounded-lg bg-[hsl(var(--warning)/0.06)]">
              <Info size={13} className="shrink-0 mt-0.5" />
              PDF statements are read with text-extraction heuristics, not a guaranteed column layout -
              double-check the rows below before importing. A CSV/XLSX export from your bank is more reliable when available.
            </p>
          )}

          {importKind === "credit" && accountChoice && (
            <p className="text-xs text-[hsl(var(--success))] flex items-center gap-1">
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
                const a = computeRowAmount(r, colMap);
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
                  const amt = computeRowAmount(row, colMap);
                  const balRaw = colMap.balanceCol >= 0 ? (row[colMap.balanceCol] ?? "") : "";
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-4 py-2 whitespace-nowrap text-[hsl(var(--muted-foreground))] text-xs">
                        {formatDate(parseDate(row[colMap.dateCol] ?? ""))}
                      </td>
                      <td className="px-4 py-2 max-w-xs truncate text-xs">{row[colMap.descCol]}</td>
                      <td className={`px-4 py-2 text-right font-mono text-xs ${amt < 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--success))]"}`}>
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
            <button onClick={handleImport} disabled={importSubmitting}
              className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
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
                disabled={importSubmitting}
                className="px-5 py-2 bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]
                           border border-[hsl(var(--primary)/0.4)] rounded-lg text-sm font-medium
                           hover:bg-[hsl(var(--primary)/0.25)] transition-colors disabled:opacity-50"
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
              <div className="flex justify-center mb-4 text-[hsl(var(--primary))]"><Info size={48} /></div>
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
              <div className="flex justify-center mb-4 text-[hsl(var(--primary))]"><Info size={48} /></div>
              <p className="text-xl font-semibold mb-2">Already imported</p>
              <p className="text-[hsl(var(--muted-foreground))] mb-6">
                All {summary.skipped} rows from <strong>{currentFilename}</strong> already exist
                - this file has been imported before.
              </p>
            </>
          ) : (
            <>
              <div className="flex justify-center mb-4 wizard-enter-done"><CheckCircle2 size={48} className="text-[hsl(var(--success))]" /></div>
              <p className="text-xl font-semibold mb-2">Import complete!</p>
              <p className="text-[hsl(var(--muted-foreground))] mb-6">
                <span className="text-[hsl(var(--success))] font-semibold">{summary.imported} transactions</span>{" "}
                imported
                {summary.skipped > 0 && `, ${summary.skipped} duplicates skipped`}.
                {!profileFound && (
                  <span className="block text-xs mt-1">
                    Column layout saved - this bank's CSV will be recognized automatically next time.
                  </span>
                )}
              </p>
              {!!summary.transferCount && summary.transferCount > 0 && (
                <p className="text-xs text-[hsl(var(--muted-foreground))] mb-6 max-w-md mx-auto border rounded-lg px-3 py-2"
                  style={{ backgroundColor: "hsl(var(--primary)/0.05)" }}>
                  <strong className="text-[hsl(var(--foreground))]">{summary.transferCount}</strong> of those{" "}
                  {summary.transferCount === 1 ? "was" : "were"} recognized as a transfer/payment (e.g. a credit-card
                  payment) and categorized as Transfers or Excluded - so it won't be double-counted as both a checking
                  withdrawal and a card credit. Review it under Transactions if that doesn't look right.
                </p>
              )}
              {!!summary.errors && summary.errors.length > 0 && (
                <p className="text-xs text-[hsl(var(--error))] mb-6 max-w-md mx-auto border rounded-lg px-3 py-2 border-[hsl(var(--error)/0.3)]"
                  style={{ backgroundColor: "hsl(var(--error)/0.05)" }}>
                  <strong>{summary.errors.length}</strong> {summary.errors.length === 1 ? "row" : "rows"} could not be
                  imported due to an error (not a duplicate) - e.g. "{summary.errors[0].message}". These rows were not
                  saved and are not counted above.
                </p>
              )}
              {(!!summary.keptManualCount || !!summary.replacedManualCount) && (
                <p className="text-xs text-[hsl(var(--warning))] mb-6 max-w-md mx-auto border rounded-lg px-3 py-2 border-[hsl(var(--warning)/0.3)]"
                  style={{ backgroundColor: "hsl(var(--warning)/0.05)" }}>
                  {!!summary.keptManualCount && (
                    <>Kept <strong>{summary.keptManualCount}</strong> existing manual {summary.keptManualCount === 1 ? "entry" : "entries"} instead of the matching imported row{summary.keptManualCount === 1 ? "" : "s"}. </>
                  )}
                  {!!summary.replacedManualCount && (
                    <>Replaced <strong>{summary.replacedManualCount}</strong> manual {summary.replacedManualCount === 1 ? "entry" : "entries"} with the imported version.</>
                  )}
                </p>
              )}
            </>
          )}
          {!!summary.activityImported && (
            <p className="text-xs text-[hsl(var(--muted-foreground))] mb-6 max-w-md mx-auto">
              Also recorded <strong>{summary.activityImported}</strong> statement activity {summary.activityImported === 1 ? "line" : "lines"}
              {!!summary.skipped && <> ({summary.skipped} already imported)</>}.
            </p>
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
                          : s.kind === "loan"
                          ? <HandCoins size={12} className="shrink-0 text-[hsl(var(--primary))]" />
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
                            className="text-[hsl(var(--error))] font-medium hover:underline"
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
                          className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))]
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

      {showLoanUploader && (
        <LoanUploaderModal
          profileId={profileId}
          onClose={() => setShowLoanUploader(false)}
          onSaved={() => { setShowLoanUploader(false); loadHistory().catch(console.error); }}
        />
      )}
    </div>
  );
}
