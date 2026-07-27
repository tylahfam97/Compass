# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.9.3 — Category Totals Now Net Out Refunds & Reimbursements 💰

A correctness release for anyone who gets money back into a spending category - a reimbursement,
refund, or shared-cost repayment deposited back into your account and categorized alongside the
original expense.

### Fixed: Spending Categories Ignored Credits Filed Under Them
Category totals across Insights, Reports, Trends, Budgets, Goals, and the Dashboard only ever
summed the debits in a category, completely ignoring any credits (refunds, reimbursements, a
roommate paying you back) filed under that same category. For example, $2,740 spent on Rent with
a $1,700 reimbursement credited back would previously show as $2,740 spent instead of the correct
net $1,040. Every category total now nets debits against credits (excluding credit card/loan
payment credits, which are debt reduction, not refunds, and continue to be tracked separately).
This affects budget progress, category breakdowns, spending insights (unusual spikes, budget
suggestions, category creep, most-improved), and reduce-spend goals.

### New: Clickable Cards Now Signal Themselves
Cards that open more detail on click - Credit Card/Investment Health, debt payoff accounts, and
Dashboard's Bank/Credit Card/Loan tiles - now glow softly and shimmer to signal they're
interactive, and show a "Click for more details" hint after a second of hovering.

