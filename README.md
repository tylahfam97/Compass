<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Compass" />
</p>

# $${\color{#58a6ff}Compass}$$

### *Own your financial life — privately, locally, and without judgment.*

Compass is a free, open-source Windows desktop application that helps you understand where your money is going. Every byte of your data lives exclusively on your device. Nothing is ever uploaded, synced, or shared.

---

## $${\color{#C08A1C}What \space \color{#C08A1C}Is \space \color{#C08A1C}Compass?}$$

Compass is a personal finance companion built for real people — not spreadsheet experts. Import your bank statements, see your spending broken down automatically, track your budgets and goals, and catch those sneaky recurring charges you forgot about. No accounts. No subscriptions. No cloud. Just clarity.

---

## $${\color{#C08A1C}Key \space \color{#C08A1C}Features}$$

### 💳 Statement Import
Import bank and credit card statements in CSV format from any institution. Compass automatically detects the column layout for each bank (date, description, amount) and remembers it for future imports — so your second import from the same bank takes one click. Duplicate transactions are detected and silently skipped using a content hash.

### 🏷️ Automatic Categorization
Transactions are automatically matched against a built-in set of rules — groceries, restaurants, transportation, entertainment, subscriptions, healthcare, and more. You can override any category with a single click, and the change takes effect immediately.

### 📊 Spending Trends
Visualise your spending over the last 3, 6, or 12 months with two chart types:
- **Income vs Expenses** — monthly bar chart showing how much came in and went out
- **Spending by Category** — stacked monthly breakdown of where money actually went (top 6 categories + "Other")

### 📅 Dashboard
Your home screen for any selected month. Shows income, expenses, and net savings as summary cards, a horizontal bar chart of top spending categories, and the 10 most recent transactions. Navigate freely between any month — past or future — using the `‹` `›` arrows.

### 📋 Reports
Four purpose-built reports run automatically across your data:

| Report | What it shows |
|---|---|
| **Spending by Category** | This month vs last month per category with % change, colour-coded red/green |
| **Month over Month** | Income, expenses, and net for the last 6 months in a table |
| **Top Expenses** | Ranked list of the biggest individual transactions for the selected month |
| **Most Recurring Payees** | Frequency, average cost, and total paid to each merchant |
| **👻 Ghost Subscriptions** | Charges with the exact same description *and* amount appearing in 2+ months — your forgotten subscriptions, listed with monthly and estimated yearly cost |

### 💰 Budgets
Set soft monthly spending limits per category. Each budget shows a live progress bar and how much has been spent vs the limit. Income categories show *earned vs target* instead of spent. Switch months freely to review past budget performance. No enforcement, no penalties — just awareness.

### 🎯 Goals
Set financial intentions and track them monthly:

| Goal Type | What it tracks |
|---|---|
| **Net Savings** | Monthly net (income − expenses) at or above your target |
| **Spending Limit** | Category spending at or below your target |
| **Income Target** | Income at or above your target |

Each goal shows a progress bar, current vs target amount, and an "On track ✓" or "Needs attention ⚠" status.

### 🔍 Transactions
Full searchable, filterable transaction list. Filter by month or toggle **All time** to see your entire history. Search by description, re-categorize any transaction in one click, and view the running account balance alongside each transaction.

- **Edit** any transaction's date, description, amount, category, or notes
- **Delete** transactions you don't need
- **＋ Add** manual transactions for cash, Venmo, or anything not in a bank export
- **↓ Export** the current filtered view as a CSV (works with month, all-time, and search filters)
- **✦ Auto-Categorize** re-runs all rules against uncategorized transactions in one click

### 📋 Reports
Five purpose-built reports run automatically across your data:

| Report | What it shows |
|---|---|
| **Spending by Category** | This period vs last period per category with % change |
| **Month over Month** | Income, expenses, and net across your selected date range |
| **Top Expenses** | Ranked list of the biggest individual transactions |
| **Most Recurring Payees** | Frequency, average cost, and total paid to each merchant |
| **👻 Ghost Subscriptions** | Charges with the exact same description and amount in 2+ months |

