# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.5.5 — Spotlight Cards + Insight Visualizers

### Spotlight Cards
The Insights page now features a **Spotlight** section between the sparkline and the insight groups. Up to two of your most vital insights are promoted to full-width featured cards with inline data visualizations:
- **Wins** (positive_streak, most_improved): promoted if actionable and rich
- **Action Items** (savings_rate_low, spending_velocity, emergency_fund_runway): promoted if urgent and rich

### 5 Inline Visualizers
Each spotlight card renders a visualizer appropriate to the insight type:
- **StreakTrack** — filled/hollow dot row showing consecutive under-budget months. A pulse ring highlights the most recent dot. Flame emoji at streak ≥6.
- **RateGauge** — gradient track (red → amber → green, 0%–40%), current-rate marker, dashed amber line at the 20% target.
- **PaceMeter** — bar split at the “normal” pace marker. Blue zone = within normal. Amber zone = overshoot. Shows avg vs paced amounts.
- **BeforeAfterBars** — two horizontal bars: muted for last month, emerald for this month. Percent drop shown inline.
- **RunwaySegments** — segmented track with labeled breakpoints at 0, 1, 3, 6, 12 months. Color changes with urgency.

### Course-Change “Potential” Callouts
Every spotlight card shows a “↗ potential” line at the bottom — a forward-looking suggestion computed from your actual data:
- “Cut expenses by 12% → savings rate reaches 20%”
- “Tighten Dining budget by 10% → save ~$480/yr”
- “Spend $18/day less → finish month on track”
- “Save $2,400 more → reach 3-month runway”

### Financial Health Score
A new **0–100 Health Score** is computed from four signals every time you open the Insights page and displayed as a colored pill in the sticky header:
- **Savings Rate** (40 pts) — based on your 3-month average
- **Budget Health** (30 pts) — % of budgets not overspent this month
- **Balance Runway** (20 pts) — months of expenses covered by current balance
- **Income Stability** (10 pts) — variance across the last 6 months of income

Grades: **A · Excellent** (85+), **B · Good** (70+), **C · Building** (55+), **D · Developing** (40+). Score color changes with grade: emerald → blue → amber → orange.

### Insights: Wins First
The insight groups are now ordered **Wins → Observations → Action Items**. Positive reinforcement anchors the experience — you see what’s working before what needs fixing. Opening the page after a good month now feels rewarding.

### Adaptive Group Expansion
- Wins exist → Wins accordion opens, everything else collapsed
- No wins but observations exist → Observations opens
- Only action items → Action Items opens

Your last manual expand/collapse state is remembered per-session.

### Grouped Severity Accordions
The flat card list is replaced with three collapsible accordion groups. Each group is a single visual container with a colored header, count badge, and slim row items inside:
- **Wins**: Emerald header (celebration green) with `CheckCircle` icon
- **Observations**: Neutral muted header with `Info` icon
- **Action Items**: Warm amber header with `Target` icon (constructive, not alarming)

Dismiss buttons are invisible at rest and appear only on hover — reducing clutter while staying accessible.

### Gradient Sparkline
The savings rate sparkline is now an `AreaChart` with a gradient fill under the curve, no axis lines, and more height — feels like a financial analytics tool, not a debug chart.

### Cleaner KPI Strip
The Financial Health Summary uses generous padding, `tracking-widest` uppercase labels, and larger bold values — luxury whitespace.