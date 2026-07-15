# Created by @tylahfam97 

# Hello! Another release just dropped 🧭 


## Check us out at https://privatecompass.app

## Compass 0.5.3 — Insights Overhaul & Window Improvements

### App: Opens Maximized
Compass now opens in a maximized window by default, giving your data the most canvas possible. It still respects the minimum size constraints and can be resized freely.

### Insights: Completely Redesigned Cards
Insight cards now use **Lucide icons** instead of ASCII symbols, giving warnings, observations, and wins a distinct visual identity. Warning cards are heavier — a wider colored left border and bolder title make them easy to spot at a glance. Action CTAs (**"Set budget →"**, **"Set goal →"**) are now proper pill buttons rather than small text links.

### Insights: Financial Health Summary (new top panel)
A **Financial Health Summary** panel now appears above the insight list on every visit, showing at a glance:
- Average monthly income and spend
- Average savings rate with a health label (Healthy / Building / Below target)
- Top spending category
- An inline **12-month savings rate sparkline** in the same panel

This gives you immediate orientation before reading the individual insights.

### Insights: Count Badges + Last-Updated Timestamp
Each severity group (**Needs attention**, **Observations**, **Wins**) now shows a count badge. The page subtitle shows the exact time the analysis was last run, so you know the data is fresh after an import.

### Insights: Collapsible Secondary Sections
**Category Trends** and **Subscription Inventory** are now collapsible panels — collapsed by default so the insight cards and health summary get full focus. Your expand/collapse preference is remembered per session.

### Insights: Celebrations
When all insights are dismissed or there’s nothing to flag, the page now shows a proper all-clear state instead of a flat text message.

### 4 New Insight Types

#### Spending Velocity
If you’re spending faster than your normal monthly pace mid-month, a warning surfaces: *“On pace for $X this month — Y% above your avg $Z.”* Catches runaway spending early rather than at month-end.

#### Emergency Fund Runway
If you have balance data imported, Compass now shows how many months of expenses your current balance covers. Under 3 months triggers a warning; 6+ months shows a success card.

#### Bill Due Soon
Detects recurring fixed expenses (same description, same amount, 2+ occurrences) and predicts the next due date. If a recurring charge is expected within 7 days, you get an early heads-up so you don’t get caught off-guard.

#### Expense Ratio Drift
Compares your expense/income ratio over the last 3 months vs the 3 months before that. If your savings margin has compressed by 8+ percentage points, a warning flags that expenses are eating into income faster than before.

### Insights: Transfers Excluded
Internal bank transfers (same-institution moves, Zelle, Venmo, Cash App tagged as Transfers) no longer appear in the **Ghost Subscriptions** or **Frequent Small Purchases** insights. Recurring transfers were showing as phantom subscriptions — this is now fixed.

### Insights: 5 New Analyses

#### Category Creep
If spending in any category has grown more than 30% comparing the last 3 months to the 3 months before that, you’ll see a warning with the annualised cost of that drift. Gradual increases are easy to miss — this surfaces them automatically.

#### Year-End Projection
Based on your recent average monthly net savings, Compass now projects how much you’ll have saved (or overspent) by December 31st. Updates each month as your data changes.

#### Most Improved Category
If any spending category drops more than 20% month-over-month with at least a $30 absolute difference, a success card highlights the improvement and encourages you to keep going.

#### Under-Budget Streak (improved)
The existing positive-streak insight now includes an actionable nudge: if you’ve been consistently under budget on a category, it suggests tightening the limit to capture those savings permanently.

#### Weekend Spending Pattern
If 35%+ of your monthly spending happens on weekends, Compass surfaces the split (weekend vs. weekday dollars) and names your top weekend merchant. Triggers a warning if the weekend share exceeds 50%.

### Goals: 4 New Holistic Goal Types
The Goals page now supports 7 types total — the original 3 plus 4 new multi-month, longitudinal types that Budgets cannot cover:

#### Savings Target
Set a cumulative dollar amount to save (e.g. $5,000 emergency fund). Progress tracks the sum of all positive monthly nets since the goal was created — not just this month’s net.

#### Balance Floor
Set a minimum account balance to maintain (e.g. keep at least $1,000 in checking). Requires a balance column to be imported. Shows your current balance against the target in real time.

#### Under-Budget Streak
Choose a budget category and a target number of consecutive months. Compass counts how many months in a row you’ve stayed under that budget and shows a segmented progress track — one segment per month.

#### Savings Rate Habit
Set a target savings rate (e.g. 20%) and a number of consecutive months to maintain it. Progress shows how many months in a row you’ve hit the rate, with the same segmented track.

All streak/habit goals show a visual month-dot track rather than a fill bar, making the longitudinal nature obvious at a glance.

### New Feature: Global vs. Profile-Specific Budgets

Budgets can now be scoped to a single profile or shared across all profiles on the account.

#### Profile / Global view toggle
A **Profile | Global** pill toggle appears at the top-right of the Budgets page, sitting alongside the month picker. Selecting **Profile** (blue) shows only budgets belonging to the active profile. Selecting **Global** (golden) shows budgets that aggregate spending across every profile on the account.

#### Creating global budgets
The **Add Budget** form now includes a matching **Profile | Global** scope toggle. Budgets created in Global mode are stored independently of any profile and count spending from all profiles together.

#### Flipping scope on existing budgets
Every budget card shows a **↑ Global** or **↓ Profile** button next to the Remove button. Clicking it converts the budget in-place without losing any history.

#### Scope badges
Each budget card displays a color-coded badge — a golden **Global** badge or a blue **Profile** badge — so the scope is always visible at a glance. Global budgets also render their progress bar in the compass gold color.

#### PIN-locked profiles in Global view
When you switch to Global view, Compass automatically walks you through a PIN unlock sequence for any profiles that are PIN-protected and not yet unlocked this session. You can skip individual profiles — their data will be excluded from totals and a banner will note which profiles are locked. Locked profiles can be unlocked at any time from the banner without leaving the page.

#### Transfers still excluded
The Transfers category is not counted as income or spending in either scope — consistent with existing behavior.

#### Toggle persistence
The Global / Profile view preference is remembered per-profile across page navigation and app restarts.