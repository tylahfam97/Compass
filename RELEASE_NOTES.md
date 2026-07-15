# Created by @tylahfam97 

# Hello! Another release just dropped 🧭

## Compass 0.5.1 — Global Budgets

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