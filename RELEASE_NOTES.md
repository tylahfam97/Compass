# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.7.5 — Accuracy Fixes & Interface Polish

### Fixed: Savings Rate & Health Score Still Counting Credit Card Spending
A few calculations were missed in the earlier credit-card-accounting fix: the "Avg Savings Rate" stat, the Insights savings-rate warning, and the Financial Health Score's Budget Health component were still counting credit card purchases as expenses, understating how healthy your savings rate actually is. These now correctly reflect checking and investment activity only, consistent with the rest of the app - and no longer double-count debt that's already tracked separately by the Credit Card Health score.

### Changed: Dashboard "Checking Balance"
The Dashboard's headline balance figure is now explicitly checking/bank accounts only - credit card debt no longer gets blended into it. It's relabeled "Checking Balance" so it's clear what it represents; investments remain an optional add-on via the existing toggle.

### Changed: Credit Card Balances, Redesigned
Replaced the shared line chart on the Dashboard (multiple near-flat debt lines competing for space) with a clean per-card tile layout - each card shows its current balance, a small trend sparkline, and a paid-down/grew-by indicator at a glance, no click required.

### New: Per-Account Balance Trends on Overview
The Overview page's profile summary cards now split checking and credit card balances into separate trend lines instead of blending them into one number, matching how the Dashboard and Trends pages already handle multi-account balances.

### Changed: Insights - Wins, Observations & Action Items
The expanded list under each Insights category is now a horizontally-scrolling row of polished cards instead of a long vertical list, making it easier to browse at a glance.

### Changed: Rules Manager & Categories Buttons
Both buttons on the Transactions page now clearly say "Rules Manager" and "Categories" instead of being bare icons. The Rules Manager's rule list no longer shows the internal priority number for each rule - one less thing to parse when you're just scanning your rules.

### Fixed: Overview Chart Tooltip Rendering Behind Other Content
Hovering over the balance sparklines on the Overview page could show the tooltip clipped behind the In/Out/Net summary box below it. The tooltip now always renders on top.

### Fixed: Import Hardening
Added a file-size limit on CSV/XLSX imports to prevent an accidental huge file from freezing the app, and the Import button now disables itself while an import is in progress to prevent accidental double-imports. "Try Demo Mode" now hides itself once demo accounts already exist for a profile, instead of allowing duplicates.

### Changed: Modal Consistency
Every modal in the app (transaction editing, categories, rules, PIN entry, the health score breakdown) now closes on Escape or a click on the dimmed backdrop, and fades in/out smoothly instead of appearing and disappearing instantly.

### Polish: Loading States & Small Details
Dashboard, Overview, Reports, and Trends now show shaped skeleton placeholders while loading instead of plain "Loading…" text. Long category and profile names now truncate cleanly instead of breaking their containers. The launch-screen particle field is denser.