Reports support **month navigation** or a **custom date range** with presets: This quarter, Last quarter, Year to date, Last 12 months.

### 💰 Budgets
Set soft monthly spending limits per category. Each budget shows a live progress bar, how much has been spent vs the limit, and an **On pace for $X** projection so you can see a potential overspend before the month ends. No enforcement, no penalties — just awareness.

### 💡 Insights
The Insights page (formerly "Agent") analyzes your spending and surfaces actionable patterns:
- Warning when you're on pace to exceed a budget
- Top 3 merchants by spend this month
- Food delivery as a % of your food budget
- Detected subscriptions with monthly and annual totals
- Paycheck timing prediction based on your pay cycle
- Overdraft / bank fee alerts

### 💼 All Accounts Overview
The **Overview** page aggregates all profiles in one place. Each account card shows current balance, a 60-day sparkline, and this month's income/expenses/net. Click any card to jump to that account's Dashboard.

### 💰 Running Balance
Import your bank's "Running Balance" column to unlock balance cards, sparklines, and the Balance Over Time chart in Reports.

### 🏷️ Smart Categorization
100+ built-in rules cover Amazon, Walmart, DoorDash, Instacart, CVS, Waffle House, Progressive, and many more. Bank-format noise is stripped automatically. Manage your own rules from **⚙ Rules**, or let Compass learn from manual corrections with the "Create Rule?" prompt.

### 📥 Import History
Every CSV import is logged with filename, date, and row count. **Undo** any import to remove all linked transactions instantly.

### 🔄 In-App Auto-Updates
Click **Check for updates** in the sidebar to silently apply the latest release. Updates are cryptographically signed and verified.

---

## $${\color{#C08A1C}Privacy \space \color{#C08A1C}and \space \color{#C08A1C}Data}$$

> **Your data never leaves your device.**

