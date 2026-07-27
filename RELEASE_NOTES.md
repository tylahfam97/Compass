# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.9.2 — Balance & Net Worth Accuracy Fixes 🎯

A correctness-focused release: several places that summed account balances or detected duplicate
imports were quietly wrong for anyone with more than one account of a type - this cleans all of
that up.

### Fixed: Running Balances Could Get Silently Overwritten
Manually adding, editing, or deleting a transaction (or undoing an import) could discard a bank
statement's real imported running-balance history in favor of a $0-based recalculation, wiping
out perfectly good balances across an entire account. Balances now anchor to the latest known
real balance instead of assuming a $0 starting point.

### Fixed: "Already Imported" Errors After Deleting an Account
Duplicate-import detection was scoped globally instead of per-account, so re-importing a
statement into a new or different account after deleting the original could incorrectly report
"already imported." Detection is now scoped to the account, and merging duplicate accounts
handles overlapping history safely.

### Fixed: Net Worth & Balance Charts
The Trends and Reports balance charts didn't respect accounts hidden from the dashboard, and
combined net worth in multi-profile ("Global") view could undercount investments for any profile
whose latest snapshot was older than another's.

### Fixed: The "Buffer" Goal Only Counted One Bank Account
The Balance Floor ("buffer") goal now sums every checking account's latest balance instead of
whichever account happened to update most recently.

### New: Overview Profile Cards Show Liquid Cash, Not a Blended Net Worth
Each profile card on the Overview page now shows "Liquid" (bank accounts only) with a sparkline
per individual bank account, instead of a blended checking+credit+investment figure that could
misrepresent net worth.

### New: Debt Paydown Goal
Track paying down a specific credit card or loan - or all of them combined - to at or below a
target amount, with $0 as a full-payoff target.

### New: Manually Adding a Transaction Now Requires an Account
Previously, manually-added transactions silently posted to an arbitrary account. Adding one now
requires picking which account it belongs to.