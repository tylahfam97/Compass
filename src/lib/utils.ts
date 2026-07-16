import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format cents to a locale currency string, e.g. -1234 → "-$12.34" */
export function formatCurrency(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/** Lightens a hex color toward white by `amount` (0-1), for chart hover states
 *  (e.g. a bar's own color, washed out, instead of a generic gray highlight). */
export function lightenHex(hex: string, amount = 0.45): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  if (isNaN(num) || full.length !== 6) return hex;
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Format an ISO date string to a readable label, e.g. "2024-03-15" → "Mar 15, 2024" */
export function formatDate(iso: string): string {
  // ISO date-only strings (YYYY-MM-DD) are parsed as UTC midnight by the JS engine.
  // Formatting in a negative-offset timezone (any US zone) then shifts to the previous day.
  // Appending a local noon time prevents the rollback.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

/**
 * Merges per-account running-balance rows (e.g. checking + credit, ordered by date ASC, id ASC)
 * into a single combined daily series, forward-filling each account's last known balance so
 * a day with activity on only one account still reflects the other account's current balance.
 * Credit accounts are expected to already store balance_cents negative (a liability).
 */
export function combineAccountBalances(
  rows: { date: string; account_id: number; balance_cents: number }[]
): { date: string; balance_cents: number }[] {
  const lastByAccount = new Map<number, number>();
  const byDate = new Map<string, number>();
  for (const r of rows) {
    lastByAccount.set(r.account_id, r.balance_cents);
    let total = 0;
    for (const v of lastByAccount.values()) total += v;
    byDate.set(r.date, total);
  }
  return [...byDate.entries()].map(([date, balance_cents]) => ({ date, balance_cents }));
}