- All data is stored in a local SQLite database in your Windows user profile (`%APPDATA%\com.compass.app\`)
- No telemetry, no analytics, no accounts, no internet connection required after installation
- Uninstalling Compass removes all stored data

---

## $${\color{#C08A1C}Installation}$$

### Requirements
- Windows 10 or Windows 11 (64-bit)
- No additional software required — WebView2 is installed automatically if missing

### Download
Download the latest installer from the [Releases page](../../releases):

| File | Type | Use when |
|---|---|---|
| `Compass_x.x.x_x64-setup.exe` | NSIS EXE | Standard interactive installer with directory picker |
| `Compass_x.x.x_x64_en-US.msi` | Windows Installer | Enterprise/IT deployment, Group Policy |

### Silent / Automated Installation
```
# NSIS EXE — completely silent
Compass_0.1.0_x64-setup.exe /S

# MSI — silent, no reboot prompt
msiexec /i Compass_0.1.0_x64_en-US.msi /quiet /norestart
```

---

## $${\color{#C08A1C}How \space \color{#C08A1C}to \space \color{#C08A1C}Use}$$

### 1 — Import your first statement

1. Export a CSV statement from your bank's online portal (most banks support this under *Transactions → Download / Export*)
2. Open Compass and click **Import** in the left sidebar
3. Drag and drop (or browse for) the `.csv` file
4. Confirm or adjust the column mapping — Compass auto-detects date, description, and amount columns and shows live sample values from your file
5. Click **Import X Transactions** — categories are applied automatically

> On your second import from the same bank, the column layout is remembered and pre-filled.

### 2 — Review and correct categories

- Go to **Transactions**
- Click any coloured category badge to change it
- The change saves immediately

### 3 — Check your Dashboard

- The **Dashboard** shows your income, expenses, and net savings for any month
- Use `‹` `›` to navigate months or type a month directly in the date picker
- The top categories chart and recent transactions update live with each month change

### 4 — Explore Spending Trends

- Go to **Trends** and choose a 3, 6, or 12 month window
- The top chart shows monthly income vs expenses side by side
- The bottom chart shows spending broken down by your top categories

### 5 — Set a Budget

1. Go to **Budgets** and select the month you want to plan for
2. Choose a category, enter a monthly limit, and click **Add**
3. The progress bar fills as you spend — red when over, category-coloured when within limits
4. Income categories (e.g. *Income*) show *earned* vs *target* instead of *spent* vs *limit*

### 6 — Create a Goal

1. Go to **Goals** and select the relevant month
2. Choose a goal type:
   - **Net Savings** — save at least $X per month
   - **Spending Limit** — keep a category under $X per month
   - **Income Target** — earn at least $X per month
3. Give it a name, set the target, and click **Add**
4. The goal card shows current progress vs target with a status badge

### 7 — Run Reports

- Go to **Reports** and select any month for context-sensitive reports
- The **Ghost Subscriptions** section runs across all your data and shows charges you may have forgotten about, sorted by how many months they've appeared and their estimated annual cost
- Reports do not require any setup — they populate automatically from your imported transactions

### 8 — Clear Data

On the **Dashboard**, scroll to the *Manage Data* section at the bottom:
- **Clear [month]** — removes all transactions for the selected month only
- **Clear all transactions** — removes everything (confirmation required)

---

## $${\color{#C08A1C}Building \space \color{#C08A1C}from \space \color{#C08A1C}Source}$$

### Prerequisites
- [Node.js v20+](https://nodejs.org)
- [Rust](https://rustup.rs)

```bash
git clone https://gitea.fameli.net/Fameli/Compass.git
cd Compass
npm install
npm run tauri dev       # development mode with hot reload
npm run tauri build     # production build → src-tauri/target/release/bundle/
```

---

## $${\color{#C08A1C}Roadmap}$$

### ✅ Phase 1 — Financial Companion *(complete)*
Statement import · Import history + undo · Auto-categorization · Edit/add/delete transactions · CSV export · Spending trends · Budgets with on-pace projection · Goals · Reports with custom date ranges · Insights · Ghost subscriptions · Running balance · All-accounts overview · Smart categorization rules · In-app auto-updates

### ✅ Phase 2 — AI Insights *(complete)*
- AI Agent for natural-language questions about your data
- Automatic insight generation: budget gaps, unusual spending spikes, savings rate warnings, overspend streaks, ghost subscriptions, low balance / short runway alerts
- Categorization rules engine with priority ordering

### 🔜 Phase 3 — Financial Coaching *(planned)*
Understanding your numbers isn't enough — Compass will help you act on them:
- **Emergency fund awareness** — explain why emergency funds matter, calculate your personal target based on actual expenses, and track progress toward it
- **Spending habit analysis** — answer natural-language questions about your own data (*"Where did most of my money go last quarter?"*, *"Am I spending more on food than last year?"*)
- **Debt & wealth impact** — show how current debt levels affect long-term net worth, model payoff scenarios, and surface the real cost of carrying balances
- **Smart prompts** — proactive nudges when patterns suggest risk (spending creep, missing savings months, unusually high recurring charges)

### 🔭 Phase 4 — Compass Life *(future)*
Expanding beyond finances into a whole-life companion:
- **Habits** — build and track personal routines with streaks and reflection
- **Goals** — long-horizon life goals across any area, not just money
- **Relationships** — notes and intentions around the people that matter
- **Career decisions** — track professional milestones, skills, and decision logs
- **Health** — log physical and mental wellbeing markers over time
- **Personal reflection** — open-ended journaling with pattern recognition across all life areas
- **Long-term planning** — connect daily actions to multi-year life intentions

---

## $${\color{#C08A1C}License}$$

MIT — see [LICENSE.txt](LICENSE.txt)

> *Compass is provided as-is. Financial data shown is only as accurate as the statements you import. Always verify important figures with your bank.*
