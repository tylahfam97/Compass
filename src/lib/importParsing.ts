// ─── Statement value parsing ───────────────────────────────────────────────────
// Extracted from ImportPage.tsx so parseDate/parseAmount are independently testable.

/** True if y-m-d is a real calendar date (rejects e.g. Feb 31, which `new Date(y, m-1, d)`
 *  would otherwise silently roll forward into March). */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Parses a bank statement date cell into YYYY-MM-DD. Returns "" for a string that matches a
 *  known date shape but isn't a real calendar date (e.g. "02/31/2024"), so callers can skip the
 *  row the same way they already skip other invalid data. Unrecognized formats fall back to
 *  JS's native Date parser, unchanged from before. */
export function parseDate(s: string): string {
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const month = parseInt(slash[1], 10);
    const day = parseInt(slash[2], 10);
    const year = parseInt(slash[3], 10);
    if (!isRealCalendarDate(year, month, day)) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10);
    const day = parseInt(iso[3], 10);
    return isRealCalendarDate(year, month, day) ? s : "";
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().split("T")[0];
}

/** Parses a bank statement amount cell into a signed dollar amount. Recognizes parentheses and
 *  a leading minus (existing behavior), plus a trailing "CR"/"DR" suffix (CR = credit/positive,
 *  DR = debit/negative) as an additional, backward-compatible detection rule. */
export function parseAmount(s: string): number {
  const suffixMatch = s.trim().match(/(cr|dr)$/i);
  const suffix = suffixMatch?.[1]?.toLowerCase();
  const withoutSuffix = suffix ? s.replace(/\s*(cr|dr)\s*$/i, "") : s;
  const neg = withoutSuffix.includes("(") || withoutSuffix.trimStart().startsWith("-") || suffix === "dr";
  const n = parseFloat(withoutSuffix.replace(/[$,\s()]/g, ""));
  return isNaN(n) ? 0 : neg ? -Math.abs(n) : Math.abs(n);
}

/** SHA-256 hex hash of a raw CSV row, used for import dedup. */
export async function hashRow(row: string[]): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row.join("||")));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Dedupe hash for one row of the CURRENT import file. `seenCounts` tracks how many times each
 *  raw-row hash has already occurred earlier in this same file. The first occurrence's hash is
 *  UNCHANGED from `hashRow` (so re-importing an already-imported file still matches existing DB
 *  rows for dedup) - only the 2nd+ occurrence of a byte-identical row within the same file gets
 *  a disambiguating suffix, so two legitimately identical transactions (e.g. two $5 purchases at
 *  the same merchant on the same day) no longer collide into a false "duplicate". */
export async function dedupeRowHash(row: string[], seenCounts: Map<string, number>): Promise<string> {
  const base = await hashRow(row);
  const count = seenCounts.get(base) ?? 0;
  seenCounts.set(base, count + 1);
  return count === 0 ? base : await hashRow([...row, `__dupe_ordinal_${count}`]);
}

// ─── Manual-vs-import duplicate detection ──────────────────────────────────────
// A manually-added transaction's import_hash is a random UUID (see EditTransactionModal), never
// derived from its content - so it can NEVER match a later real import's content-based hash.
// Without this, entering a transaction by hand and later seeing the same one on an imported
// statement silently double-counts it. This is a separate, deliberately loose/"maybe" heuristic
// (never auto-applied) that the import wizard uses to flag candidates for the user to resolve.

function normalizeForDuplicateMatch(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** True if two descriptions are close enough to flag as a possible duplicate - exact match, one
 *  containing the other, or sharing at least one meaningful (3+ char) word. Deliberately loose
 *  since a manually-typed description rarely matches a bank's own wording character-for-character. */
export function descriptionsLikelyMatch(a: string, b: string): boolean {
  const na = normalizeForDuplicateMatch(a);
  const nb = normalizeForDuplicateMatch(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wordsA = new Set(na.split(" ").filter((w) => w.length >= 3));
  return nb.split(" ").some((w) => w.length >= 3 && wordsA.has(w));
}

export interface ManualTxnForMatch {
  id: number;
  date: string;
  description: string;
  amount_cents: number;
}

export interface ImportedRowForMatch {
  rowIndex: number;
  date: string;
  description: string;
  amountCents: number;
}

export interface DuplicateCandidate {
  rowIndex: number;
  existingTxnId: number;
  existingDate: string;
  existingDescription: string;
  existingAmountCents: number;
  importedDate: string;
  importedDescription: string;
  importedAmountCents: number;
}

/** A same-date transaction posted a day or two later is common (weekend/holiday clearing) -
 *  wide enough to catch that, narrow enough to stay "super confident" rather than guessing. */
const DUPLICATE_DATE_WINDOW_DAYS = 3;

/** Flags statement rows about to be imported that look like they might already exist as a
 *  manually-added transaction on the same account: exact amount match (no tolerance), date
 *  within a few days, and a similar-enough description. Each manual transaction can only match
 *  ONE imported row, so several same-amount rows on one statement can't all falsely claim the
 *  same manual entry. Returns an empty array (no UI shown) when nothing looks like a match. */
export function findDuplicateCandidates(
  importedRows: ImportedRowForMatch[],
  manualTxns: ManualTxnForMatch[]
): DuplicateCandidate[] {
  const usedManualIds = new Set<number>();
  const candidates: DuplicateCandidate[] = [];
  for (const row of importedRows) {
    const match = manualTxns.find((m) => {
      if (usedManualIds.has(m.id)) return false;
      if (m.amount_cents !== row.amountCents) return false;
      const days = Math.abs((new Date(m.date).getTime() - new Date(row.date).getTime()) / 86400000);
      if (days > DUPLICATE_DATE_WINDOW_DAYS) return false;
      return descriptionsLikelyMatch(m.description, row.description);
    });
    if (match) {
      usedManualIds.add(match.id);
      candidates.push({
        rowIndex: row.rowIndex, existingTxnId: match.id, existingDate: match.date,
        existingDescription: match.description, existingAmountCents: match.amount_cents,
        importedDate: row.date, importedDescription: row.description, importedAmountCents: row.amountCents,
      });
    }
  }
  return candidates;
}
