Hello, @here !

## Compass 0.3.78

- **Fixed: Profiles & transactions lost after relaunch or update** — The encryption key is now backed up to a local file (`compass.key`) alongside the database. If Windows Credential Manager loses the keyring entry (which could happen after an app update, Windows profile sync, or a Credential Manager reset), the key is restored from the file instead of generating a new one. This prevents the database from being renamed to `.db.lost` and your data from disappearing.

---

## Compass 0.3.7

### New Features
- **Running Balance**: Import your bank's Running Balance column — shown in transactions, dashboard balance card with sparkline, and a Balance Over Time chart in Reports
- **All Accounts Overview**: New "Overview" page shows all profiles side-by-side with current balance, this-month income/expenses, and a mini balance sparkline per account. Clicking a card switches to that profile
- **Custom Categories**: Add, edit, and delete your own categories directly from the Transactions page (system categories remain protected)

### Transactions
- Added **All time** toggle to view every transaction regardless of month
- Balance column now shown in the transaction table (populated when Running Balance was imported)
- Transactions table now scrolls correctly with all rows visible
- 500-row cap with notice to prevent browser freeze on large datasets

### Imports
- Running Balance column auto-detected and mapped as an optional field
- Preview table shows the balance column when mapped

### UI
- Wider default window (1600×1000) for a more spacious layout
- All pages now center within the wider window
- Subtle gold border on the sidebar divider
- Very light wavy background texture for a more polished feel

### Dashboard
- Account balance card with mini sparkline for the selected month
- AI Agent now generates low-balance and short-runway insights when balance data is present

### Bug Fixes
- Fixed DB migration error ("table column_profiles has no column named balance_col")
- Improved release pipeline reliability and asset upload stability
