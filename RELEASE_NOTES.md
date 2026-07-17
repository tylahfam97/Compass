# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.8.0 — Loans Have Arrived! 🎉

This is a big one! Compass now understands **loans** - car loans, student loans, mortgages, personal loans, whatever you're paying down - alongside a bunch of import improvements, a slicker Insights experience, and a pile of account-management fixes we're genuinely excited about. Let's get into it.

### New: Loan Tracking
Add a loan the way that makes sense for you: upload a statement PDF and let Compass pull the balance, interest rate, minimum payment, and statement date for you (always shown as editable fields first, since lender formats vary wildly), or just enter it by hand. Loans get their own tile section on the Dashboard - name, balance, trend, and a mini sparkline - and they're never counted toward liquidity or your income/expense totals, exactly like credit cards.

### New: Loan Dashboard
Head to Insights for a dedicated Loan Dashboard: rank your loans by **Avalanche** (highest interest rate first - saves the most money), **Snowball** (smallest balance first - the fastest full payoff and a quick psychological win), or **Cash-flow First** (highest minimum payment first - frees up the most monthly breathing room, fastest). Each ranking comes with a plain-English reason why, plus a little debt-psychology context on why one method might suit you better than another.

### New: PDF Statement Import
You can now drop a text-based PDF bank or credit card statement straight into the Import page, right alongside CSV and XLSX - Compass reads the transactions out of the PDF and walks you through the same familiar review wizard before anything's saved. (Scanned/photographed statements aren't supported yet - there's no text in those to read - but real digital statements from your bank should just work.)

### New: Hide Accounts From Your Dashboard, Without Losing Them
Click the eye icon on any credit card tile to collapse it right there in place - it's excluded from net worth while collapsed, and expanding it again brings it right back, calculations and all. No more hunting for a way to undo a hide.

### New: Exclude Accounts From Insights
A new dropdown next to the Profile/Global switch on the Insights page lets you pick specific accounts to leave out of savings rate, health score, and spending calculations - handy for a joint account or something you just don't want skewing your numbers - without hiding it from the Dashboard.

### New: Account Detail View
Click any credit card or loan tile on the Dashboard for a proper detail view: balance, trend chart, the top 2 insights relevant to that account, and recent activity (transactions for credit cards, statement history for loans).

### New: Delete Accounts, Properly
The Manage Accounts panel now lets you delete an account even if it isn't empty - you'll get a clear warning about exactly how many transactions/holdings will go with it, plus a second "are you sure" before anything's removed. Deleting cleans up everything tied to that account, no orphaned data left behind.

### Redesigned: Insights Carousel
The Wins/Observations/Action Items cards now live in a real drag-to-browse 3D carousel - grab and slide anywhere in the box, watch cards tilt and fade as they pass by, and let go to have it glide to a stop on whichever one's centered. No scrollbar, no slider, just drag.

### Fixed: Import History Now Covers Loan Statements
Uploading a loan statement shows up in the Import page's history list just like any other import, complete with a working Undo.

### Fixed: A Couple of Silent Failures in Manage Accounts
The insights-exclusion toggle in Manage Accounts could fail without telling you anything went wrong - it now surfaces a clear error if something does go sideways, same as everywhere else in the app.

### Polish: More Breathing Room, Everywhere
Every page got a touch more padding and a bit more width - Transactions especially - for a more spacious, professional feel on larger screens.