## Compass 0.3.75

- Fixed auto-updater: update packages now use STORE compression, resolving the "Compression method not supported" error on install
- Discord release notifications now include @here mention and full release notes

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
