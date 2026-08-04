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
