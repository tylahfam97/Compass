import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import logoUrl from "@/assets/logo.svg";
import { useState, useEffect } from "react";
import DashboardPage from "@/pages/DashboardPage";
import TransactionsPage from "@/pages/TransactionsPage";
import ImportPage from "@/pages/ImportPage";
import TrendsPage from "@/pages/TrendsPage";
import BudgetsPage from "@/pages/BudgetsPage";
import GoalsPage from "@/pages/GoalsPage";
import ReportsPage from "@/pages/ReportsPage";
import AgentPage from "@/pages/AgentPage";
import OverviewPage from "@/pages/OverviewPage";
import ProfileSwitcher from "@/components/ProfileSwitcher";
import UpdateChecker from "@/components/UpdateChecker";
import PinModal from "@/components/PinModal";
import { useCategoryStore } from "@/stores/categoryStore";
import { useProfileStore } from "@/stores/profileStore";
import { getDb } from "@/lib/db";
import { generateInsights } from "@/lib/agent";
import type { Category, Profile } from "@/lib/types";
import "./index.css";

const NAV_ITEMS = [
  { to: "/overview",      label: "Overview" },
  { to: "/",             label: "Dashboard" },
  { to: "/transactions", label: "Transactions" },
  { to: "/import",       label: "Import" },
  { to: "/trends",       label: "Trends" },
  { to: "/budgets",      label: "Budgets" },
  { to: "/goals",        label: "Goals" },
  { to: "/reports",      label: "Reports" },
  { to: "/agent",        label: "Insights", showBadge: true },
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
  const [dark, setDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const setCategories = useCategoryStore((s) => s.setCategories);
  const { profiles, setProfiles, setActiveProfile } = useProfileStore();
  const [insightWarnings, setInsightWarnings] = useState(0);

  // Launch picker state
  const [launchReady, setLaunchReady] = useState(false);
  const [profileSelected, setProfileSelected] = useState(false);
  const [pinTarget, setPinTarget] = useState<Profile | null>(null);

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
    generateInsights(profile.id)
      .then((ins) => setInsightWarnings(ins.filter((i) => i.severity === "warning").length))
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
    <BrowserRouter>
      {/* ── Launch profile picker ─────────────────────────────────── */}
      {launchReady && !profileSelected && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center
                        bg-[hsl(var(--background))] wizard-enter-forward">
          <img src={logoUrl} alt="Compass" className="h-12 mb-8 opacity-90" />
          <h1 className="text-2xl font-semibold mb-1">{greeting()}</h1>
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
                <span className="font-medium text-sm">{p.name}</span>
                {p.pin_hash && (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">🔒 PIN</span>
                )}
              </button>
            ))}
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
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside
          className="w-52 shrink-0 flex flex-col bg-[hsl(var(--muted))]"
          style={{ borderRight: '1.5px solid var(--gold)' }}
        >
          <div className="px-4 py-3 border-b">
            <img src={logoUrl} alt="Compass" className="h-9 w-auto" />
          </div>
          <nav className="flex-1 py-4 space-y-1 px-3">
            {NAV_ITEMS.map(({ to, label, showBadge }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                      : "hover:bg-[hsl(var(--border))] text-[hsl(var(--foreground))]"
                  }`
                }
              >
                {label}
                {showBadge && insightWarnings > 0 && (
                  <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                )}
              </NavLink>
            ))}
          </nav>
          <div className="px-4 pb-4 space-y-2">
            <ProfileSwitcher />
            <button
              onClick={() => setDark((d) => !d)}
              className="w-full text-xs px-3 py-2 rounded-md border hover:bg-[hsl(var(--border))] transition-colors"
            >
              {dark ? "Light mode" : "Dark mode"}
            </button>
            <UpdateChecker />
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-[1200px] mx-auto w-full min-h-full">
            <Routes>
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/" element={<DashboardPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/trends" element={<TrendsPage />} />
              <Route path="/budgets" element={<BudgetsPage />} />
              <Route path="/goals" element={<GoalsPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/agent" element={<AgentPage />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;

