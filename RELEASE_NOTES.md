# Created by @tylahfam97 
# Check us out at https://privatecompass.app
# Hello! Another release just dropped 🧭 

## Compass 0.5.6 — UX Polish + Dual Health Score Modal

### Page Layout: Balanced Vertical Spacing
All non-Dashboard pages now use symmetric `py-6` padding instead of the previous top-only offset. Charts and content no longer hug the top edge or leave an excessive void below short-content pages like Trends.

### Financial Health Score: View-Mode Aware
The score hero card and header pill now reflect the **currently active view** — Global or Profile. Switching between Profile and Global instantly updates the score displayed in both places without reopening any modal.

### Financial Health Score: Unified Tabbed Intro Modal
The intro modal has been redesigned from two sequential pop-ups into a single modal with **Global / Profile tabs**:
- Opens on the first Insights visit each session, defaulting to the **Global** tab
- The **🌐 Global** tab (golden accent) shows the all-profiles aggregated score
- The **👤 Profile** tab (blue accent) shows the active profile’s individual score
- Tabs switch instantly with a smooth bar-width transition on the breakdown bars
- One “Got it” button dismisses both — no more two-step sequence

---

