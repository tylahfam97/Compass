# Created by @tylahfam97 

Hello!

## Compass 0.4.30 - Adoption, Trust & Security

### Bank-Specific Import Presets
- New **Select your bank** panel on the Import page with 11 pre-configured presets: Chase (Checking / Savings), Chase (Credit Card), Capital One, Wells Fargo, Bank of America, Navy Federal, Discover, American Express, Venmo, Cash App, and PayPal
- Selecting a bank pre-fills column mapping for the wizard so the correct date, description, and amount columns are detected on the first import
- Each preset shows a contextual note explaining any quirks (e.g. split Debit/Credit columns, preamble summary rows)
- Preset is applied only when no saved column layout already exists for that bank's header signature — returning users are unaffected

### Sign Inversion for Expense-Positive Banks
- New **"Are expenses shown as positive numbers?"** toggle in Step 4 of the import wizard
- Banks that export purchases as positive values (Discover, Amex, Capital One) are automatically pre-configured with sign inversion enabled via their preset
- The live amount preview in Step 4 reflects the inversion in real time before import — red for expenses, green for income
- Manual toggle available for any bank not in the preset list

### SQL Statement Allowlisting (Security)
- The Rust `db_execute` and `db_select` commands now validate the SQL statement type before execution
- `db_execute` permits only: `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, and `PRAGMA user_version =`
- `db_select` permits only: `SELECT`, `WITH` (CTEs), `PRAGMA table_info(`, and `PRAGMA user_version`
- Any other statement type (e.g. `DROP`, `ATTACH DATABASE`, `PRAGMA key`) is rejected at the Rust layer before SQLite processes it — defense-in-depth against JS injection via the WebView

### README Overhaul
- Rewritten hero section with a sharper positioning statement and six trust/credibility badges (platform, tech stack, local-only, no telemetry, no account required, MIT)
- **Try Demo Mode** is now the first content block — front and center before any feature description
- New **"Why Compass Exists"** section replacing the generic intro with the emotional hook explaining the alternative to cloud finance apps
- New **comparison table** vs. Monarch/Simplifi, Actual Budget, Firefly III, and HomeBank
- New **Security & Privacy FAQ** with 8 explicit Q&A entries: database location, encryption status, network activity, telemetry policy, backup instructions, uninstall behavior, data export, and developer access
- New **Known Limitations** table: Windows-only, CSV-only, no mobile, single currency, no shared accounts, no investment tracking
- New **"Reporting Import Issues"** section with instructions for filing a bug report
- Roadmap focused on financial clarity — Phase 4 "Compass Life" section removed; Phase 3 updated to lead with bank presets and import reliability
