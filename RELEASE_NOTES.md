# Created by @tylahfam97 

# Hello! Another release just dropped 🧭

## Compass 0.5.0 - Smart Categorization & Import Overhaul

### Bug Fixes
- **Transaction list no longer scrolls to the top when you change a category inline.** Category changes are now applied in-place — your scroll position is preserved exactly where you left off.
- **Export button now opens an OS save-file dialog** so you can choose the save location and filename instead of auto-saving.
- **Import wizard loading animation** appears immediately when you click Import, preventing the app from looking frozen on large files.
- **Month picker on the Transactions tab** now opens the calendar when you click anywhere in the date box, not just the small calendar icon.

### New Categories
Six new system categories are available immediately after upgrading:

- **Debt** — student loans, auto loans, NAVIENT, NELNET, MOHELA, Sallie Mae, and other debt payments
- **Business Expenses** — work-related spending separate from personal categories
- **Gambling** — DraftKings, FanDuel, BetMGM, Caesars, PointsBet, BetRivers, and similar
- **Crypto** — Coinbase, Binance, Kraken, Gemini, Crypto.com, and other crypto platforms
- **Investments** — Fidelity, Vanguard, Schwab, TD Ameritrade, E*TRADE, Merrill Lynch, Morgan Stanley, Robinhood, SoFi Invest
- **Emergency** — emergency fund spending

**Automatic upgrade:** if you had already created a category with any of these names (in any capitalization — "Debt", "DEBT", "debt"), your transactions, budgets, goals, and rules are automatically migrated to the new system category and the duplicate is removed. Nothing is lost.

### Categorization Overhaul

#### Zelle / Venmo / Cash App — no longer auto-tagged as Transfers
The "Transfers" category is now reserved exclusively for same-institution internal account moves (e.g. "ONLINE BANKING TRANSFER", "ACH TRANSFER"). Zelle, Venmo, and Cash App transactions are no longer automatically tagged as Transfers — they land on Uncategorized so you can create purpose-specific rules that reflect how you actually use them (rent, utilities, income, etc.).

#### Amount-based rule conditions
Every rule now supports optional **Min Amount** and **Max Amount** conditions (absolute dollar value). A rule only matches if the transaction's dollar amount falls within the range you specify. Leave both blank to match any amount — existing rules are unchanged. Example: a rule matching "ZELLE" with a Min of $1,000 would only catch large payments, leaving smaller ones to fall through to other rules.

#### Rule editor redesigned
The ⚙ Rules modal has a new two-tier editing experience:
- **Simple mode (default):** just type what the description should contain — no technical knowledge needed
- **Advanced section (expandable per rule):** access the full match type (Contains / Starts with / Regex) and an inline regex reference sheet for power users
- **Inline editing:** click the ✏ icon on any of your rules to edit it in-place — no need to delete and recreate

System rules remain read-only (shown with a badge) but are visible for reference.

#### Auto-Categorize now applies your rules as overrides
Clicking **✦ Auto-Categorize** now applies your custom rules to **all** transactions — including ones already categorized by a system rule. User rules default to priority 250 (above all system rules at 200 or below), so a user rule will always win. System rules then fill the gaps for any transaction with no matching user rule. This means creating a new rule and clicking Auto-Categorize will correctly re-categorize transactions that were previously tagged by an old system rule.

### Import Wizard

#### Skip to Preview — always available
The "Skip to Preview ↗" button is now shown at **every wizard step**, not just when a previously saved column layout is recognized. Configure step 1 and jump straight to preview any time.

#### Batch auto-import with progress bar
When you drop multiple CSV files at once, the Preview step now shows an **"⚡ Import All (N files)"** button. Clicking it imports the current file and automatically processes all remaining queued files using the same column settings — no wizard interaction required for each one. A **progress bar** shows exactly which file is being processed (e.g. “Importing file 3 of 7…”).

#### CSV drag-and-drop on the Transactions tab
You can now drag one or more CSV files directly onto the Transactions page. A full-page drop overlay appears and releasing the files navigates straight to the Import wizard with those files queued and ready to go.

### Transaction Filters
The Transactions page now has a second filter row with powerful new options:
- **Category filter** — narrow to any specific category, or Uncategorized
- **Income / Expenses / All toggle** — quickly view only credits or only debits
- **Amount range** — Min $ and Max $ inputs to find transactions by dollar value (e.g. only transactions between $500 and $2,000)
- **× Clear filters** — resets all row-2 filters in one click when any are active

The Export button respects all active filters — what you see is what gets exported.
