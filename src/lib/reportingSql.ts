// ─── Shared reporting SQL ──────────────────────────────────────────────────────
// One definition per user-facing number. These fragments were previously hand-copied into
// 40+ query sites across the pages and agent, and had drifted: the Trends expense bar dropped
// credit-card spending, Overview's expenses counted transfers, and a budget-streak goal
// disagreed with the Budgets page about whether the same category was over budget.
//
// Accounting rules these encode:
//  - INCOME excludes `account_type IN ('credit','loan')` - a positive amount there is a
//    payment reducing debt, not money earned.
//  - EXPENSES count on ANY account type - a credit-card purchase is real spending. The card
//    payment out of checking is a Transfer (category 20) and excluded, so nothing is counted
//    twice; loan statement snapshots are written as category 20 for the same reason.
//  - Categories 20 (Transfers) and 29 (Excluded) never count as either.
//  - Per-CATEGORY spend nets refunds filed under that category, floored at $0 per period.
//
// Every fragment assumes `FROM transactions <t> JOIN accounts <a> ON <a>.id=<t>.account_id`.
// Alias parameters exist only because call sites use different letters (`t`/`a` vs `tx`/`ac`);
// they are always compile-time literals, never user input.

/** Categories that are deliberately left out of every income and expense total. */
const EXCLUDED_CATEGORY_IDS = "20,29";

function notExcludedCategory(t: string): string {
  return `(${t}.category_id IS NULL OR ${t}.category_id NOT IN (${EXCLUDED_CATEGORY_IDS}))`;
}

/** Money earned. Positive amounts on a spending account only. */
export function incomeSumSql(t = "t", a = "a"): string {
  return `SUM(CASE WHEN ${t}.amount_cents>0 AND ${notExcludedCategory(t)}
                    AND ${a}.account_type NOT IN ('credit','loan') THEN ${t}.amount_cents ELSE 0 END)`;
}

/** Money spent, on any account type. Returned as a positive number. */
export function expenseSumSql(t = "t"): string {
  return `SUM(CASE WHEN ${t}.amount_cents<0 AND ${notExcludedCategory(t)}
                   THEN ABS(${t}.amount_cents) ELSE 0 END)`;
}

/**
 * Spend within one category, netting any refunds/credits filed under it and floored at $0 so a
 * net-credit category reads as no spend rather than negative. A positive amount on a credit or
 * loan account is debt reduction, so it must not net down a category's spend even if it was
 * miscategorised. Group by month before averaging - the floor has to apply per period.
 *
 * Safe under a LEFT JOIN to `accounts`: a NULL `account_type` makes the first branch NULL
 * rather than true, so the row falls through to the netting branch.
 */
export function categorySpendSql(t = "t", a = "a"): string {
  return `MAX(0, SUM(CASE WHEN ${t}.amount_cents>0 AND ${a}.account_type IN ('credit','loan')
                          THEN 0 ELSE -${t}.amount_cents END))`;
}

export function categoryNetSql(t = "t", a = "a"): string {
  return `COALESCE(SUM(CASE WHEN NOT ${notExcludedCategory(t)} THEN 0
    WHEN ${t}.amount_cents>0 AND ${a}.account_type IN ('credit','loan') THEN 0
    ELSE -${t}.amount_cents END),0)`;
}

/**
 * An account's own most recent recorded balance, as a correlated subquery against the outer
 * account row. Summing this per account is the only correct way to total balances across
 * several accounts - a single `ORDER BY date DESC LIMIT 1` over the whole profile returns
 * whichever account was updated last and silently ignores the others.
 * Pass `asOfDate` to add one trailing `?` parameter bounding the balance to a point in time.
 */
export function latestBalancePerAccountSql(a = "a", asOfDate = false): string {
  return `(SELECT bt.balance_cents FROM transactions bt
           WHERE bt.account_id=${a}.id AND bt.balance_cents IS NOT NULL${asOfDate ? " AND bt.date<=?" : ""}
           ORDER BY bt.date DESC, bt.id DESC LIMIT 1)`;
}
