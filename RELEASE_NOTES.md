# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.7.1 — Net Worth, Health Scores, and Interactive Charts

### New: Net Worth Tracking on the Overview Page
The Overview page ("All Accounts") now has a **Profile / Global** toggle, matching the same pattern used on Budgets and Insights. In Profile mode you see only your active profile's own numbers — no PIN needed. Switching to Global aggregates every profile, prompting for a PIN on any locked profile before including it in the combined totals. Both modes now show a persistent breakdown of **Liquid**, **Investments**, **Debt**, and **Net Worth** (liquid + investments − debt, with credit card balances netted in automatically) instead of the old toggle-based "include investments" balance line.

### New: Net Worth Card, Health Scores, and Top Performers on Insights
The Insights page has a new **Net Worth** card right under the Financial Health Score: current net worth, a Liquid/Investments/Debt breakdown, a 12-month sparkline, and this year's dollar/percent change with a growth-or-decline indicator. Click any point on the sparkline to reveal that month's full breakdown.

Two new standalone benchmark scores sit alongside it:
- **Credit Card Health** — scores your current balance against the average American's ~$6,000 credit card debt, with a small bonus or penalty depending on whether your balance grew or shrank this month.
- **Investment Health** — scores your portfolio's return against the long-run ~7%/yr average U.S. stock market return (inflation-adjusted).

Both gracefully show "No data yet" if you don't have a credit card or investment account tracked, and each has an info icon explaining exactly how it's calculated. A **Top Performers** section follows, ranking your holdings by ROI% within each security type (Stocks, ETFs, Mutual Funds, Cash).

New insights also fire when your net worth grows or declines meaningfully month over month.

### New: Fidelity and Thrivent Investment Import Presets
Two new brokerage formats are now auto-detected from their column headers, alongside the existing Wells Fargo Advisors parser:
- **Fidelity** — flat CSV exports, grouped into sections by security type (Stocks & ETFs, Mutual Funds, Cash)
- **Thrivent** — flat CSV exports, grouped into sections by account name (handles multi-account files like a 401(k) and IRA in one export)

No preset selection needed — the format is detected automatically from the file's headers.

### New: ROI% on the Investments Page
Every holding now shows its ROI% (gain/loss vs. cost basis), and holdings within each section are sorted with the highest performers at the top. The same ROI calculation now also has an info icon explaining that Est. Annual Income is the brokerage's own projected estimate (dividends, interest, and other distributions), not a record of income actually paid.

### New: Click-to-Expand Charts
A few charts now open a drill-down panel with more detail when you click into them:
- **Net Worth sparkline** (Insights) — click a point for that month's Liquid/Investments/Debt breakdown
- **Top Spending Categories** (Dashboard) — click a bar for that category's top transactions this month, with a link to view them all
- **Income vs Expenses** and **Spending by Category** (Trends) — click a month or category for its breakdown, with a link into Transactions pre-filtered to match

Clickable charts and cards now have a subtle blue-to-gold shimmer border so it's clear at a glance they can be clicked; every other card in the app carries a matching, quieter blue-to-white ambient shimmer for a cohesive look.

### New: Transfers Category Disclaimer
An info icon next to the category filter on the Transactions page explains that **Transfers** tracks money moved between your own accounts and is excluded from income/expense totals everywhere in the app. The first time a Transfers-categorized transaction appears in a session, a one-time banner reinforces this, with a "Don't show again" option that persists across app restarts.

### Fixed: Amex Sign Convention on Repeat Imports
Re-importing an Amex statement into the same profile now correctly keeps expenses flipped to negative every time. Previously, a saved column-mapping profile could silently reset the sign convention to "already signed," causing charges to appear as income on subsequent imports.

### Fixed: Cancel Button on Every Import Wizard Step
The Date, Description, Amount, and Balance steps of the import wizard were missing a Cancel button (present on the other steps). All six steps now let you back out of an import at any point.

### Fixed: Chart Hover Highlighting
Hovering a bar in Dashboard's Top Spending Categories or the Trends charts previously lit up the entire row/column in gray-white, extending well past the bar itself. Hovering now only highlights the actual bar, in a lighter shade of its own color.

### Fixed: Stray Focus Outline on Chart Clicks
Clicking a bar or chart point no longer leaves a white focus-ring box behind — recharts' built-in accessibility layer was triggering the browser's default focus outline on click.

### Polish
- Smoother, spring-based expand/collapse animation for all drill-down panels, with a `layout`-aware transition so panels that load their content on demand (a brief "Loading…" before the real content arrives) resize gracefully instead of jumping
- The Financial Health Score's "?" icon now visibly reacts on hover (it was already clickable — the whole card opens the score breakdown — but gave no visual hint on its own)
- Transactions page now accepts a category filter passed in from other pages' "View all" links, in addition to the existing month filter