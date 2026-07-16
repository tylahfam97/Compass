# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.6.0 — Import Overhaul, Sortable Transactions & Trends Expansion

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

