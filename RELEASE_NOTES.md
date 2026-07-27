# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.9.3 — Category Totals Now Net Out Refunds & Reimbursements 💰

A correctness release for anyone who gets money back into a spending category - a reimbursement,
refund, or shared-cost repayment deposited back into your account and categorized alongside the
original expense.

### Fixed: Spending Categories Ignored Credits Filed Under Them
Category totals across Insights, Reports, Trends, Budgets, Goals, and the Dashboard only ever
summed the debits in a category, completely ignoring any credits (refunds, reimbursements, a
roommate paying you back) filed under that same category. For example, $2,740 spent on Rent with
a $1,700 reimbursement credited back would previously show as $2,740 spent instead of the correct
net $1,040. Every category total now nets debits against credits (excluding credit card/loan
payment credits, which are debt reduction, not refunds, and continue to be tracked separately).
This affects budget progress, category breakdowns, spending insights (unusual spikes, budget
suggestions, category creep, most-improved), and reduce-spend goals.

### New: Clickable Cards Now Signal Themselves
Cards that open more detail on click - Credit Card/Investment Health, debt payoff accounts, and
Dashboard's Bank/Credit Card/Loan tiles - now glow softly and shimmer to signal they're
interactive, and show a "Click for more details" hint after a second of hovering.

### New: A Settings Page
A dedicated home for backup/restore and recurring transactions, linked from the sidebar.
Currency stays USD-only for now.

### New: One-Click Encrypted Backup & Restore
Export Backup bundles your entire database and its encryption key into a single
`.compassbackup` file - no more manually copying `compass.db` and `compass.key` separately.
Restoring is validated before anything touches your live data (a bad or mismatched-key backup
is rejected up front) and takes effect on the next relaunch, which Compass triggers
automatically.

### New: User-Defined Recurring Transactions
Schedule a bill or paycheck ahead of time - monthly, weekly, or every two weeks - from the new
Settings page, instead of only finding out it's recurring after it's already happened a few
times. Reminder-only: nothing is ever posted automatically, you stay in control of every real
transaction.

### New: Bulk Transaction Operations
Select multiple transactions on the Transactions page (checkbox column, "select all" in the
header) to recategorize or delete them all at once, instead of one at a time.

### New: Automated Test Suite
The core balance/category-netting math (`utils.ts`, `voice.ts`, the new `recurring.ts`) now has
unit test coverage via Vitest (`npm test`), so future changes to this arithmetic have a
regression safety net.

### Docs: README Accuracy Pass
Fixed a couple of stale claims - loan and investment statements already accept PDF (the
"Known Limitations" table said otherwise), and the Goals table was missing three real goal
types (Balance Floor, Debt Paydown, Savings Target). The Roadmap section now reflects the
actual path to v1.0.

