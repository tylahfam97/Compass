# Created by @tylahfam97 

Hello!

## Compass 0.5.0 - Smart Categorization & Import Overhaul

### Bug Fixes
- **Transaction list no longer scrolls to the top when you change a category inline.** Category changes are now applied in-place — your scroll position is preserved exactly where you left off.

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

### Import Wizard

#### Skip to Preview — always available
The "Skip to Preview ↗" button is now shown at **every wizard step**, not just when a previously saved column layout is recognized. Configure step 1 and jump straight to preview any time.

#### Batch auto-import
When you drop multiple CSV files at once, the Preview step now shows an **"⚡ Import All (N files)"** button. Clicking it imports the current file and automatically processes all remaining queued files using the same column settings — no wizard interaction required for each one. The done screen shows a running count as each file completes.
