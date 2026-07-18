# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.8.1 — Loan Uploader Improvements

A follow-up to last release's loan tracking, focused entirely on making statement uploads faster and less error-prone.

### New: Pick an Existing Loan Instead of Retyping Its Name
Adding a statement no longer requires typing a loan's name exactly right - the uploader now offers a New Loan / Existing Loan toggle, just like the transaction import wizard, so you can pick from a dropdown of your current loans instead of risking a typo that silently created a duplicate account.

### New: Bulk Statement Upload
Select or drop several statement files at once for the same loan and review just the first one - Compass reuses that account, lender, interest rate, and minimum payment for every other file (same idea as picking a bank/column mapping once in the transaction wizard), reads each file's own balance and date, and imports the whole batch together in one go.

### New: Lender Autofill
The Lender/Institution field now gets a first guess pulled straight from the statement (and, as a fallback, the filename) - still fully editable, just one less field to fill in by hand.

### Fixed: Loan Statements Now Accept CSV/XLSX, Not Just PDF
The loan uploader was the only import in Compass still limited to PDF-only - it now accepts CSV and XLSX exports too, matching every other import type.

### New: PDF Support for Investment/Brokerage Imports
Portfolio positions statements can now be imported straight from a PDF, same as bank, credit card, and loan statements - text-extraction heuristics reconstruct the holdings table, and the existing review step (with "Fix columns" if anything looks misaligned) still gets a chance to catch anything before it's saved. A CSV/XLSX export from your brokerage remains the more reliable option when available.