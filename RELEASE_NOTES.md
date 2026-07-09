# Created by @tylahfam97 

Hello!

## Compass 0.4.0 - Data Ownership Update

This release brings full control over your transaction data: edit, add, and delete transactions directly in the app, undo entire imports, and export anything to CSV. The UI has also been sharpened throughout.

### Edit, Add and Delete Transactions
- Click the **pencil icon** (or **note icon** if notes exist) on any transaction row to edit date, description, amount, category, and notes
- **+ Add** button creates manual transactions (cash purchases, Venmo/Zelle payments, anything not in a bank export)
- **Delete** individual transactions with a single confirm
- Manual entries use a unique internal ID so they never conflict with imported rows

### Import History and Undo
- Every CSV import is now recorded with filename, date, and row count
- **Undo** any import with one click - removes all linked transactions instantly
- Importing a duplicate file now shows a clear "Already imported" message instead of the confusing "0 imported, N skipped"

### CSV Export
- **Export** button on the Transactions page downloads the current filtered view (respects month, all-time, and search filters) as a CSV with Date, Description, Category, Amount, Balance, and Notes columns

### Reports: Custom Date Ranges
- Toggle between **Month** and **Custom** range modes in Reports
- Custom mode supports free date range selection plus quick presets: **This quarter**, **Last quarter**, **Year to date**, **Last 12 months**

### Budget On-Pace Projection
- Each budget card now shows **On pace for $X by month-end** so you can see projected overspend before it happens, not after
- Shown in amber when approaching the limit, red when already over

### Insights (formerly Agent)
- Navigation label renamed to **Insights** for clarity
- A dot badge appears on the sidebar when there are active warnings

### Profiles tooltip
- The Profiles panel now explains what profiles are for: "Track spending per person or account separately"

### Auto-Categorization
- **100+ new rules** covering the most common real-world merchants: Amazon, Walmart, Instacart, Apple, Racetrac, QT, CVS, Walgreens, Waffle House, DashPass, Progressive, and many more
- **6 new system categories**: Gas & Fuel, Subscriptions, Insurance, Bank Fees, Transfers, Gifts & Donations
- **Description normalization** — bank format noise like `DD *`, `IC* `, `PP*`, and `*1A52U9IQ3` trailing codes are stripped before matching, so merchants are correctly identified regardless of how your bank formats the description
- **Regex rule support** — rules can now use regular expressions in addition to `contains` and `starts_with`
- **Transfers excluded from expenses** — internal bank transfers, Keep the Change, Zelle, Venmo, and credit card payments are routed to the new Transfers category and excluded from all expense totals, reports, and agent calculations

### ✦ Auto-Categorize Button
- One-click **Auto-Categorize** on the Transactions page re-runs all rules against your existing uncategorized transactions
- Uses the same batched engine as the importer — completes in under a second regardless of transaction count

### Rules Manager
- New **⚙ Rules** button on the Transactions page opens a full rules manager
- View all 130+ system rules and all your custom rules in one place
- Add, delete, and configure custom rules (pattern, match type, category, priority) without touching any settings

### Learn from Corrections
- When you manually change a transaction's category, a **"Create Rule?"** prompt appears
- One click creates a permanent rule so future imports are auto-categorized correctly

### Agent Insights (5 new)
- **Top merchants** — highlights your top 3 spending merchants this month
- **Food delivery ratio** — flags when delivery apps are >30% of your food budget and estimates monthly savings from cooking more
- **Subscription summary** — lists all detected subscription charges and their monthly total
- **Paycheck expected** — predicts your next deposit date based on your pay cycle (shown within a 14-day window)
- **Overdraft alert** — fires when Bank Fee transactions are detected this month
