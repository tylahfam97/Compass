# @tylahfam97 

Hello Discord, @here !

## Compass 0.3.80 — Smart Categorization

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
