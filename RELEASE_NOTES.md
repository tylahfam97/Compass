# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.8.9 — Budget Rollover, Portfolio & Category Charts, Milestone Celebrations 🎉

A polish-and-features release: budgets can now carry unspent money into next month, two new
donut charts make portfolio and spending composition easier to read at a glance, and Compass
now throws a little confetti when you hit a real financial milestone. Plus a raft of bug fixes,
missing-feature gaps closed, and an app-wide accessibility/consistency pass.

### New: Budget Rollover
Monthly budgets can now opt in to rolling over unspent money into the next month, envelope-
budgeting style. Enable it from the "Add Budget" form (or toggle it on an existing budget with
the new "↻ Rollover" button), and any leftover under your limit carries forward as a visible
"+$X rolled over" badge, automatically raising that month's effective limit. Overspending never
creates a carried-forward debt — it simply resets that month's rollover to zero.

### New: Investment Allocation & Category Spending Donut Charts
The Investments page now shows a portfolio allocation donut (Stocks/ETFs/Mutual Funds/Cash/
Other) with a percentage legend, replacing the old plain-text breakdown. The Reports page's
"Spending by Category" section gets the same treatment — a donut chart (top categories plus an
"Other" slice) sits next to the existing month-over-month table, so you can see where your
money went at a glance instead of only scanning numbers.

### New: Milestone Celebrations 🎉
Compass now notices a handful of real milestones — your net worth going positive for the first
time, a loan or credit card balance hitting $0, or a savings goal reaching its target — and
celebrates with a small gold confetti burst and a banner. Each milestone only celebrates once.

### New: Goal Editing
Goals can now be edited in place (name, type, category, target, timeframe) instead of only
delete-and-recreate. Click "Edit" on any goal card to update it.

### New: Direct Transaction Delete
Transactions can now be deleted straight from the table row (hover to reveal a delete icon,
with an inline confirm step) instead of requiring you to open the Edit modal first.

### Improved: Delete Confirmations Everywhere
Deleting a Budget or a Goal now requires a two-step "Delete? / Cancel" confirmation instead of
removing it immediately on the first click — matching the safer pattern already used elsewhere.

### Improved: Keyboard Accessibility
Hover-only actions (budget scope/rollover toggles, delete buttons, insight dismiss buttons) are
now also reachable via keyboard Tab/focus, not just mouse hover.

### Improved: Consistent Colors & Month Labels
Financial figures (gains/losses, income/expenses) now consistently use the app's success/error
color tokens instead of a mix of hardcoded colors, and chart axes/tooltips across Trends,
Reports, and the Agent tab now show friendly month labels ("Jul '26") instead of raw "2026-07"
strings or bare numbers.

### Improved: Reduced Redundancy on Overview
Removed a per-profile mini In/Out/Net grid on the Overview page that exactly duplicated the
page's own top summary banner.

### Fixed: Dashboard/Account Modal Crash on Hover
Hovering or clicking certain charts (an account's balance history, Dashboard's checking/credit/
loan sparklines, Overview's profile-card sparklines, the Agent tab's Net Worth chart) could
throw an error and leave the page stuck showing "Something went wrong" until manually retried.
Root cause was a chart tooltip formatting a value that Recharts hadn't actually attached a date
to — now fixed everywhere it occurred.

### Fixed: Error Screens No Longer Follow You Between Pages
Previously, a one-time rendering error on any page could leave every other page you navigated
to afterward stuck on the same error screen until a manual retry. Each page now gets its own
fresh error boundary.

### Fixed: Net Worth Chart Click & Month Display
Clicking a point on the Agent tab's Net Worth chart now correctly opens that month's Liquid/
Investments/Debt/Net Worth breakdown (it previously did nothing), and the Savings Rate
sparkline's tick labels now show real month names instead of raw digits.