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
 *  row the same way they already skip other invalid data. Handles the formats real bank exports
 *  use: MM/DD/YYYY and MM-DD-YYYY (2- or 4-digit years), ISO, compact YYYYMMDD, month names
 *  ("Jan 5, 2026", "05-Jan-2026"), and any of these with a trailing time ("09/05/2026 14:32").
 *  Unambiguous DD/MM/YYYY (day > 12) is recognized too. Unrecognized formats fall back to JS's
 *  native Date parser. */
export function parseDate(s: string): string {
  // Strip a trailing time-of-day ("14:32", "14:32:15", "2:32 PM") - several banks export
  // datetimes; the extra token otherwise pushes the whole cell to the native-Date fallback.
  const cleaned = s.trim().replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, "").trim();

  const slash = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (slash) {
    let month = parseInt(slash[1], 10);
    let day = parseInt(slash[2], 10);
    let year = parseInt(slash[3], 10);
    if (slash[3].length === 2) year += year < 70 ? 2000 : 1900;
    // "25/12/2026" can only be DD/MM - swap. Ambiguous cells (both parts <= 12) stay MM/DD.
    if (month > 12 && day <= 12) [month, day] = [day, month];
    if (!isRealCalendarDate(year, month, day)) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const iso = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = parseInt(iso[2], 10);
    const day = parseInt(iso[3], 10);
    return isRealCalendarDate(year, month, day) ? cleaned : "";
  }
  const compact = cleaned.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const year = parseInt(compact[1], 10);
    const month = parseInt(compact[2], 10);
    const day = parseInt(compact[3], 10);
    return isRealCalendarDate(year, month, day) ? `${compact[1]}-${compact[2]}-${compact[3]}` : "";
  }
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return s;
  // Local date parts, NOT toISOString() - native parsing lands on local midnight, which
  // toISOString would roll back a day for anyone east of UTC.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parses a bank statement amount cell into a signed dollar amount. Recognizes parentheses,
 *  leading AND trailing minus signs, trailing "CR"/"DR" suffixes (CR = credit/positive,
 *  DR = debit/negative), currency symbols/codes ($, €, £, ¥, "USD 12.34"), and European
 *  decimal commas ("1.234,56"). Returns 0 for anything unparseable. */
export function parseAmount(s: string): number {
  const suffixMatch = s.trim().match(/(cr|dr)$/i);
  const suffix = suffixMatch?.[1]?.toLowerCase();
  const withoutSuffix = suffix ? s.replace(/\s*(cr|dr)\s*$/i, "") : s;
  const neg =
    withoutSuffix.includes("(") ||
    withoutSuffix.trimStart().startsWith("-") ||
    /-\s*$/.test(withoutSuffix) ||
    suffix === "dr";
  // Strip currency symbols, 3-letter currency codes ("USD 12.34" / "12.34 EUR"), parens,
  // spaces and sign characters, leaving only digits and separators.
  let t = withoutSuffix
    .replace(/^\s*[A-Za-z]{3}\b/, "")
    .replace(/\b[A-Za-z]{3}\s*$/, "")
    .replace(/[$€£¥\s()+-]/g, "");
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) {
    // European format with dot thousands + comma decimals: 1.234,56
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+,\d{1,2}$/.test(t)) {
    // Bare decimal comma: 1234,56 (a US thousands comma always groups 3 digits)
    t = t.replace(",", ".");
  } else {
    t = t.replace(/,/g, "");
  }
  const n = parseFloat(t);
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
