<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Compass" />
</p>

# $${\color{#58a6ff}Compass}$$

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?logo=windows&logoColor=white" alt="Windows 10/11" />
  <img src="https://img.shields.io/badge/macOS-beta%20%7C%20unsigned-999999?logo=apple&logoColor=white" alt="macOS beta, unsigned" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%20%7C%20React%20%7C%20Rust%20%7C%20SQLite-informational" alt="Tech stack" />
  <img src="https://img.shields.io/badge/data-local%20only-brightgreen" alt="Local only" />
  <img src="https://img.shields.io/badge/telemetry-none-brightgreen" alt="No telemetry" />
  <img src="https://img.shields.io/badge/account-not%20required-brightgreen" alt="No account" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
</p>

<p align="center"><i>Export a CSV from your bank. Drop it in. See where your money went.<br>No account. No cloud. No subscription. No judgment.</i></p>

---

## 🎉 $${\color{#2ea043}macOS \space is \space HERE!}$$ (Beta)

**Huge one:** Compass now runs on **macOS** — Intel and Apple Silicon, one universal build! 🍎✨

It's brand new and currently **unsigned** (a real Apple Developer ID is on the way), so macOS will throw up a Gatekeeper warning on first launch. Don't worry — it's a two-second fix: right-click the app → **Open** (or run `xattr -cr Compass.app` in Terminal), and you're in. Windows users: nothing changes for you, your builds stay fully signed as always.

