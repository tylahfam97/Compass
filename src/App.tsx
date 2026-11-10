import { BrowserRouter, Routes, Route, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useState, useEffect, Suspense, lazy, Fragment, type CSSProperties } from "react";
import {
  SquaresFourIcon, ArrowsLeftRightIcon, UploadSimpleIcon, TrendUpIcon, ChartLineIcon,
  WalletIcon, TargetIcon, ChartBarIcon, LightbulbIcon, GlobeIcon, CaretLeftIcon, CaretRightIcon, ChatCircleIcon, ChatTeardropTextIcon, SparkleIcon, CalendarCheckIcon, GearSixIcon, LockKeyIcon,
  MapTrifoldIcon, MagnifyingGlassIcon, SunIcon, MoonIcon, SidebarSimpleIcon, IconContext,
} from "@phosphor-icons/react";
import CompassMark from "@/components/CompassMark";
import { useIsDark } from "@/hooks/useIsDark";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MotionConfig, motion } from "motion/react";
import DashboardPage from "@/pages/DashboardPage";
import TransactionsPage from "@/pages/TransactionsPage";
import TrendsPage from "@/pages/TrendsPage";
import BudgetsPage from "@/pages/BudgetsPage";
import GoalsPage from "@/pages/GoalsPage";
import AgentPage from "@/pages/AgentPage";
import OverviewPage from "@/pages/OverviewPage";
import SettingsPage from "@/pages/SettingsPage";
import ProfileSwitcher from "@/components/ProfileSwitcher";
import UpdateChecker from "@/components/UpdateChecker";
import FeedbackModal from "@/components/FeedbackModal";
import CommandPalette, { type PaletteCommand } from "@/components/CommandPalette";
import PageReadout from "@/components/PageReadout";
import PinModal from "@/components/PinModal";
import MonthRolloverModal from "@/components/MonthRolloverModal";
import GoldParticleField from "@/components/GoldParticleField";
import Spotlight from "@/components/Spotlight";
import OnboardingChecklistWidget from "@/components/OnboardingChecklistWidget";
import ErrorBoundary from "@/components/ErrorBoundary";
import ToastHost from "@/components/ToastHost";
import { useToastStore } from "@/stores/toastStore";
import { CardListSkeleton } from "@/components/Skeleton";
import { installPointerGlow } from "@/lib/pointerGlow";

// Lazy-loaded: these 3 pages pull in the heaviest deps (xlsx, pdfjs-dist,
// recharts, papaparse), code-splitting them keeps the initial bundle/first
// paint lean since most sessions don't visit all three every time.
const ImportPage = lazy(() => import("@/pages/ImportPage"));
const ReportsPage = lazy(() => import("@/pages/ReportsPage"));
const InvestmentsPage = lazy(() => import("@/pages/InvestmentsPage"));
const PlanPage = lazy(() => import("@/pages/PlanPage"));
const ChartPage = lazy(() => import("@/pages/ChartPage"));

function PageLoadingFallback() {
  return (
    <div className="py-6">
      <CardListSkeleton count={3} />
    </div>
  );
}

/**
 * Wraps the routed page content in an ErrorBoundary keyed to the current path, so a
 * one-time render error on one page can't leave the WHOLE APP stuck showing the "Something
 * went wrong" fallback on every subsequent page/navigation - previously the single shared
 * ErrorBoundary instance never unmounted across route changes (it lives above <Routes>),
 * so once tripped it kept rendering its fallback regardless of which page you navigated to
 * next, until "Try again" was clicked. Keying by pathname forces React to remount a fresh,
 * untripped boundary on every navigation, so a transient glitch on one page never "follows"
 * you back to Dashboard (or anywhere else).
 */
