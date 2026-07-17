export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  /** data-tour attribute value to spotlight, or null for a modal-only step (Welcome/Finish). */
  target: string | null;
  /** Route to navigate to first, if the target only exists there. Omit for sidebar
   *  elements that are present on every route. */
  route?: string;
  placement?: "top" | "bottom" | "left" | "right";
  /** Optional label for a secondary action button (e.g. "Take me there"). */
  actionLabel?: string;
  actionRoute?: string;
}

/** The 8-step "Getting Started" tour. Order here is just the suggested/default order -
 *  the checklist widget lets users open any step directly, in any order. */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "welcome",
    title: "Welcome to Compass",
    description:
      "Compass keeps your finances entirely on this device. Before you dive in, here's a quick " +
      "rundown of a few things that aren't always obvious at first glance.",
    target: null,
  },
  {
    id: "profiles-vs-accounts",
    title: "Profiles are for people. Accounts are for you.",
    description:
      "A Profile is a separate person or entity - you, a partner, a business. Within a profile, " +
      "your individual checking, credit card, and investment accounts are tracked separately too, " +
      "so multiple credit cards or bank accounts never get mixed together. Click the pencil icon " +
      "next to your name here to rename your profile to something personal.",
    target: "profile-switcher-toggle",
    placement: "right",
  },
  {
    id: "pin-privacy",
    title: "Lock a profile with a PIN",
    description:
      "Sharing this computer? Open the same profile panel and set a PIN - Compass will ask for it " +
      "before that profile's data loads, and before it's included in any cross-profile Global totals.",
    target: "profile-switcher-toggle",
    placement: "right",
  },
  {
    id: "import-basics",
    title: "Importing statements",
    description:
      "Compass auto-detects your bank's format from common exports (Chase, Amex, Discover, Wells " +
      "Fargo, and more) and pre-fills the column mapping. It'll also ask which account a statement " +
      "belongs to, so two different credit cards are tracked as two separate accounts instead of " +
      "overwriting each other. One more nuance worth knowing: a credit card payment is never counted " +
      "as income and a purchase is always counted as a real expense, no matter which side of the " +
      "statement it shows up on.",
    target: "import-presets",
    route: "/import",
    placement: "bottom",
  },
  {
    id: "insights",
    title: "Insights is the cream of the app",
    description:
      "This is where Compass actually thinks about your money - a Financial Health Score, credit " +
      "card and investment health, net worth trends, and personalized insights that update as your " +
      "data grows. If you only explore one tab beyond the basics, make it this one.",
    target: "nav-agent",
    placement: "right",
    actionLabel: "Take me there",
    actionRoute: "/agent",
  },
  {
    id: "manage-accounts",
    title: "Manage Accounts",
    description:
      "Every account Compass has identified from your transactions shows up here - rename one, or " +
      "merge duplicates if an import ever created more than one by mistake. This is separate from " +
      "Profiles entirely.",
    target: "manage-accounts",
    route: "/overview",
    placement: "top",
  },
  {
    id: "nav-demo-dark",
    title: "A couple more things",
    description:
      "Try Demo Mode from an empty Dashboard to load realistic sample data and explore every page " +
      "risk-free - clear it anytime from Manage Data. And if you'd rather work at night, the dark " +
      "mode toggle lives right here at the bottom of the sidebar.",
    target: "dark-mode-toggle",
    route: "/",
    placement: "top",
  },
  {
    id: "finish",
    title: "You're all set",
    description:
      "That's everything niche enough to call out up front - the rest of Compass is meant to be " +
      "explored. Come back to this checklist anytime with \"Replay tour\" at the bottom of the sidebar.",
    target: null,
  },
];
