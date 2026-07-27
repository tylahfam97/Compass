# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.9.0 — Interactive Debt Payoff & a Smarter Companion Voice 🎯

A feature-and-hardening release: the Debt Payoff Dashboard goes from three fixed scenarios to a
live, interactive simulator, insights get varied phrasing instead of repeating the same static
sentence every time, and a real database-encryption reliability issue on Windows gets fixed and
hardened against ever silently recurring.

### New: Interactive Debt Payoff Simulator
The Debt Payoff plan no longer shows three fixed scenarios (Stay the Course / Balanced Cushion /
Most Aggressive). Toggle exactly which discretionary categories (Entertainment, Shopping,
Subscriptions, and more) you want to redirect toward debt, then drag a single slider — your
payoff date, total interest, and monthly cushion recompute instantly. A new payoff timeline
chart shows each account reaching $0 in sequence, and a "quick win" callout compares the
avalanche (cheapest) vs. snowball (fastest visible progress) approach for your specific debts.

### New: Debt Payoff Progress Badges & Milestones
Any loan or credit card with enough balance history now shows "X% paid off since you started
tracking this" directly in its payoff plan. Milestone celebrations extend beyond "fully paid
off" to 25%/50%/75% partial progress on the way there.

### New: A Little More Personality in Insights
Insight text now varies its phrasing and references your prior period ("up from $1,200 last
month") instead of showing the exact same sentence every time the same insight fires. Budgets
and Trends now also get short narrative callouts — e.g. "$40 under budget with 6 days left" —
instead of only charts and raw numbers.

### Fixed: Database Encryption Key Reliability on Windows
The database encryption key wasn't persisting to Windows Credential Manager / macOS Keychain —
it silently relied on a backup file every single launch instead, invisibly but safely. This is
now fixed so the key persists through the OS's native secure store as originally intended.

### Hardened: Encryption Key Loading Never Silently Replaces Your Data
As a defense-in-depth measure alongside the fix above, the app now refuses to generate a new
encryption key whenever an existing database is present on disk. If a valid key genuinely can't
be found, it fails with a clear error and leaves your database completely untouched, rather than
ever silently creating an empty replacement.