function RoutedContent() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      {/* Keyed remount gives an entrance-only fade/rise; no AnimatePresence so navigation is never
          delayed by an exit animation. MotionConfig suppresses the movement under reduced motion.
          The glint is a one-shot gold sweep across the top: the instrument settling on the page. */}
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
      >
        <span className="route-glint" aria-hidden="true" />
        <PageReadout />
        <Routes>
        <Route path="/overview" element={<div className="py-6"><OverviewPage /></div>} />
        <Route path="/" element={<DashboardPage />} />
        <Route path="/transactions" element={<div className="py-6"><TransactionsPage /></div>} />
        <Route path="/import" element={<Suspense fallback={<PageLoadingFallback />}><div className="py-6"><ImportPage /></div></Suspense>} />
        <Route path="/trends" element={<div className="py-6"><TrendsPage /></div>} />
        <Route path="/chart" element={<Suspense fallback={<PageLoadingFallback />}><div className="py-6"><ChartPage /></div></Suspense>} />
        <Route path="/investments" element={<Suspense fallback={<PageLoadingFallback />}><div className="py-6"><InvestmentsPage /></div></Suspense>} />
        <Route path="/budgets" element={<div className="py-6"><BudgetsPage /></div>} />
        <Route path="/goals" element={<div className="py-6"><GoalsPage /></div>} />
        <Route path="/plan" element={<Suspense fallback={<PageLoadingFallback />}><div className="py-6"><PlanPage /></div></Suspense>} />
        <Route path="/reports" element={<Suspense fallback={<PageLoadingFallback />}><div className="py-6"><ReportsPage /></div></Suspense>} />
        <Route path="/agent" element={<div className="py-6"><AgentPage /></div>} />
        <Route path="/settings" element={<div className="py-6"><SettingsPage /></div>} />
      </Routes>
      </motion.div>
    </ErrorBoundary>
  );
}

/**
 * The workspace backdrop: a faint aurora and a bearing dial, behind everything and fixed to the
 * window. Each page has its own heading (its place in the sidebar), so changing page turns the
 * dial and drifts the aurora a little, then everything rests - no continuous animation. Hidden behind the opaque launch screen, so the login is unchanged.
 */
function AppBackdrop() {
  const { pathname } = useLocation();
  const index = Math.max(0, NAV_ITEMS.findIndex((item) => (item.to === "/" ? pathname === "/" : pathname.startsWith(item.to))));
  const style = {
    "--heading": `${-index * (360 / NAV_ITEMS.length)}deg`,
    "--aurora-shift": `${(index - NAV_ITEMS.length / 2) * 0.5}vw`,
  } as CSSProperties;
  return (
    <div className="app-backdrop" aria-hidden="true" style={style}>
      <div className="backdrop-aurora" />
      <div className="backdrop-bearing">
        <div className="bearing-dial" />
      </div>
    </div>
  );
}

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
const PALETTE_KEY = IS_MAC ? "⌘K" : "Ctrl K";

/**
 * Owns the command palette. Ctrl+K (Cmd+K on macOS, where Ctrl+K is a text-editing key) toggles
 * it; its commands are the sidebar's own destinations plus the app-wide actions App passes in.
 * Lives inside the router because the destinations navigate.
 */
