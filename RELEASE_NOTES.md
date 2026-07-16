# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.7.0 — Calculated Running Balances

### New: Running Balance Without a Balance Column
Statements that don't export a running balance (most plain Date/Description/Amount CSVs) can now still get one. On the import wizard's Balance step, when you choose "No balance column," an optional **Starting balance** field appears. Enter your real account balance right before these transactions and Compass calculates an accurate running balance for every transaction, chronologically, on top of it. Leave it blank and Compass still calculates a relative running total starting from $0, so balance charts and low-balance alerts always have something to work with.

The starting balance is saved on the account, so future imports without a balance column keep the running total going automatically — no need to re-enter it every time (though you can update it any time by re-entering a new value on your next import).


### Import Wizard: Manual Column Fix-Up for Investments
Each section of a parsed investment statement (Stocks, ETFs, Cash, Other) now has a **Fix columns** control. It shows every column detected in that section's header row, pre-selected to Compass's best guess, and lets you remap any field (Description, Symbol, Shares, Price, Market Value, Cost Basis, Trade Date, Dividend/Share, Est. Annual Income) on the spot — the preview table and totals update immediately. Each option also shows how many rows actually have data in that column (e.g. "Market Value — 0/34 filled"), so you can tell at a glance whether a column is worth mapping instead of guessing.

Sections where every value field comes back empty now show an inline notice explaining that Compass found the holdings but no numbers to go with them, rather than silently showing blank values with no explanation.

### Import Wizard: More Reliable XLSX Reading
Excel files are now read with formatted display text (matching what a bank/brokerage actually printed, e.g. `$1,234.56`) instead of raw numeric cell values, and every cell is defensively converted to a string — a stray number or date object can no longer break parsing. Investment workbooks with multiple tabs (Summary, Positions, Activity, etc.) are now scanned automatically to find whichever sheet actually contains the Portfolio Positions table.

### Smarter Profile Suggestions — Now for Credit Cards Too
The "which profile should this go in" logic introduced for investments now also runs for **Credit Card Statement** imports. Before importing, Compass checks:
1. Does your current profile already track this kind of account? If so, nothing changes.
2. Does another profile already have one (an existing investment or credit card account)? Suggest switching there.
3. Is there a profile whose name looks like it's meant for this ("Investments", "Credit Cards", etc.)? Suggest switching there instead of creating a duplicate.
4. Otherwise, offer to create a dedicated profile — always with the option to just use your current profile instead.

Creating a suggested profile only switches you into it; it never auto-imports without a final confirmation click.

