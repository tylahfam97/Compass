# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.8.6 — Smarter Insights, a Calmer Window 🧠✨

A big one under the hood: Insights now understands loans, credit, and investments far more deeply, plus a round of hardening and a nasty Dashboard crash finally run to ground.

### New: Loan, Credit & Investment Insights
Insights now covers ground it never touched before: loan balance tracking (high/growing/paid-down, mirroring what credit cards already had), a payoff-time-and-interest-cost projection for any loan or credit card with a rate and minimum payment on file, a "pay this one first" recommendation across all your debts, portfolio performance vs. the long-run market average, projected dividend income, and a concentration-risk flag if one holding dominates your portfolio. "No budget set" suggestions now always sort to the bottom of the list, since they're a nice-to-have, not something urgent.

### Fixed: Dashboard Could Go Blank After Clicking a Bank Account
A rare rendering hiccup around the account-detail sparkline chart could, in some environments, take down the entire window - leaving only the background behind and requiring a full app restart. Compass now catches problems like this in place and offers a "Try again" instead of forcing a restart, and a known benign chart-resize browser quirk is suppressed outright so it can't trigger this in the first place.

### New: Filter Transactions by Account
The Transactions page's "More filters" panel can now filter down to a single account, alongside the existing category/type/amount filters.

### Improved: Insights Carousel
The insight carousel now opens centered instead of bunched to one side, cards have more room to breathe, and clicking a card's icon expands it in place to show the full text - with a soft orange-to-blue glow on hover so it's obvious it's clickable. The whole Insights page also got a lighter, less boxy visual pass.

### Hardening & Performance
- Import, Reports, and Investments pages now load on demand instead of bundling into the initial app load.
- The database layer picked up extra defense-in-depth against malformed queries, and a stray categorization debug log no longer prints in production builds.
- Removed the redundant "Restaurants" category (it was always a subcategory of Food & Dining) - existing data is automatically merged in, nothing is lost.