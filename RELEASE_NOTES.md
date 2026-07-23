# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.8.7 — 401(k) Imports & Smarter Investment Health 📈

Retirement accounts join the party: Compass can now read Principal Financial Group 401(k) quarterly statements directly, and Investment Health no longer loses track of them (or any other holding type without a traditional cost basis).

### New: Principal 401(k) Statement Import
The Import wizard now recognizes Principal Financial Group quarterly statement PDFs and pulls out each fund's balance automatically - no more manual data entry for retirement accounts. Holdings land on the Investments page grouped by asset class alongside your other brokerage accounts, contributing to net worth and portfolio totals like any other investment.

### Fixed: Investment Health Ignored Accounts Without a Cost Basis
Investment Health previously only counted holdings that reported a traditional purchase cost basis, silently leaving out account types that don't - like a 401(k), which only ever reports a period's ending balance. It now falls back to comparing a holding's earliest tracked balance against its latest once enough statement history exists, so every investment type contributes to the score, today and as new formats are added down the line. Principal statements specifically get an even more accurate figure, using the statement's own cumulative "total contributions since joining" as the true cost basis instead.