# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.7.2 — Multi-Account Imports & Account Management

### New: "Which Account Is This?" Import Step
The import wizard now asks which account a statement belongs to before mapping any columns. Compass suggests a match based on the detected bank/institution against your existing accounts, or lets you name a brand-new one — so two different credit cards (or checking accounts) are now tracked as two genuinely separate accounts instead of silently sharing one, which previously caused a second card's balance to overwrite the first's. The wizard's numbered step bubbles are now clickable (back to any previously-visited step), and every step has a Back button in addition to Cancel.

### New: Manage Accounts Panel
A collapsible "Manage Accounts" panel is now available on both the Import and Overview pages, listing every account (checking, credit, investment) identified from your transactions with its balance and a rename option. It also detects duplicate accounts (same type and name) and offers a one-click merge that reassigns their transactions/holdings onto a single account and recalculates its balance. This panel is separate from Profiles — it's specifically for the individual accounts found within a profile's data.

### New: Credit Cards Shown Separately from Checking
The balance charts on the Dashboard and Trends pages no longer combine every checking and credit account into one blended line. Checking accounts stay combined into a single line (there's usually just one), while credit cards are now drawn as their own distinct, separately colored lines — so multiple cards are never silently summed together on the chart. Both are still clickable for a full per-account balance breakdown on any date.

### New: Clearer Credit Card Sign-Flip Guidance
The import wizard's sign-flip step now gives credit-card-specific guidance, explicitly distinguishing that **purchases** (charges) need to end up negative and **payments toward the card** need to end up positive, with a pointer to check both kinds of rows in the preview above before deciding.

### New: Travel Category
A system "Travel" category has been added, with built-in auto-categorization rules for major airlines, hotel chains, Airbnb, booking sites, and car rental companies.

### Fixed: Running Balance Corrupted After Clearing or Reimporting
Clearing an account's transactions (from the Dashboard's "Clear month/all" or undoing an import) left a stale balance behind that could resurface and produce a wildly incorrect balance the next time you reimported. Balances are now properly recalculated — and reset entirely when an account has no transactions left — after every clear, undo, edit, or delete.

### Fixed: Bulk/Batch Imports Creating a Duplicate Account per File
Importing multiple statements in one batch (e.g. "Auto-Import All") for a brand-new account was creating a separate duplicate account for every file instead of reusing the one just created, splitting one card's balance across several rows and producing wrong totals when they were summed together. The wizard now locks onto the newly created account after the first file so the rest of the batch shares it.

### Fixed: Transaction Edits Not Reflected Elsewhere
Editing, adding, or deleting a transaction now recalculates that account's running balance immediately, so Overview, Dashboard, Trends, and Insights all show correct numbers as soon as you switch to them — no more stale balances left over from before an edit.
