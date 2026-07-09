# Created by @tylahfam97 

Hello!

## Compass 0.4.10 - Import Wizard

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

