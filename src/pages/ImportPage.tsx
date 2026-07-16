import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Calendar, Tag, DollarSign, BarChart2, Upload, Loader2, CheckCircle2, Info } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getDb, getOrCreateAccountForProfile, applyCategorizationRules } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { CategorizationRule } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import { takePendingImportFiles } from "@/lib/pendingImport";

type Step =
  | "upload" | "checking"
  | "wizard:data" | "wizard:date" | "wizard:desc" | "wizard:amount" | "wizard:balance" | "wizard:preview"
  | "importing" | "done";

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
}

const WIZARD_STEPS = [
  { step: "wizard:data"    as const, num: 1, label: "Find Data" },
  { step: "wizard:date"    as const, num: 2, label: "Date" },
  { step: "wizard:desc"    as const, num: 3, label: "Description" },
  { step: "wizard:amount"  as const, num: 4, label: "Amount" },
  { step: "wizard:balance" as const, num: 5, label: "Balance" },
  { step: "wizard:preview" as const, num: 6, label: "Preview" },
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

export default function ImportPage() {
  const navigate = useNavigate();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;
  const [step, setStep] = useState<Step>("upload");
  const [rawData, setRawData] = useState<string[][] | null>(null);
  const [skipRows, setSkipRows] = useState(0);
  const [parsed, setParsed] = useState<ParsedData | null>(null);
  const [currentFilename, setCurrentFilename] = useState("");
  const [colMap, setColMap] = useState<ColMap>({ dateCol: 0, descCol: 1, amountCol: 2, typeCol: -1, balanceCol: -1, invertAmounts: false });
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

  const loadHistory = useCallback(async () => {
    const db = await getDb();
    const rows = await db.select<ImportSession[]>(
      `SELECT id, filename, imported_at, row_count, skipped_count
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
  };

  const undoImport = async (sessionId: number) => {
    const db = await getDb();
    await db.execute("DELETE FROM transactions WHERE import_session_id=?", [sessionId]);
    await db.execute("DELETE FROM import_sessions WHERE id=?", [sessionId]);
    setConfirmDeleteId(null);
    await loadHistory();
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
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];
          if (data.length < 2) {
            setError("Spreadsheet appears empty or has too few rows.");
            setStep("upload");
            return;
          }
          finishParsingData(data);
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
        finishParsingData(data);
      },
      error: (err) => {
        setError(err.message);
        setStep("upload");
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  /** Shared logic to detect headers, load presets, and advance to the wizard after parsing. */
  const finishParsingData = useCallback((data: string[][]) => {
    const initialSkip = findRealHeaderRow(data);
    setRawData(data);
    setSkipRows(initialSkip);
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
        const profiles = await db.select<{
          date_col: number; desc_col: number; amount_col: number;
          type_col: number; balance_col: number;
        }[]>(
          "SELECT date_col, desc_col, amount_col, COALESCE(type_col, -1) as type_col, COALESCE(balance_col, -1) as balance_col FROM column_profiles WHERE header_sig=? AND profile_id=?",
          [sig, profileId]
        );
        if (profiles.length > 0) {
          const p = profiles[0];
          setColMap({ dateCol: p.date_col, descCol: p.desc_col, amountCol: p.amount_col, typeCol: p.type_col, balanceCol: p.balance_col, invertAmounts: false });
          setProfileFound(true);
        } else {
          const base = autoDetect(headers);
          if (selectedPresetId && BANK_PRESETS[selectedPresetId]) {
            setColMap({ ...base, ...applyPreset(BANK_PRESETS[selectedPresetId], headers) });
          } else {
            setColMap(base);
          }
          setProfileFound(false);
        }
      } catch {
        setColMap(autoDetect(headers));
        setProfileFound(false);
      }
      setStep("wizard:data");
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
      if (selectedPresetId && BANK_PRESETS[selectedPresetId]) {
        const overrides = applyPreset(BANK_PRESETS[selectedPresetId], derived.headers);
        setColMap({ ...base, ...overrides });
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
      const accountId = await getOrCreateAccountForProfile(profileId);
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
        const balanceCents = colMap.balanceCol >= 0 && row[colMap.balanceCol]
          ? Math.round(parseAmount(row[colMap.balanceCol]) * 100)
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
      const accountId = await getOrCreateAccountForProfile(profileId);
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
          ? Math.round(parseAmount(row[savedColMap.balanceCol]) * 100) : null;
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
      await loadHistory();
      setSummary({ imported, skipped });
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSummary({ imported: 0, skipped: 0 });
      setStep("done");
    }
  }, [profileId, loadHistory]);

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

      {(step === "upload" || step === "checking") && (
        <div>
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
                : "Drop your CSV here or click to browse"}
            </p>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Works with exports from any bank or credit card
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
          {step === "upload" && (
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
            {WIZARD_STEPS.map((ws, i) => (
              <div key={ws.step} className="flex items-center gap-1">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  wizardNum(step) === ws.num
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : wizardNum(step) > ws.num
                    ? "bg-green-500 text-white"
                    : "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"
                }`}>
                  {wizardNum(step) > ws.num ? "✓" : ws.num}
                </div>
                {i < WIZARD_STEPS.length - 1 && (
                  <div className={`h-0.5 w-6 transition-colors ${wizardNum(step) > ws.num ? "bg-green-500" : "bg-[hsl(var(--muted))]"}`} />
                )}
              </div>
            ))}
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

      {step === "wizard:data" && parsed && (
        <div key="wizard:data" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
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
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm font-medium hover:bg-[hsl(var(--muted))] transition-colors">
            </button>
            <button onClick={() => wizardGo("wizard:date", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
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
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo("wizard:desc", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
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
            <button onClick={() => wizardGo("wizard:amount", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
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
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo("wizard:balance", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
            </button>
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors ml-auto">
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
          </div>

          <div className="flex gap-3">
            <button onClick={() => wizardGo("wizard:preview", "forward")}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
            </button>
          </div>
        </div>
      )}

      {step === "wizard:preview" && parsed && (
        <div key="wizard:preview" className={`space-y-5 ${wizardDir === "back" ? "wizard-enter-back" : "wizard-enter-forward"}`}>
          {error && <p className="text-red-500 text-sm p-3 border border-red-300 rounded-lg">{error}</p>}

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
                onClick={() => navigate("/transactions", { state: isMultiMonth ? {} : { month: targetMonth } })}
                className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                           rounded-lg font-medium"
              >
                View Transactions
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
                      {s.filename}
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
    </div>
  );
}
