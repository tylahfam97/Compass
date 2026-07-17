# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.7.4 — Getting Started Tour & Demo Mode

### New: "Getting Started" Tour
A guided, click-through spotlight tour is now available for anyone new to Compass - it highlights real parts of the interface (Profiles vs. Accounts, PIN privacy, importing statements, Insights, Manage Accounts, Demo Mode, and dark mode) with a short explanation for each. It's checklist-based rather than a strict Next/Back wizard, so every step can be opened directly, in any order, from a small floating "Getting Started" widget. Progress is remembered between launches, and it can be replayed anytime via "Replay tour" at the bottom of the sidebar, or dismissed for good with "Don't show again."

### New: Demo Mode
From an empty Dashboard, "✦ Try Demo Mode" now seeds two realistic demo accounts (checking + credit card) with about three months of varied sample transactions - paychecks, rent, subscriptions, groceries, restaurants, gas, shopping, and credit card payments - so the whole app can be explored risk-free before importing any real data. Clear it anytime from Manage Data, same as any other transactions.

### Fixed: Floating Panels Occasionally Rendering in the Wrong Spot
A global decorative border-ring style was unintentionally overriding `position: fixed` on a few floating elements (the Getting Started checklist and a couple of toast notifications) whenever they combined a rounded border with fixed positioning on the same element, causing them to render out of place instead of pinned to a screen corner. Fixed by keeping positioning and border/shadow styling on separate elements.

### New: Launch Screen Gold Particle Field
The profile-picker screen now has a dense field of tiny gold particles gently drifting and jiggling on their own, avoiding the center where your profile cards sit. Move your mouse and they scatter away from the cursor, then spring back to rest once it moves on - all rendered on canvas, so it stays smooth without taxing the app.

### New: Animated Border Ring & Status Colors
Every card across the app now has a subtle, continuously rotating gold hairline ring instead of the old always-on pulsing glow - a calmer, more deliberate "premium" touch instead of ambient noise. Status colors (success/warning/error/neutral) are now shared design tokens instead of hardcoded hex values scattered across pages, making dark mode and future theming more consistent.

### New: Manage Accounts, Front and Center
The "Manage Accounts" panel has moved to the top of the Overview page and now stands out with a quiet gold accent border and icon, open by default - it's still there on the Import page too. Use it to rename accounts or clean up duplicates identified from your transaction history.

### New: Decluttered Transactions Page
The Transactions page's action buttons now have real visual hierarchy (a proper primary "Add" button instead of six equal-weight buttons spread across the header), and the six-plus filter controls are tucked behind a "More filters" toggle with an active-filter badge, so the common case - browsing a month or searching - isn't competing with every advanced control at once.

### Polish: Calmer Tables & Goal Badges
Investments and Reports tables lost their "database admin" look (harsh uppercase labels, heavy muted headers) in favor of quieter, lighter styling. Goals page badges went from 7 near-identical pastel colors down to 3 meaningful groups (savings, spending control, income). Loading states across Budgets, Goals, Investments, and Transactions now show content-shaped skeleton placeholders instead of a bare spinner.

### Changed: Fewer Profile-Creation Prompts
Now that credit cards and investments are properly tracked as separate accounts within a single profile, importing a credit card or investment statement no longer nudges you to create a brand-new profile just to keep it separate - that workaround is no longer necessary since accounts already keep everything cleanly broken out.

### Fixed: Credit Card Payments Counted as Income
This was the big one. Every income/spending calculation in the app - Trends' All-Time totals, the Financial Health Score's savings rate, Dashboard/Overview/Reports/Goals/Budgets income figures - summed *every* positive transaction as income, including credit card payments. A payment toward a card is debt reduction, not income, so this was silently inflating income, net, and savings rate app-wide (and explains why the Health Score's letter grade could look fine while the separate Credit Card Health score correctly showed trouble). Credit card purchases still correctly count as real expenses everywhere - only the payment/credit side was miscounted, and that's now fixed across every affected calculation.

### Fixed: Duplicate Accounts Created During Batch Imports
Auto-importing multiple statement files in one batch for a brand-new account was creating a separate duplicate account for every file instead of reusing the one just created. The wizard now locks onto the account it creates for the first file so the rest of the batch shares it correctly.

### Fixed: Stale Balances After Clearing Transactions
Clearing an account's transactions (or undoing an import) left its balance anchor behind, which could resurface and produce an incorrect balance the next time you reimported. Balances now reset properly whenever an account ends up with no transactions left.

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
