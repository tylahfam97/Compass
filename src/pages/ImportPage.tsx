import { useState, useCallback, useEffect, useMemo } from "react";
import Papa from "papaparse";
import { useNavigate } from "react-router-dom";
import { getDb, getOrCreateAccountForProfile, applyCategorizationRules } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import type { CategorizationRule } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";

type Step = "upload" | "checking" | "mapping" | "importing" | "done";

interface ColMap {
  dateCol: number;
  descCol: number;
  amountCol: number;
}

interface ParsedData {
  headers: string[];
  rows: string[][];
}

interface Summary {
  imported: number;
  skipped: number;
}

const FIELDS = [
  {
    key: "dateCol" as const,
    label: "Date",
    hint: "Transaction date",
    example: "e.g. 06/15/2026 or 2026-06-15",
  },
  {
    key: "descCol" as const,
    label: "Description",
    hint: "Merchant or payee name",
    example: "e.g. WHOLE FOODS MARKET",
  },
  {
    key: "amountCol" as const,
    label: "Amount",
    hint: "Negative = expense, positive = income",
    example: "e.g. -87.43 or 3500.00",
  },
];

function computeHeaderSig(headers: string[]): string {
  return [...headers].map((h) => h.toLowerCase().trim()).sort().join("|");
}

function autoDetect(headers: string[]): ColMap {
  const h = headers.map((s) => s.toLowerCase());
  const find = (...terms: string[]) =>
    Math.max(0, h.findIndex((s) => terms.some((t) => s.includes(t))));
  return {
    dateCol: find("date"),
    descCol: find("description", "payee", "name", "merchant", "memo"),
    amountCol: find("amount", "debit", "credit"),
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

export default function ImportPage() {
  const navigate = useNavigate();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;
  const [step, setStep] = useState<Step>("upload");
  const [parsed, setParsed] = useState<ParsedData | null>(null);
  const [colMap, setColMap] = useState<ColMap>({ dateCol: 0, descCol: 1, amountCol: 2 });
  const [profileFound, setProfileFound] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetMonth, setTargetMonth] = useState(currentYM);

  // Auto-detect the dominant month whenever the parsed data or date column changes
  const detectedMonth = useMemo(
    () => (parsed ? detectDominantMonth(parsed.rows, colMap.dateCol) : null),
    [parsed, colMap.dateCol]
  );
  useEffect(() => {
    if (detectedMonth) setTargetMonth(detectedMonth);
  }, [detectedMonth]);

  const processFile = useCallback((file: File) => {
    setError(null);
    setStep("checking");
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (result) => {
        const data = result.data as string[][];
        if (data.length < 2) {
          setError("File appears empty or has too few rows.");
          setStep("upload");
          return;
        }
        const [first, ...rest] = data;
        const looksLikeHeader = first.some((cell) =>
          isNaN(parseFloat(cell.replace(/[$,]/g, "")))
        );
        const headers = looksLikeHeader ? first : first.map((_, i) => `Column ${i + 1}`);
        const rows = looksLikeHeader ? rest : data;
        setParsed({ headers, rows });

        // Check for a saved column profile for this bank's CSV layout
        (async () => {
          try {
            const sig = computeHeaderSig(headers);
            const db = await getDb();
            const profiles = await db.select<{
              date_col: number;
              desc_col: number;
              amount_col: number;
            }[]>(
              "SELECT date_col, desc_col, amount_col FROM column_profiles WHERE header_sig=? AND profile_id=?",
              [sig, profileId]
            );
            if (profiles.length > 0) {
              const p = profiles[0];
              setColMap({ dateCol: p.date_col, descCol: p.desc_col, amountCol: p.amount_col });
              setProfileFound(true);
            } else {
              setColMap(autoDetect(headers));
              setProfileFound(false);
            }
          } catch {
            setColMap(autoDetect(headers));
            setProfileFound(false);
          }
          setStep("mapping");
        })();
      },
      error: (err) => {
        setError(`Could not parse file: ${err.message}`);
        setStep("upload");
      },
    });
  }, [profileId]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f?.name.endsWith(".csv")) processFile(f);
      else setError("Please drop a .csv file.");
    },
    [processFile]
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) processFile(f);
  };

  const handleImport = async () => {
    if (!parsed) return;
    setStep("importing");
    try {
      const db = await getDb();
      const accountId = await getOrCreateAccountForProfile(profileId);
      const rules = await db.select<CategorizationRule[]>(
        "SELECT * FROM categorization_rules WHERE profile_id=? OR profile_id IS NULL ORDER BY priority DESC",
        [profileId]
      );

      let imported = 0;
      let skipped = 0;

      for (const row of parsed.rows) {
        const maxIdx = Math.max(colMap.dateCol, colMap.descCol, colMap.amountCol);
        if (row.length <= maxIdx) continue;
        const date = parseDate(row[colMap.dateCol] ?? "");
        const description = (row[colMap.descCol] ?? "").trim();
        const amount = parseAmount(row[colMap.amountCol] ?? "0");
        if (!date || !description || amount === 0) continue;

        const amountCents = Math.round(amount * 100);
        const hash = await hashRow(row);
        const categoryId = applyCategorizationRules(description, rules);

        try {
          await db.execute(
            `INSERT INTO transactions
               (account_id, date, amount_cents, description, category_id, import_hash, profile_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [accountId, date, amountCents, description, categoryId, hash, profileId]
          );
          imported++;
        } catch {
          skipped++;
        }
      }

      // Save / update the column profile for next time
      const sig = computeHeaderSig(parsed.headers);
      await db.execute(
        `INSERT INTO column_profiles (header_sig, date_col, desc_col, amount_col, profile_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(header_sig) DO UPDATE SET
           date_col = excluded.date_col,
           desc_col = excluded.desc_col,
           amount_col = excluded.amount_col`,
        [sig, colMap.dateCol, colMap.descCol, colMap.amountCol, profileId]
      );

      setSummary({ imported, skipped });
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("mapping");
    }
  };

  const reset = () => {
    setStep("upload");
    setParsed(null);
    setSummary(null);
    setError(null);
    setProfileFound(false);
    setTargetMonth(currentYM());
  };

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-2">Import Statements</h1>
      <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
        Your data never leaves this device.
      </p>

      {/* ── UPLOAD / CHECKING ── */}
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
            <div className="text-5xl mb-4">{step === "checking" ? "⏳" : "📄"}</div>
            <p className="font-medium mb-1">
              {step === "checking"
                ? "Reading file…"
                : "Drop your CSV here or click to browse"}
            </p>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Works with exports from any bank or credit card
            </p>
          </div>
          <input
            id="csv-input"
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleFileInput}
          />
          {error && <p className="mt-4 text-red-500 text-sm">{error}</p>}
        </div>
      )}

      {/* ── COLUMN MAPPING ── */}
      {step === "mapping" && parsed && (
        <div>
          {/* Profile status */}
          {profileFound ? (
            <div className="flex items-center gap-2 mb-5 px-4 py-2.5 rounded-lg text-sm
                            border border-green-300 bg-green-50 text-green-800
                            dark:border-green-800 dark:bg-green-950 dark:text-green-300">
              ✓ Column layout recognized from a previous import — verify below and adjust if needed.
            </div>
          ) : (
            <div className="flex items-center gap-2 mb-5 px-4 py-2.5 rounded-lg text-sm
                            border border-[hsl(var(--border))] bg-[hsl(var(--muted))]">
              New column layout — match each CSV column to the correct field:
            </div>
          )}

          <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
            {parsed.rows.length} rows · {parsed.headers.length} columns detected
          </p>

          {/* Column matching cards */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            {FIELDS.map(({ key, label, hint, example }) => (
              <div key={key} className="border rounded-xl p-4 flex flex-col gap-2">
                <div>
                  <p className="font-medium text-sm">{label}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">{hint}</p>
                </div>
                <select
                  value={colMap[key]}
                  onChange={(e) =>
                    setColMap((m) => ({ ...m, [key]: parseInt(e.target.value) }))
                  }
                  className="w-full border rounded-lg px-3 py-2 text-sm
                             bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                >
                  {parsed.headers.map((h, idx) => (
                    <option key={idx} value={idx}>{h || `Column ${idx + 1}`}</option>
                  ))}
                </select>
                {/* Sample values from the selected column */}
                <div className="border-l-2 border-[hsl(var(--border))] pl-2 space-y-0.5">
                  <p className="text-xs text-[hsl(var(--muted-foreground))] italic">{example}</p>
                  {parsed.rows.slice(0, 3).map((row, i) => (
                    <p key={i} className="text-xs font-mono truncate text-[hsl(var(--foreground))]">
                      {row[colMap[key]] || "—"}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Preview table */}
          <div className="border rounded-xl overflow-hidden mb-5">
            <div className="px-4 py-2 bg-[hsl(var(--muted))] border-b text-xs font-medium
                            text-[hsl(var(--muted-foreground))] uppercase tracking-wide">
              Preview — first 5 rows
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 5).map((row, i) => {
                  const amt = parseAmount(row[colMap.amountCol] ?? "0");
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-4 py-2 whitespace-nowrap text-[hsl(var(--muted-foreground))]">
                        {parseDate(row[colMap.dateCol] ?? "")}
                      </td>
                      <td className="px-4 py-2 max-w-xs truncate">{row[colMap.descCol]}</td>
                      <td
                        className={`px-4 py-2 text-right font-mono
                          ${amt < 0 ? "text-red-500" : "text-green-600"}`}
                      >
                        {formatCurrency(Math.round(amt * 100))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {error && <p className="mb-4 text-red-500 text-sm">{error}</p>}

          {/* Statement month */}
          <div className="flex items-center gap-3 mb-5 p-3 border rounded-xl bg-[hsl(var(--muted))]/40">
            <span className="text-sm font-medium shrink-0">Statement month</span>
            <input
              type="month"
              value={targetMonth}
              onChange={(e) => setTargetMonth(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                         text-[hsl(var(--foreground))]"
            />
            {detectedMonth && detectedMonth !== targetMonth && (
              <button
                onClick={() => setTargetMonth(detectedMonth)}
                className="text-xs text-[hsl(var(--primary))] hover:underline"
              >
                Reset to detected ({detectedMonth})
              </button>
            )}
            {detectedMonth === targetMonth && (
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                Auto-detected from dates
              </span>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleImport}
              className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                         rounded-lg font-medium hover:opacity-90 transition-opacity"
            >
              Import {parsed.rows.length} Transactions
            </button>
            <button
              onClick={reset}
              className="px-6 py-2 border rounded-lg font-medium hover:bg-[hsl(var(--muted))]
                         transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── IMPORTING ── */}
      {step === "importing" && (
        <div className="text-center py-16">
          <div className="text-5xl mb-4 animate-pulse">⚙️</div>
          <p className="font-medium">Importing and categorizing transactions…</p>
        </div>
      )}

      {/* ── DONE ── */}
      {step === "done" && summary && (
        <div className="text-center py-16">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-xl font-semibold mb-2">Import complete!</p>
          <p className="text-[hsl(var(--muted-foreground))] mb-6">
            <span className="text-green-600 font-semibold">{summary.imported} transactions</span>{" "}
            imported
            {summary.skipped > 0 && `, ${summary.skipped} duplicates skipped`}.
            {!profileFound && (
              <span className="block text-xs mt-1">
                Column layout saved — this bank's CSV will be recognized automatically next time.
              </span>
            )}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => navigate("/transactions", { state: { month: targetMonth } })}
              className="px-6 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                         rounded-lg font-medium"
            >
              View Transactions
            </button>
            <button
              onClick={reset}
              className="px-6 py-2 border rounded-lg font-medium hover:bg-[hsl(var(--muted))]
                         transition-colors"
            >
              Import Another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