function PaletteHost({ open, setOpen, actions }: { open: boolean; setOpen: (open: boolean) => void; actions: PaletteCommand[] }) {
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Autofill can dispatch a keydown that carries no key at all.
      if (event.key?.toLowerCase() !== "k" || event.altKey || event.shiftKey) return;
      if (IS_MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      // A held key would flicker the palette open and shut. And when another dialog owns the
      // keyboard and the focus trap, leave it alone.
      if (event.repeat || (!open && document.querySelector('[aria-modal="true"]'))) return;
      setOpen(!open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  if (!open) return null;
  const destinations: PaletteCommand[] = NAV_ITEMS.map(({ to, label, Icon, about, keywords }) => ({
    id: to, label, about, keywords, group: "Go to", icon: <Icon size={16} />, run: () => navigate(to),
  }));
  return <CommandPalette commands={[...destinations, ...actions]} onClose={() => setOpen(false)} />;
}

import { useCategoryStore } from "@/stores/categoryStore";
import { useProfileStore } from "@/stores/profileStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { getDb } from "@/lib/db";
import { generateInsights } from "@/lib/agent";
import type { Category, Profile } from "@/lib/types";
// Self-hosted variable fonts (the Tauri CSP is font-src 'self'); imported ahead of the
// stylesheet so Vite emits the woff2 files before any rule references them.
import "@fontsource-variable/source-sans-3";
import "@fontsource-variable/source-serif-4/standard.css";
import "./index.css";

// `about` and `keywords` feed the command palette, so a page answers to what it shows as well
// as to its name. `group` starts a new cluster in the sidebar (a hairline above the item).
const NAV_ITEMS = [
  { to: "/overview",      label: "Overview",      Icon: GlobeIcon,            showBadge: false, tourId: undefined,   group: false, about: "Net worth and every account",  keywords: "balances own owe assets debt profiles" },
  { to: "/",             label: "Dashboard",     Icon: SquaresFourIcon,      showBadge: false, tourId: undefined,   group: false, about: "This month at a glance",       keywords: "home income spending net pay cycle accounts" },
  { to: "/transactions", label: "Transactions",  Icon: ArrowsLeftRightIcon,  showBadge: false, tourId: undefined,   group: true,  about: "Search, edit and categorize",  keywords: "ledger activity add category rules export" },
  { to: "/import",       label: "Import",        Icon: UploadSimpleIcon,     showBadge: false, tourId: undefined,   group: false, about: "Bring in statements",          keywords: "upload csv pdf xlsx bank card brokerage file" },
  { to: "/trends",       label: "Trends",        Icon: TrendUpIcon,          showBadge: false, tourId: undefined,   group: true,  about: "Spending over time",           keywords: "history months categories compare" },
  { to: "/chart",        label: "Chart",         Icon: MapTrifoldIcon,       showBadge: false, tourId: undefined,   group: false, about: "Where the money flows",        keywords: "map flow currents sources" },
  { to: "/investments",  label: "Investments",   Icon: ChartLineIcon,        showBadge: false, tourId: undefined,   group: false, about: "Portfolio and holdings",       keywords: "stocks funds crypto brokerage allocation dividends" },
  { to: "/budgets",      label: "Budgets",       Icon: WalletIcon,           showBadge: false, tourId: undefined,   group: true,  about: "Limits by category",           keywords: "limit over weekly monthly allowance" },
  { to: "/goals",        label: "Goals",         Icon: TargetIcon,           showBadge: false, tourId: undefined,   group: false, about: "Targets and progress",         keywords: "savings reserve emergency fund reduce" },
  { to: "/plan",         label: "Plan",          Icon: CalendarCheckIcon,    showBadge: false, tourId: undefined,   group: false, about: "Cash-flow forecast",           keywords: "bills paycheck safe to spend scenario what if calendar upcoming" },
  { to: "/reports",      label: "Reports",       Icon: ChartBarIcon,         showBadge: false, tourId: undefined,   group: true,  about: "Any cut of the ledger",        keywords: "report table totals dates" },
  { to: "/agent",        label: "Insights",      Icon: LightbulbIcon,        showBadge: true,  tourId: "nav-agent", group: false, about: "Health score and review",      keywords: "score subscriptions debt payoff interest savings rate" },
  { to: "/settings",     label: "Settings",      Icon: GearSixIcon,          showBadge: false, tourId: undefined,   group: true,  about: "Backup, appearance and data",  keywords: "restore theme motion schedule diagnostics" },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function initials(name: string): string {
  return name.trim().split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").slice(0, 2).join("");
}

function App() {
  const setTheme = useSettingsStore((state) => state.setTheme);
  const dark = useIsDark();
  const setDark = (value: boolean) => setTheme(value ? "dark" : "light");
  const setCategories = useCategoryStore((s) => s.setCategories);
  const { profiles, setProfiles, setActiveProfile } = useProfileStore();
  const restartOnboarding = useOnboardingStore((s) => s.restart);
  const motionPref = useSettingsStore((s) => s.motionPref);
  const [insightWarnings, setInsightWarnings] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", motionPref === "reduced");
  }, [motionPref]);

  // Card hover light follows the pointer (see lib/pointerGlow.ts).
  useEffect(() => installPointerGlow(), []);

  // Launch picker state
  const [launchReady, setLaunchReady] = useState(false);
  const [profileSelected, setProfileSelected] = useState(false);
  const [pinTarget, setPinTarget] = useState<Profile | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("sidebarOpen") !== "false"
  );
  const [appVersion, setAppVersion] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The collapsed rail shows icons only; this is the label of the one under the pointer or focus.
  const [railTip, setRailTip] = useState<{ label: string; top: number } | null>(null);

  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    setRailTip(null);
    localStorage.setItem("sidebarOpen", String(open));
  };
  const railTipProps = (label: string) => {
    if (sidebarOpen) return {};
    const show = (event: { currentTarget: HTMLElement }) => {
      const box = event.currentTarget.getBoundingClientRect();
      setRailTip({ label, top: box.top + box.height / 2 });
    };
    const hide = () => setRailTip(null);
    return { onMouseEnter: show, onFocus: show, onMouseLeave: hide, onBlur: hide };
  };

  useEffect(() => {
    import("@tauri-apps/api/app").then(({ getVersion }) => {
      getVersion().then(setAppVersion).catch(() => {});
    });
  }, []);

  // One-time trust notice: the OS keyring lost the DB encryption key this launch and Compass
  // recovered it from the compass.key backup file. Everything works, but the user deserves to
  // know it happened - repeated losses point at Credential Manager/Keychain trouble.
  useEffect(() => {
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<boolean>("key_recovered_from_backup")
        .then((restored) => {
          if (!restored) return;
          useToastStore.getState().show(
            "Your system's credential store lost Compass's encryption key, so it was restored " +
            "from the local backup key file. Your data was never at risk - but if this keeps " +
            "happening, your OS credential store may need attention.",
            { tone: "info", duration: 0 }
          );
        })
        .catch(() => {});
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const selectProfile = async (profile: Profile) => {
    setActiveProfile(profile);
    const db = await getDb();
    const cats = await db.select<Category[]>(
      "SELECT * FROM categories WHERE is_system=1 OR profile_id=? ORDER BY name",
      [profile.id]
    );
    setCategories(cats);
    generateInsights([profile.id])
      .then((ins) => {
        // Dismissed warnings should not keep the badge lit.
        const dismissed = new Set(useProfileStore.getState().dismissedInsights);
        setInsightWarnings(ins.filter((i) => i.severity === "warning" && !dismissed.has(i.dismissKey)).length);
      })
      .catch(() => {});
    setPinTarget(null);
    setProfileSelected(true);
  };

  useEffect(() => {
    (async () => {
      const db = await getDb();
      const allProfiles = await db.select<Profile[]>(
        "SELECT * FROM profiles ORDER BY created_at"
      );
      setProfiles(allProfiles);
      setLaunchReady(true);

      // Auto-select only when there is exactly one profile and it has no PIN
      if (allProfiles.length === 1 && !allProfiles[0].pin_hash) {
        await selectProfile(allProfiles[0]);
      }
    })().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MotionConfig reducedMotion={motionPref === "reduced" ? "always" : "user"}>
    <IconContext.Provider value={{ size: 16, weight: "regular" }}>
    <BrowserRouter>
      {/* ── Launch profile picker ─────────────────────────────────── */}
      {launchReady && !profileSelected && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center
                        bg-[hsl(var(--background))] wizard-enter-forward overflow-hidden">
          <GoldParticleField />
          <div className="relative z-10 flex flex-col items-center">
            <div className="flex items-center gap-3 mb-8">
              <CompassMark size={44} title="Compass" />
              <span className="font-serif text-[28px] font-medium tracking-tight">Compass</span>
            </div>
            <h1 className="font-serif text-[34px] font-medium leading-tight mb-1">{greeting()}</h1>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mb-8">
              {profiles.length > 1 ? "Who's tracking today?" : "Enter your PIN to continue"}
            </p>

            <div className="flex gap-4 flex-wrap justify-center max-w-xl px-6">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => p.pin_hash ? setPinTarget(p) : selectProfile(p)}
                  className="flex flex-col items-center gap-3 p-6 rounded-2xl border
                             hover:bg-[hsl(var(--muted))] hover:border-[hsl(var(--primary)/0.4)]
                             transition-all duration-150 w-40 group"
                >
                  <div
                    className="w-16 h-16 rounded-full flex items-center justify-center
                               text-2xl font-bold text-white shadow-sm
                               group-hover:scale-105 transition-transform duration-150"
                    style={{ backgroundColor: p.avatar_color }}
                  >
                    {initials(p.name)}
                  </div>
                  <span className="font-medium text-sm w-full text-center truncate" title={p.name}>{p.name}</span>
                  {p.pin_hash && (
                    <span className="text-xs text-[hsl(var(--muted-foreground))] inline-flex items-center gap-1">
                      <LockKeyIcon size={12} /> PIN protected
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* PIN entry for launch picker */}
      {pinTarget && (
        <PinModal
          profile={pinTarget}
          onSuccess={() => selectProfile(pinTarget)}
          onCancel={() => setPinTarget(null)}
        />
      )}
      {profileSelected && <MonthRolloverModal />}
      <ToastHost />
      <AppBackdrop />
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        {/* The instrument panel: always night navy, in both themes, so the brand is present
            on the paper theme too. Tokens are re-scoped here so every descendant (profile
            switcher, theme button, update checker) inherits the night palette. */}
        <aside
          className={`app-sidebar shrink-0 flex flex-col overflow-y-auto bg-[hsl(var(--sidebar))] border-r transition-all duration-200
                      ${sidebarOpen ? "w-60" : "w-14"}`}
          data-expanded={sidebarOpen}
          onKeyDown={(event) => { if (event.key === "Escape") setSidebarOpen(false); }}
          onScroll={() => setRailTip(null)}
        >
          {/* Mark + wordmark, collapse toggle */}
          <div className={`border-b flex items-center ${sidebarOpen ? "px-4 py-3 justify-between" : "py-3 justify-center"}`}>
            {sidebarOpen ? (
              <span className="flex items-center gap-2.5 min-w-0">
                <CompassMark size={28} />
                <span className="font-serif text-[20px] font-medium tracking-tight truncate">Compass</span>
              </span>
            ) : (
              <CompassMark size={26} title="Compass" />
            )}
            {/* Rendered only when open: the collapsed rail has its own toggle below, and two
                elements titled "Expand sidebar" would be ambiguous for assistive tech and tests. */}
            {sidebarOpen && (
              <span className="flex items-center gap-0.5 shrink-0">
                {profileSelected && (
                  <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    title={`Jump to a page or action (${PALETTE_KEY})`}
                    aria-haspopup="dialog"
                    className="palette-launcher"
                  >
                    <MagnifyingGlassIcon size={16} />
                  </button>
                )}
                <button
                  onClick={() => toggleSidebar(false)}
                  title="Collapse sidebar"
                  aria-expanded
                  className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                             hover:bg-[hsl(var(--muted))] rounded-md p-1 transition-colors"
                >
                  <CaretLeftIcon size={16} />
                </button>
              </span>
            )}
          </div>
          {!sidebarOpen && (
            <button
              onClick={() => toggleSidebar(true)}
              title="Expand sidebar"
              aria-expanded={false}
              className="mx-auto mt-1 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                         hover:bg-[hsl(var(--muted))] rounded-md p-1 transition-colors"
            >
              <CaretRightIcon size={16} />
            </button>
          )}
          {!sidebarOpen && profileSelected && (
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label={`Jump to a page or action (${PALETTE_KEY})`}
              aria-haspopup="dialog"
              className="palette-launcher mx-auto mt-1"
              data-rail="true"
              {...railTipProps(`Jump to… ${PALETTE_KEY}`)}
            >
              <MagnifyingGlassIcon size={18} />
            </button>
          )}

          {/* Nav, icon+label when open, icon-only with an instant label beside the rail when
              collapsed. The active item carries a 2px gold bearing mark on its leading edge and a
              filled icon; hairlines cluster the pages by job. */}
          <nav className="flex-1 flex flex-col py-2 gap-0.5 px-2" aria-label="Pages">
            {NAV_ITEMS.map(({ to, label, Icon, showBadge, tourId, group }, index) => (
              <Fragment key={to}>
              {group && <span className="nav-divider" data-pin={index === NAV_ITEMS.length - 1 ? "bottom" : undefined} aria-hidden="true" />}
              <NavLink
                to={to}
                end={to === "/"}
                data-tour={tourId}
                aria-label={!sidebarOpen ? label : undefined}
                {...railTipProps(label)}
                className={({ isActive }) =>
                  `relative flex items-center gap-2.5 px-2.5 py-[7px] rounded-md text-sm font-medium transition-colors
                   ${sidebarOpen ? "" : "justify-center"}
                   ${isActive
                     ? "nav-active bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--gold-ink))]"
                     : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--foreground)/0.05)]"
                   }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <motion.span layoutId="nav-bearing" className="nav-bearing" transition={{ type: "spring", stiffness: 420, damping: 36 }} />}
                    <Icon size={18} weight={isActive ? "fill" : "regular"} className="shrink-0" />
                    {sidebarOpen && (
                      <span className="flex-1 flex items-center justify-between">
                        {label}
                        {showBadge && insightWarnings > 0 && (
                          <span className="w-2 h-2 rounded-full bg-[hsl(var(--warning))]" />
                        )}
                      </span>
                    )}
                    {!sidebarOpen && showBadge && insightWarnings > 0 && (
                      <span className="absolute ml-3 -mt-3 w-2 h-2 rounded-full bg-[hsl(var(--warning))]" />
                    )}
                  </>
                )}
              </NavLink>
              </Fragment>
            ))}
          </nav>
          {!sidebarOpen && railTip && (
            <span className="rail-tip" style={{ top: railTip.top }} aria-hidden="true">{railTip.label}</span>
          )}

          {sidebarOpen && (
            <div className="px-4 pb-4 space-y-2">
              <ProfileSwitcher />
              <button
                data-tour="dark-mode-toggle"
                onClick={() => setDark(!dark)}
                className="w-full text-xs px-3 py-2 rounded-md border hover:bg-[hsl(var(--border))] transition-colors"
              >
                {dark ? "Light mode" : "Dark mode"}
              </button>
              <UpdateChecker autoCheck />
              <button
                onClick={() => restartOnboarding()}
                className="w-full text-xs px-3 py-1.5 rounded-md text-[hsl(var(--muted-foreground))]
                           hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--border))]
                           transition-colors flex items-center justify-center gap-1.5"
              >
                <SparkleIcon size={12} />
                Replay tour
              </button>
              <button
                onClick={() => setFeedbackOpen(true)}
                className="w-full text-xs px-3 py-1.5 rounded-md text-[hsl(var(--muted-foreground))]
                           hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--border))]
                           transition-colors flex items-center justify-center gap-1.5"
              >
                <ChatTeardropTextIcon size={12} />
                Send feedback
              </button>
              <button
                onClick={() => openUrl("https://github.com/tylahfam97/Compass/issues/new").catch(() => {})}
                className="w-full text-xs px-3 py-1.5 rounded-md text-[hsl(var(--muted-foreground))]
                           hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--border))]
                           transition-colors flex items-center justify-center gap-1.5"
              >
                <ChatCircleIcon size={12} />
                Report an issue
              </button>
              {appVersion && (
                <p className="text-center text-[10px] text-[hsl(var(--muted-foreground))] opacity-50">
                  v{appVersion}
                </p>
              )}
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="app-main flex-1 min-w-0 overflow-y-auto">
          <div className="app-workspace w-full min-h-full">
            <RoutedContent />
          </div>
        </main>
      </div>
      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} version={appVersion} />}
      {profileSelected && (
        <PaletteHost
          open={paletteOpen}
          setOpen={setPaletteOpen}
          actions={[
            { id: "theme", group: "Actions", label: dark ? "Switch to light mode" : "Switch to dark mode", keywords: "theme appearance night paper", icon: dark ? <SunIcon size={16} /> : <MoonIcon size={16} />, run: () => setDark(!dark) },
            { id: "sidebar", group: "Actions", label: sidebarOpen ? "Collapse sidebar" : "Expand sidebar", keywords: "menu navigation rail", icon: <SidebarSimpleIcon size={16} />, run: () => toggleSidebar(!sidebarOpen) },
            { id: "feedback", group: "Actions", label: "Send feedback", keywords: "contact developer idea problem", icon: <ChatTeardropTextIcon size={16} />, run: () => setFeedbackOpen(true) },
            // The tour points at controls that only exist in the open sidebar.
            { id: "tour", group: "Actions", label: "Replay tour", keywords: "help guide onboarding walkthrough", icon: <SparkleIcon size={16} />, run: () => { toggleSidebar(true); restartOnboarding(); } },
          ]}
        />
      )}
      {profileSelected && (
        <>
          <Spotlight />
          <OnboardingChecklistWidget />
        </>
      )}
    </BrowserRouter>
    </IconContext.Provider>
    </MotionConfig>
  );
}

export default App;