### Import Wizard: Better Bank/Card Auto-Detection
Presets with a distinctive column fingerprint (starting with American Express's activity export, which includes `Extended Details` and `Appears On Your Statement As` columns found nowhere else) are now auto-applied even if you never click the preset button — so sign conventions like Amex's expenses-as-positive-numbers are handled correctly without extra steps.

### Fixed: Credit Card Payments No Longer Inflate Income
Added categorization rules so common "___ PAYMENT - THANK YOU" card-payment descriptions (Amex, Chase, Discover, and similar formats) are automatically filed under **Transfers** instead of Uncategorized — keeping them out of income and expense totals, same as other internal money movements.

---

### New: Investment Portfolio Import
The import wizard now opens by asking what you're importing: **Bank Statement**, **Credit Card Statement**, or **Investment / Brokerage**. Bank and credit card statements flow through the existing column-mapping wizard as before. Investment statements skip straight to a dedicated parser built for Wells Fargo Advisors–style "Portfolio Positions" exports (`.csv`, `.xlsx`, `.xls`).

The parser walks each section of the statement — Stocks, ETFs, Mutual Funds, Cash, Other — reading that section's own header row and every individual tax lot underneath it, until it hits that section's `Total` row. The statement's "Priced as of" date is detected automatically and used to tag the import as a dated snapshot.

### New: Investments Page
A new **Investments** tab shows:
- KPI tiles for total portfolio value, cost basis, unrealized gain/loss, and estimated annual dividend income
- Holdings grouped by symbol, with an expandable row revealing individual tax lots (shares, purchase date, cost basis per lot)
- A portfolio-value-over-time chart once two or more statements have been imported — every import adds a new dated snapshot rather than overwriting the last one

Dividend and "Est. Annual Income" figures are clearly labeled as the brokerage's projected estimates, not a record of dividends actually paid.

### New: Dedicated Investments Profile Prompt
The first time you import an investment statement into a profile that doesn't already have one, Compass offers to create a separate **Investments** profile and import there instead — keeping brokerage holdings from mixing into everyday spending totals. You can decline and keep everything in your current profile if you'd rather.

### New: Net Worth Toggle
The Dashboard and All Accounts Overview pages now show a **+ Investments** toggle next to your balance. Turn it on to fold your latest portfolio value into a combined net worth figure; turn it off to see liquid cash only. The setting is remembered across sessions.

### Fixed: Import Wizard Button Labels
Several "Continue" / "Skip to Preview" button labels and a couple of live-preview values (parsed date, parsed amount) in the column-mapping wizard had gone blank in a previous build. They've been restored.

### Import Wizard: Full Overhaul

#### Excel / XLSX Support
Compass can now import `.xlsx` and `.xls` spreadsheets directly alongside CSV files. The drag-drop zone, file picker, and batch import all accept Excel files. The wizard processes them through the same column-detection pipeline as CSV.

#### Multi-Month CSV Handling
When you drop a CSV that spans more than one month, the preview step now shows a chip list of every detected month instead of a single month picker. All transactions across all months are imported, and the app navigates to the all-time transaction view after import rather than pinning to a single month.

#### Malformed Row Protection
Rows with unparseable dates, amounts that fail numeric validation (`!isFinite`), or missing required fields are now silently skipped and counted as “skipped” rather than crashing or hanging the import loop.

#### Clearer Step Headings
Each column-selection step now opens with a large bold heading and a Lucide icon:
- 📅 **Which column is the Date?**
- 🏷 **Which column is the Description?**
- 💲 **Which column is the Amount?**
- 📊 **Is there a Balance column?** (optional)

#### Encoding Fix
All garbled characters from previous builds (broken emoji, curly quotes, em-dashes rendered as `â€”`) have been replaced with proper Lucide icons and clean ASCII. Upload and done screens now show `Upload`, `Loader2`, `CheckCircle2`, and `Info` icons instead of corrupted byte sequences.

---

### Transactions: Sortable Column Headers
Click any column header to sort the transaction list. Click again to reverse the direction. An arrow indicator shows the current sort column and direction.

- **Date** defaults to newest-first on first click
- **Amount / Balance** default to largest-first
- **Description / Category** default to A→Z
- Clicking a different column resets to that column’s natural default

Sort state is reflected in CSV exports as well.

### Transactions: No Row Limit on All-Time View
The 500-row cap only applies to single-month views. When **All time** is active, up to 10,000 rows are loaded and displayed. A scroll-friendly table handles the larger result set.

### Transactions: Net Summary Card
The plain text “X in / Y out” line has been replaced with three equal tiles above the table:
- **Income** (green) — total credits for the current view
- **Expenses** (red) — total debits
- **Net** (green or red) — income minus expenses

### Transactions: Transfers Disclaimer
When editing a transaction and selecting the **Transfers** category, an amber inline notice now appears: *“Transfers are excluded from income and expense totals across all reports and insights.”* A `title` tooltip on the Transfers option in every category dropdown provides the same hint on hover.

### Category Dropdowns: Grouped & Alphabetised
Every category dropdown in the app (import wizard, transaction editor, budget form, goal form, categorization rules) now uses grouped `<optgroup>` sections:
- **System** — built-in categories, A→Z
- **User Created** — your custom categories, A→Z

---

### Trends: Profile / Global Toggle
The Trends page now has the same animated Profile | Global scope toggle as Budgets and Insights. Switching to Global aggregates income, expenses, and category spend across all unlocked profiles. The full PIN unlock sequence is supported.

### Trends: All-Time Summary
Three KPI tiles always appear at the top of the Trends page regardless of the selected range:
- **All-Time Income** — every credit ever imported (transfers excluded)
- **All-Time Expenses** — every debit ever imported (transfers excluded)
- **All-Time Net** — the running surplus or deficit since your first import

### Trends: Cumulative Net Chart
A new line chart shows the **running total of net savings** month by month across all imported history. The indigo line rises when months are net-positive and falls when net-negative. A dashed zero reference line makes it immediately obvious when you crossed from deficit to surplus (or vice versa).

---

