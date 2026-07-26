# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.8.8 — Debt Payoff Plans & Sharper Subscription Detection 💳

A big one for anyone carrying a credit card or loan balance: Compass can now build you a real
payoff plan, and a batch of clarity fixes make credit card imports, transfers, and recurring
charges much easier to trust at a glance.

### New: Debt Payoff Plan
Click "Credit Card Health" or any row on the Debt Payoff Dashboard (Agent tab) to see three
side-by-side payoff strategies - Stay the Course (minimums only), Balanced Cushion (redirect
~half your discretionary spending), and Most Aggressive (redirect all of it) - each with a
projected debt-free date, total interest paid, and monthly cushion kept. Includes a "What Can
Be Cut" breakdown of exactly which discretionary categories are feeding the plan.

### New: "Excluded" Category
A second "leave this out of my totals" bucket alongside Transfers, for anything else you want
left out of income/expense totals without mislabeling it as a transfer (reimbursements,
one-off adjustments, etc.). The category picker now groups Excluded/Transfers, your own
categories, and system categories into clearly separated, alphabetized sections.

### New: Optional Minimum Payment for Credit Cards
Credit card imports can now optionally record a minimum payment, same as loans already could -
improves the Debt Dashboard's Cash-flow-First ranking and the new Debt Payoff plan's estimate.

### Improved: Clearer Credit Card Imports & Transfer Handling
The import wizard's sign-flip step now shows each transaction's description next to its
amount, instead of a bare number, so it's obvious which rows are purchases vs. card payments.
A finished import now also reports how many transactions were recognized as transfers/payments
and excluded from your totals - so a card payment is never double-counted as both a checking
withdrawal and a card credit. Income/Expenses totals on Dashboard, Overview, and Transactions
now carry an info tooltip spelling this out too.

### Improved: Subscription Detection
Recurring charge detection now matches by day-of-month or "Nth weekday of month" (e.g. "3rd
Thursday") cadence instead of requiring an exact repeated amount, catching bills whose amount
drifts slightly - and only flags a charge once it's landed 2+ consecutive months in a row. The
Subscription Inventory and Ghost Subscriptions lists are now sorted by amount, highest first,
with no cutoff - every recurring charge is shown.

### Improved: "Apply Rules to All Transactions"
"Auto-Categorize" has been renamed and restyled into a bigger, more prominent button that makes
clear it re-applies your current rules to every transaction, including ones already categorized.

### Fixed: Debt Payoff Plan Counted Credit Card Spending as "Available Cash"
The discretionary-spending estimate that powers the Debt Payoff plan was including money
already spent on a credit card as if it were free cash that could be redirected toward debt.
It now only counts checking/savings spending - money already on a card is part of the debt
balance itself, not money sitting around to pay it down with.

### Fixed: "Excluded" Category Could Silently Fail to Appear
If you'd already created any custom category after this release's "Excluded" category was
introduced, a database quirk meant it could silently never get created at all. Existing
databases are automatically repaired on next launch.