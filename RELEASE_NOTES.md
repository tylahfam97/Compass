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

## Compass 0.4.21 - Adoption & Polish

### Demo Mode
- New **Try Demo Mode** button on the empty dashboard loads ~50 realistic sample transactions (2 months of income, rent, groceries, subscriptions, restaurants, gas, insurance, and more) so you can explore every feature without importing your own data

### Batch Import
- Drop or select **multiple CSV files** at once — Compass queues them and processes each one through the wizard in sequence
- After each file completes, an **"Import Next File (N remaining)"** button advances to the next without returning to the home screen

### Profile Selection on Launch
- On every app launch, Compass now shows a profile picker so you choose who is tracking
- Single profile with no PIN auto-selects silently (no extra step)
- Single profile with PIN shows the PIN entry screen immediately
- Multiple profiles always show the full picker

### Sidebar Improvements
- **Collapsible sidebar** — click the chevron to collapse to icon-only mode; preference is remembered across sessions
- Nav icons added for all pages (fully navigable even when collapsed)
- **Report an issue** link at the bottom opens GitHub Issues directly
- **Version number** shown at the bottom of the sidebar

### CI / Build Pipeline
- Fixed self-hosted runner failing on `dev` branch due to stale local git refs left by the old `dev/branch_management` branch
- Prune step added before checkout to clean stale remote-tracking refs and branch namespace directories automatically

### Bug Fixes
- Multiple CSV files selected via the file dialog now correctly processes all queued files (second+ files were being lost due to a state reset ordering issue)
- Hardcoded private IP removed from Discord notification script — now uses `APPRISE_URL` GitHub secret
- `index.html` title updated from "Tauri + React + Typescript" to "Compass"

### Step-by-Step Import Wizard
- The import flow is now a guided **6-step wizard** replacing the old all-in-one mapping screen
- **Step 1 — Find Data**: Compass auto-detects where your column headers are and shows them as centered pills. Use − / + to shift rows if the detection is off
- **Step 2 — Date**: Pick the date column and see raw values parsed into readable dates in real time. Warns if a value can't be read as a date
- **Step 3 — Description**: Pick the merchant/payee column with live sample values
- **Step 4 — Amount**: Pick the amount column with live red/green currency output. Includes a toggle for banks that use separate Debit/Credit label columns instead of signed amounts
- **Step 5 — Balance** *(optional)*: Opt in to import your running account balance for balance charts and low-balance alerts
- **Step 6 — Preview**: Summary card (row count, detected month, columns), 5-row preview table, and the final Import button
- Returning users whose bank layout was previously saved can skip straight to Preview from Step 1
- Subtle slide animations on step transitions and a polished success animation on completion

### Bug Fixes
- **Dates displaying one day behind** — Fixed a timezone issue where ISO date strings were parsed as UTC midnight and then formatted in local time, shifting them back by one day in all US timezones. Affects the wizard, transaction list, reports, and dashboard
- **Import history persisting after clearing transactions** — Clearing all transactions (Dashboard) or deleting a profile now also removes the associated import session history. Clearing a single month removes only sessions that have no remaining transactions

