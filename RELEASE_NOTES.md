# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.9.7 — Import Duplicate Protection 🔍

A focused release closing a real gap: a transaction entered by hand and later seen on an
imported statement had no way to be recognized as the same one.

### New: The Import Wizard Now Catches Possible Duplicates of Manual Entries
Manually-added transactions never had a way to match against a real import - so entering one by
hand and later importing a statement that includes it could quietly double-count it. The import
wizard now checks incoming statement rows against your existing manual entries (same amount, a
close date, and a similar description) and, only when it finds a likely match, shows a
side-by-side comparison before anything is saved: keep both, keep your manual entry, or keep the
imported one. Nothing is ever deleted automatically - "keep both" is the default for anything you
don't explicitly resolve. This step stays out of the way entirely when nothing looks like a
duplicate, which is the common case.

## Compass 0.9.6 — Premier UI Refresh ✨

A visual polish pass ahead of v1.0 - a calmer, more professional look plus a handful of real
month-picker bugs found along the way.

### Fixed: Manually Adding/Editing/Deleting a Transaction Could Corrupt Your Account Balance
If you manually added, edited, or deleted a transaction dated on or before the day you last
entered your account's real balance, the running balance could silently fail to update - e.g.
adding a $300 transfer out of an account showing $315 could still show $315 afterward instead of
$15, throwing off every balance calculated from that point on. This is now fixed: your entered
balance correctly shifts by the change instead of absorbing it. The same stale-balance problem
could also happen when importing another batch of transactions right after - the Import
wizard's "Current balance" field now correctly suggests your balance including the new
transactions instead of the old, pre-import figure, so accepting the suggested value is safe
again. A third, deeper case affected accounts that were originally imported with their own
running-balance column and never had a manually-entered balance at all: adding a second manual
transaction right after a first one could bump every earlier transaction's balance up by the
new amount instead of applying it correctly. All three now share the same fix, so your real
balance stays correct through any combination of manual entries and imports. If an account was
already thrown off by this before updating, re-confirm its real balance once (via a small
re-import through the Import wizard's "Current balance" field) to reset it - this fix prevents
it happening again, but can't retroactively repair a balance that was already thrown off.

### New: A Calmer, More Professional Look
The tiled background texture is gone, replaced by a barely-there gradient. Gold is now reserved
specifically for things you can click or interact with (chart cards, profile switching, the
onboarding checklist), while blue carries everything else - navigation, buttons, and structural
chrome - for a more consistent, less "busy" feel throughout the app.

### Improved: Dimmed and Contained the Glow on Clickable Cards
The gold glow that signals a chart card can be clicked for detail was brighter than intended and
bled out past the card's own edges. It's now dimmer and clipped to the card itself.

### Fixed: Some Month Pickers Were Missing Their Forward/Back Buttons
The Transactions page's month picker had no way to step forward or backward a month - only
Dashboard, Overview, Budgets, Goals, and Reports had them. All month pickers are now consistent.

### Fixed: The Month Picker Could Silently Jump to a Different Month Than Expected
If the real current month had no transactions yet, every month picker used to quietly jump to
whichever past month last had data - easy to miss, and confusing right at the start of a new
month. Every page now always defaults to the actual current month, and each page's selection is
now remembered independently when navigating between tabs, resetting to the current month again
on profile switch.

### New: A Friendlier Empty State for a Transaction-Free Month
The Transactions page now says "No transactions for this month - Add some now!" (with a button
to add one directly) when a month is genuinely empty, instead of a generic "no results" message
meant for search/filters.

### Fixed: "Try Demo Mode" Could Appear After You Already Had Real Data
The empty-month Demo Mode button only checked whether demo accounts already existed, not whether
the profile had any real transactions at all - so it could resurface on a month with no data even
after you'd been actively using the app. It now only appears for a profile that has never had any
real transactions, and correctly reappears if everything is later cleared.

## Compass 0.9.5 — Data Integrity Hardening 🔒

A behind-the-scenes release focused on making sure your data stays correct and intact, even when
something goes wrong mid-operation - plus a handful of real import correctness fixes found during
the audit.

### Fixed: Schema Migrations Could Be Left Half-Applied
Migrations that rebuild a table (rename → recreate → copy → drop) previously ran as several
separate, independently-committed database statements. If Compass or the computer crashed partway
through, the database could be left with a renamed-away table and no replacement. Every migration
now runs inside one real database transaction - a crash or error midway rolls back the whole thing,
leaving your existing data untouched instead of half-migrated.

### Fixed: A Crash Mid-Import Could Leave a Partially Imported File
CSV/XLSX imports inserted transactions one row at a time, each its own independent database write.
Imports now run inside one transaction, so an interruption partway through can no longer leave a
statement half-imported.

### Fixed: Import Summaries Could Mislabel Real Errors as "Duplicates"
Any row that failed to insert - for any reason - was previously counted as a "duplicate skipped,"
even if the real cause was a genuine data or constraint error unrelated to it already existing.
Compass now distinguishes true duplicates from real errors and reports them separately, so the
import summary never quietly hides a real problem behind a reassuring "duplicates skipped" message.

### Fixed: Two Legitimately Identical Transactions in One File Could Be Wrongly Treated as a Duplicate
Two genuinely separate transactions with identical details (e.g. two $5 purchases at the same
merchant on the same day) could collide and get silently dropped as if the second one were a
re-import of the first. Both are now imported correctly, while re-importing an already-imported
file is still correctly recognized as all duplicates.

### Fixed: Capital One-Style Statements (Separate Debit/Credit Columns) Silently Dropped Rows
Banks that export two separate amount columns instead of one signed column - Capital One being the
common example - previously only read the Debit column, so any row with a value only in the Credit
column (a payment, refund, or cashback) was silently skipped. Compass now supports mapping separate
Debit and Credit columns directly, so nothing gets left out.

### Fixed: Saved Column Mappings Could Collide Across Profiles
Two profiles importing the same bank's CSV format could overwrite each other's saved column
mapping. Mappings are now scoped per profile.

### Fixed: A Manually Chosen Sign-Flip Setting Wasn't Saved
The "flip amounts" choice for banks that export expenses as positive numbers wasn't persisted with
the rest of a saved column mapping, so it could be lost on a later import for a custom bank. It's
now saved and restored correctly.

### Fixed: Backups Read the Database File Directly
Backups previously read `compass.db` straight off disk while the app had it open, relying on the
assumption that nothing would ever be mid-write. Backups now take a proper SQLite snapshot first,
guaranteeing a consistent copy every time.

### Fixed: A Restore Could Leave a Mismatched Database/Key Pair
If restoring a backup failed partway through swapping files into place, the live database and its
encryption key could end up as a mismatched pair. Restores are now fully rolled back on any
failure, and the newly restored database is verified to actually open before being trusted.

### Fixed: Impossible Calendar Dates Could Be Silently Accepted
A date like February 31st could previously be normalized into a string and imported as if it were
valid. Dates are now validated against the real calendar before being accepted; amount parsing also
now recognizes trailing "CR"/"DR" suffixes some statements use.

### Cleanup: Removed Dead Code
Removed several unused/unreachable leftovers found during this pass, including an entire unused
Rust command module that wasn't even compiled into the app.

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

