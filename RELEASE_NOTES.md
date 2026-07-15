# Created by @tylahfam97 

# Hello! Another release just dropped 🧭 

## Check us out at https://privatecompass.app

## Compass 0.5.2 — Smarter Insights & Holistic Goals

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