Grab it from the [Downloads section below](#installation) or the [website](https://privatecompass.app) — and if you hit anything weird on macOS, [open an issue](../../issues), this is a beta and your feedback shapes how fast it gets rock-solid (and signed!).

---

## $${\color{#2ea043}Try \space Demo \space Mode \space —}$$ No Import Needed

**The fastest way to see what Compass does:**

1. [Download and install Compass](#installation) (< 5 MB installer)
2. Open the app → click **✦ Try Demo Mode** on the dashboard
3. ~50 realistic sample transactions load instantly across 2 months
4. Every feature is fully explorable — no real data, no risk, no commitment

> *"Try Compass safely with demo data. No account. No import. No commitment."*

---

## $${\color{#C08A1C}Why \space Compass \space Exists}$$

Most finance apps ask for your bank login, upload your transactions to their servers, and charge you monthly for the privilege. If you cancel, your data disappears.

**Compass does the opposite.**

Every bank lets you export a CSV of your transactions. Compass reads that file, categorizes your spending, and shows you exactly where your money went — entirely on your own machine. No data ever leaves your device.

- No account to create
- No subscription to pay
- No bank login to give
- No cloud server receiving your transactions
- No telemetry, no analytics, no tracking of any kind

If you've been avoiding finance apps because you don't trust them with your bank credentials, Compass was built for you.

![Profile selection and app overview](https://github.com/user-attachments/assets/b544e724-ce78-40bd-8146-8a24eaa7d1c0)

---

## $${\color{#C08A1C}How \space It \space Compares}$$

| | **Compass** | Monarch / Simplifi | Actual Budget | Firefly III | HomeBank |
|---|:---:|:---:|:---:|:---:|:---:|
| **Local-only data** | ✅ | ❌ Cloud | ✅ | ✅ Self-hosted | ✅ |
| **No account required** | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Free, no subscription** | ✅ | ❌ $10–20/mo | ✅ Open-source | ✅ Open-source | ✅ |
| **No bank login** | ✅ | ❌ Required | ❌ Required | ❌ Required | ✅ |
| **Windows desktop app** | ✅ | ❌ Web only | ✅ | ❌ Web only | ✅ |
| **Modern UI** | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| **Guided 6-step import** | ✅ | N/A | ⚠️ | ⚠️ | ⚠️ |
| **Ghost subscription detection** | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| **Demo mode** | ✅ | ❌ | ❌ | ❌ | ❌ |

**The lane Compass owns:** Simpler than Firefly. Less budgeting-dogmatic than Actual. More modern than HomeBank. More private than Monarch.

---

## $${\color{#C08A1C}How \space It \space Works}$$

```
1. Log into your bank's website → Transactions → Download / Export → CSV
2. Open Compass → Import → drop in the file
3. Compass auto-detects date, description, and amount columns
4. Transactions are imported and categorized automatically
5. Navigate Dashboard, Reports, Budgets, Goals, and Insights
```

On your second import from the same bank, Compass remembers the column layout and skips straight to the preview — one click.

---

## $${\color{#C08A1C}Key \space Features}$$

### 📥 6-Step Import Wizard

![Step-by-step import wizard](https://github.com/user-attachments/assets/48af06bd-c936-412d-aaf0-eb6297f6c9f9)

A guided import flow that handles any bank's CSV format:

Before the column-mapping steps, Compass asks what you're importing: **Bank Statement**, **Credit Card Statement**, or **Investment / Brokerage**. Bank and credit card statements share the wizard below. Investment statements skip straight to a grouped preview — see [Investments](#-investments) below.

Column detection also recognizes distinctive export formats automatically — American Express's activity export (with its `Extended Details` / `Appears On Your Statement As` columns) is auto-matched and sign-corrected without needing to click the preset button. For credit card imports, Compass also checks whether another profile already tracks a credit card (or has a plausibly-named profile) and offers to switch there instead of mixing it into your current profile — the same smart suggestion used for investments below.

| Step | What happens |
|---|---|
| **1 · Find Data** | Auto-detects your header row; adjust with +/− if needed. **Skip to Preview ↗** is always available once you're happy with the columns |
| **2 · Date** | Pick the date column; Compass parses dates live and warns on invalid values |
| **3 · Description** | Pick the merchant/payee column with sample values shown |
| **4 · Amount** | Pick the amount column; supports banks that use separate Debit/Credit columns |
| **5 · Balance** *(optional)* | Import your running balance to unlock sparklines and balance charts. No balance column in your export? Enter your current balance (as of today, after these transactions) and Compass calculates a running balance backward from it — or leave it blank for a relative running total from $0 |
| **6 · Preview** | Row count, detected month, 5-row preview — then import |

Returning users whose bank layout was previously saved skip straight to Preview. Duplicate transactions are silently skipped using a content hash. **Batch import:** drop multiple CSVs at once — Compass queues them. At the Preview step, **"⚡ Import All (N files)"** applies your current column settings to every remaining file and imports them automatically without further wizard interaction.

### 🏷️ Automatic Categorization

150+ built-in rules cover Amazon, Walmart, DoorDash, Instacart, Coinbase, Fidelity, DraftKings, and more. Bank-format noise is stripped automatically. Rules now support optional **amount conditions** (min/max dollar value) so you can create precise rules like "ZELLE over $1,000 → Rent". Re-categorize any transaction with one click, and optionally save that correction as a new rule.

The **⚙ Rules** modal has a two-tier editor: a simple "contains" field for everyday use, and an expandable Advanced section with regex support and a cheat-sheet for power users. All your rules can be edited inline.

**Transfers** are reserved for same-institution internal moves (checking ↔ savings). Zelle, Venmo, and Cash App are intentionally left uncategorized so you can create rules that match your actual usage. Credit card payment descriptions ("___ PAYMENT - THANK YOU", used by Amex, Chase, Discover, and others) are automatically filed under Transfers too, so paying off a card balance never inflates your income totals.

### 📅 Dashboard & Trends

Your home screen for any month: income, expenses, and net savings as summary cards, a top categories chart, and the 10 most recent transactions. Navigate freely between months. The **Trends** page shows 3, 6, or 12-month income vs. expenses and per-category spending breakdowns, with a **Profile / Global scope toggle** to aggregate across all profiles. Three all-time KPI tiles (Income, Expenses, Net) are always visible regardless of the selected range. A **Cumulative Net** line chart shows the running total of savings month-by-month across all imported history.

### 📋 Reports

Five reports that run automatically — no setup required:

| Report | What it shows |
|---|---|
| **Spending by Category** | This period vs last period, with % change, color-coded |
| **Month over Month** | Income, expenses, and net across your selected date range |
| **Top Expenses** | Ranked list of the biggest individual transactions |
| **Most Recurring Payees** | Frequency, average cost, and total paid to each merchant |
| **👻 Ghost Subscriptions** | Same description + same amount appearing in 2+ months — your forgotten recurring charges |

Reports support **month navigation** or a **custom date range** with presets: This quarter, Last quarter, Year to date, Last 12 months.

### 💰 Budgets

Set soft spending limits per category — monthly or weekly. Each budget shows a live progress bar, amount spent vs. limit, and an **On pace for $X** projection so you can see a potential overspend before the month ends. No enforcement, no penalties — just awareness.

**Global vs. Profile budgets:** A **Profile / Global toggle** at the top-right of the Budgets page lets you switch between views. Profile budgets track spending for the active profile only. Global budgets aggregate transactions across all profiles and are visible to every profile — useful for shared household expenses. Any budget can be flipped between the two scopes after creation with the **↑ Global / ↓ Profile** button on its card. When switching to Global view, Compass walks you through unlocking any PIN-protected profiles so their data is included in the totals.

> **Transfers** (same-institution internal moves) are excluded from all budget totals regardless of scope.

### 🎯 Goals

| Goal Type | Tracks |
|---|---|
| **Net Savings** | Monthly net (income − expenses) at or above your target |
| **Spending Limit** | Category spending at or below your target |
| **Income Target** | Income at or above your target |

Each goal shows a progress bar, current vs. target amount, and an "On track ✓" or "Needs attention ⚠" status badge.

### 💡 Insights

![Insights page](https://github.com/user-attachments/assets/962bdee8-a336-43b7-8dca-78c0755576b3)

Automatic analysis surfaced from your data — no configuration required. The page opens with your most vital insights front-and-center.

**Financial Health Score** — A 0–100 score computed from four signals: savings rate (40 pts), budget adherence (30 pts), account balance runway (20 pts), and income stability (10 pts). The score hero card and header pill reflect the **currently active view** (Global = all-profiles aggregated, Profile = active profile only). On first visit each session a tabbed modal opens — the **🌐 Global** tab (golden) and **👤 Profile** tab (blue) let you compare both scores side-by-side before dismissing. Grades: A Excellent · B Good · C Building · D Developing.

**Spotlight Cards** — Up to two of your most actionable insights are promoted to full-width featured cards with inline data visualizations:
- **StreakTrack** — dot row showing consecutive under-budget months
- **RateGauge** — gradient track with your current savings rate vs. the 20% target
- **PaceMeter** — bar showing this month’s spend pace vs. your normal
- **BeforeAfterBars** — side-by-side bar comparison for category improvements
- **RunwaySegments** — segmented track showing months of expenses covered by your balance

Each spotlight card includes a forward-looking **“↗ potential” callout** computed from your actual data — e.g. “Cut expenses by 12% → savings rate reaches 20%”.

**Grouped Accordions (Wins first)** — Insights are grouped into three collapsible sections ordered by psychology, not severity: **Wins** (emerald, expanded by default when you have wins) → **Observations** → **Action Items** (amber, constructive tone). Adaptive expansion ensures you never open the page to a wall of warnings.

**Type-specific icons** — Each insight type has a distinct icon so you can scan at a glance: `Target` for budgets, `%` for rate insights, trend arrows for directional changes, `RefreshCw` for subscriptions, `Calendar` for timing alerts, `Shield` for account safety.

**20+ insight types** including: budget pace, unusual spend spikes, savings rate, overspend streaks, under-budget streaks, ghost subscriptions, redundant spending, top merchants, food delivery %, subscription inventory, paycheck prediction, overdraft alerts, category creep, year-end savings projection, most-improved category, weekend spending pattern, spending velocity, emergency fund runway, bill due soon, and expense ratio drift.

### 🔍 Transactions

Full searchable, filterable transaction list. Filter by month or view all-time history (no row cap). Re-categorize in one click, and view the running account balance alongside each transaction.

**Sortable column headers** — Click Date, Description, Category, Amount, or Balance to sort. Click again to reverse. An arrow shows the active column and direction.

**Net summary** — Three tiles above the table show **Income**, **Expenses**, and **Net** for the current filtered view.

**Transfers excluded** — Selecting the Transfers category shows an inline notice that transfers don't count toward income or expense totals anywhere in the app.

**Filter row 1 — date & search:**
- Filter by month or toggle to **All time**
- Free-text description search (case-insensitive contains match)

**Filter row 2 — advanced filters:**
- **Category** — narrow to any specific category, or Uncategorized
- **All / Income / Expenses** toggle — quickly isolate credits or debits
- **Amount range** — Min $ and Max $ to find transactions by dollar value
- **× Clear filters** resets all in one click

**Other actions:**
- **Edit** any transaction’s date, description, amount, category, or notes
- **Delete** transactions you don’t need
- **＋ Add** manual transactions for cash, Venmo, or anything not in a bank export
- **↓ Export** opens an OS save dialog — choose filename and location; exports exactly the current filtered view as CSV (respects active sort)
- **✦ Auto-Categorize** applies your rules to all transactions, then system rules fill remaining uncategorized ones
- **Drag a CSV or XLSX** onto the Transactions page to jump straight to the import wizard

### 💼 All Accounts Overview

Aggregates all profiles in one place. Each account card shows current balance, a 60-day sparkline, and this month's income/expenses/net. Click any card to jump to that account's dashboard. A **+ Investments** toggle folds each profile's latest portfolio value into a combined net worth figure, or hides it to show liquid cash only.

### 📈 Investments

Import a brokerage "Portfolio Positions" export (Wells Fargo Advisors format — `.csv`, `.xlsx`, or `.xls`) and Compass will:

- Detect every section of the statement (Stocks, ETFs, Mutual Funds, Cash, Other) along with each security's individual tax lots, scanning every tab in the workbook to find the one that actually contains the positions table
- Show a grouped preview with per-section totals before anything is imported, with a **Fix columns** control per section if any field was detected wrong — each option shows how many rows actually have data in it, so you're never guessing
- Check whether another profile already tracks investments, or has a plausibly-named profile, before offering to create a dedicated **Investments** profile — so brokerage holdings never mix into everyday spending totals
- Track holdings as dated snapshots, so re-importing a later statement builds a value-over-time history instead of overwriting it

The Investments page shows KPI tiles (portfolio value, cost basis, unrealized gain/loss, estimated annual dividend income), holdings grouped by symbol with expandable tax-lot detail, and a portfolio value chart once two or more statements have been imported.

> Dividend and "Est. Annual Income" figures reflect the brokerage's projected estimates as of the statement date — not a history of dividends actually paid.

### 🔄 In-App Auto-Updates

Check for updates from the sidebar. Updates are cryptographically signed, verified before applying, and never run automatically without your confirmation.

---

## $${\color{#C08A1C}Security \space and \space Privacy}$$

This section answers every question a new user should ask before importing financial data into any app.

### Where is my data stored?

Compass stores two files in your OS user profile - the exact folder depends on platform, but the layout is identical:

| File | What it is |
|---|---|
| `%APPDATA%\com.compass.app\com.compass.app.db` (Windows) or `~/Library/Application Support/com.compass.app/com.compass.app.db` (macOS) | Encrypted SQLite database (all your transactions, budgets, goals, and categories) |
| `%APPDATA%\com.compass.app\compass.key` (Windows) or `~/Library/Application Support/com.compass.app/compass.key` (macOS) | Backup copy of the database encryption key |

Both files are accessible only to your OS user account.

### Is the database encrypted?

Yes. The database is encrypted at rest using **SQLCipher (AES-256)**. The encryption key is a 32-byte random value generated on first launch and stored in your OS's native secure credential store - **Windows Credential Manager** (DPAPI-backed) on Windows, or **Keychain** on macOS - which ties it to your OS user account. The key is never visible to you or to the app's UI — it is loaded by the Rust backend at startup (via the cross-platform `keyring` crate, which picks the right backend automatically) and used only to open the database connection.

A copy of the key is also written to `compass.key` in the app's data folder as a fallback in case the OS credential store loses the entry (e.g. after a profile migration or credential reset). If you delete this file and the credential store entry is also gone, the existing database cannot be reopened — treat it like any other encryption key backup.

### What data leaves my device?

**Nothing financial.** The only network activity Compass performs is:

- **Update check:** A request to the GitHub Releases API to compare version numbers. No personal or financial data is included.
- **Auto-update download:** The installer binary is downloaded from GitHub Releases if you choose to update.

There is no telemetry, no crash reporting, no analytics, no usage tracking of any kind. The app runs fully offline after installation.

### Does Compass collect telemetry?

No. There is no telemetry SDK, no analytics library, no error reporting service. Compass has zero background network calls except the optional update check described above.

### How do I back up my data?

To make a complete portable backup, copy **both** files from the app's data folder (`%APPDATA%\com.compass.app\` on Windows, `~/Library/Application Support/com.compass.app/` on macOS):

- `com.compass.app.db` — the encrypted database
- `compass.key` — the encryption key needed to open it

Keep them together. Restoring only the `.db` file without the matching key file on a machine where the OS credential store no longer has the entry will result in an unreadable database. You can also export all transactions as CSV from the Transactions page (toggle **All time** → **↓ Export CSV**) for a plaintext backup that works anywhere.

### What happens when I uninstall?

The installer removes the application files. Your data file at `%APPDATA%\com.compass.app\` is **not** automatically deleted by the uninstaller — your history is preserved unless you manually delete that folder.

### How do I export all my data?

From the **Transactions** page, toggle **All time** and click **↓ Export CSV**. This exports every transaction across all months in the current profile. Run this for each profile if you have multiple.

### Can the developer see my data?

No. There is no server, no sync, no account, and no mechanism by which anyone other than you can access data stored on your own machine. The developer has no visibility into your financial data at any time.

---

## $${\color{#C08A1C}Installation}$$

### Requirements
- Windows 10 or Windows 11 (64-bit), or macOS 10.15+ (Intel or Apple Silicon) — **macOS builds are beta and currently unsigned** (see note below)
- No additional software required — WebView2 is installed automatically if missing on Windows

### Download
Download the latest installer from the [Releases page](../../releases):

| File | Type | Use when |
|---|---|---|
| `Compass_x.x.x_x64-setup.exe` | NSIS EXE | Standard interactive installer with directory picker |
| `Compass_x.x.x_x64_en-US.msi` | Windows Installer | Enterprise/IT deployment, Group Policy |
| `Compass_x.x.x_universal.dmg` | macOS disk image (beta) | Intel or Apple Silicon Mac |

> **macOS is unsigned for now** — Gatekeeper will say the app "can't be opened" or "is damaged". Right-click the app → **Open**, or run `xattr -cr Compass.app` in Terminal, to launch it anyway. This goes away once Compass is signed with an Apple Developer ID (in progress).

### Silent / Automated Installation
```
# NSIS EXE — completely silent
Compass_0.1.0_x64-setup.exe /S

# MSI — silent, no reboot prompt
msiexec /i Compass_0.1.0_x64_en-US.msi /quiet /norestart
```

---

## $${\color{#C08A1C}How \space To \space Use}$$

### 1 — Try Demo Mode first

Click **✦ Try Demo Mode** on the empty dashboard for an instant, no-risk tour of every feature. Clear it anytime with one click from the Dashboard's *Manage Data* section.

### 2 — Import your first statement

1. Log into your bank's website and export a CSV (usually under *Transactions → Download / Export*)
2. Open Compass → **Import** → drag and drop the `.csv` file (or browse for it)
3. The 6-step wizard walks you through column mapping with live previews
4. Click **Import** — categories are applied automatically

> On your second import from the same bank, the column layout is remembered and pre-filled.

### 3 — Review and correct categories

Go to **Transactions** → click any colored category badge → select the correct category. The change saves instantly. Compass will ask if you want to save a rule so future transactions from the same payee are auto-categorized.

### 4 — Check your Dashboard

- Shows income, expenses, and net savings for the selected month
- Navigate freely between months with `‹` `›` arrows
- Top categories chart and recent transactions update live

### 5 — Explore Reports and Insights

**Reports** runs five automatic analyses on your imported data — no setup. **Insights** surfaces patterns like budget pace warnings, detected ghost subscriptions, and top merchant spend. Neither page requires any configuration.

### 6 — Set Budgets and Goals

- **Budgets:** Go to Budgets → pick a category → set a monthly limit. The progress bar fills as you spend, with an on-pace projection.
- **Goals:** Go to Goals → pick a goal type (net savings, spending limit, or income target) → set a target. Status updates automatically each month.

### 7 — Clear Data

On the **Dashboard**, scroll to the *Manage Data* section:
- **Clear [month]** — removes all transactions for the selected month only
- **Clear all transactions** — removes everything (confirmation required)

---

## $${\color{#C08A1C}Known \space Limitations}$$

Being transparent about what Compass does not do helps you decide if it's the right tool.

| Limitation | Notes |
|---|---|
| **macOS is beta/unsigned** | Windows builds are signed; macOS builds aren't code-signed or notarized yet — right-click → Open (or `xattr -cr`) on first launch. Linux isn't supported yet. |
| **CSV import only** | No direct bank connections, no OFX/QIF/PDF support |
| **No mobile app** | Desktop only |
| **Single currency** | Multi-currency not supported |
| **No shared accounts** | No collaborative or family access features |
| **No investment tracking** | Stocks, 401k, brokerage accounts not supported |
| **Manual cash entries** | Cash transactions must be added individually |
| **No scheduled transactions** | Recurring bills are tracked (ghost subscriptions), not scheduled |

If a limitation is blocking you, [open an issue](../../issues) — user feedback directly shapes the roadmap.

---

## $${\color{#C08A1C}Building \space from \space Source}$$

### Prerequisites
- [Node.js v20+](https://nodejs.org)
- [Rust](https://rustup.rs)

```bash
git clone https://github.com/tylahfam97/Compass.git
cd Compass
npm install
npm run tauri dev       # development mode with hot reload
npm run tauri build     # production build → src-tauri/target/release/bundle/
```

---

## $${\color{#C08A1C}Roadmap}$$

Compass is focused on one thing: making it easy to understand your personal finances privately, locally, and without friction.

### ✅ Phase 1 — Core *(complete)*
Statement import · Import history + undo · Auto-categorization · Edit/add/delete transactions · CSV export · Spending trends · Budgets with on-pace projection · Goals · Reports with custom date ranges · Insights · Ghost subscriptions · Running balance · All-accounts overview · Smart categorization rules · In-app auto-updates · Demo mode · Batch import · Collapsible sidebar · Profile switcher on launch · Investment portfolio tracking with net worth toggle

### ✅ Phase 2 — AI Insights *(complete)*
AI agent for natural-language questions about your data · Automatic insight generation (budget gaps, unusual spending, savings rate, overspend streaks, low balance alerts) · Categorization rules engine with priority ordering

### 🔜 Phase 3 — Deeper Financial Clarity *(planned)*
The goal: help you act on your data, not just see it.

- **Bank-specific import presets** — one-click setup for Chase, Capital One, Wells Fargo, Bank of America, Navy Federal, Discover, Amex, Venmo, Cash App, PayPal, and more
- **Emergency fund tracker** — calculate your personal target from actual expenses, track progress toward it
- **Spending habit analysis** — natural-language answers to questions like *"Where did most of my money go last quarter?"*
- **Debt impact modeling** — show how current debt affects long-term net worth, model payoff scenarios
- **Smart nudges** — proactive alerts when patterns suggest risk (spending creep, missing savings months, unusually high recurring charges)
- **Wider bank format coverage** — edge case handling, better error messages, and import reliability improvements

---

## $${\color{#C08A1C}Reporting \space Import \space Issues}$$

If Compass can't parse your bank's CSV correctly, [open an issue](../../issues) and include:

- The name of your bank
- Which step the wizard fails at (or which columns it mis-detects)
- A small sample of the CSV with real data removed (the header row + 2–3 rows with fake values)

Import reliability is a top priority. Every format fixed helps everyone using the same bank.

---

## $${\color{#C08A1C}License}$$

MIT — see [LICENSE.txt](LICENSE.txt)

> *Compass is provided as-is. Financial data shown is only as accurate as the statements you import. Always verify important figures with your bank.*
