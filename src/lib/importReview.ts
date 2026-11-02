// ─── Optional category review before an import is written (#103) ─────────────────────────────
// Pure helpers for the Preview step. Choices live only in page state until the user confirms the
// import; Back/Cancel discards them and nothing is written. Every row is always imported - a
// review can only change which category a row lands in, never drop, merge or re-amount it.
import { merchantKey } from "./merchants";

export interface ReviewRow {
  /** Index into the parsed file's rows - the same index the import loop uses. */
  rowIndex: number;
  date: string;
  description: string;
  amountCents: number;
  /** What the saved rules would assign today, exactly as the import would without a review. */
  suggestedCategoryId: number;
}

export interface ReviewGroup {
  key: string;
  /** The first row's own description - merchant keys are for grouping only, never shown. */
  label: string;
  rows: ReviewRow[];
}

/** Rows grouped by merchant, biggest groups first, so one choice can cover a repeat payee. */
export function groupRowsForReview(rows: ReviewRow[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const row of rows) {
    const key = merchantKey(row.description) || row.description.trim().toUpperCase();
    const group = groups.get(key) ?? { key, label: row.description, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
}

/** The category a row will be imported with: the user's staged choice, else the rule's. */
export function reviewedCategory(row: ReviewRow, overrides: ReadonlyMap<number, number>): number {
  return overrides.get(row.rowIndex) ?? row.suggestedCategoryId;
}

/** A group's shared category, or null when its rows currently differ (an exception exists). */
export function groupCategory(group: ReviewGroup, overrides: ReadonlyMap<number, number>): number | null {
  const first = reviewedCategory(group.rows[0], overrides);
  return group.rows.every((r) => reviewedCategory(r, overrides) === first) ? first : null;
}
