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
import { useCategoryStore } from "@/stores/categoryStore";
import { getDb } from "@/lib/db";
import type { Category } from "@/lib/types";
import "./index.css";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard" },
  { to: "/transactions", label: "Transactions" },
  { to: "/import", label: "Import" },
  { to: "/trends", label: "Trends" },
  { to: "/budgets", label: "Budgets" },
  { to: "/goals", label: "Goals" },
  { to: "/reports", label: "Reports" },
];

function App() {
  const [dark, setDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const setCategories = useCategoryStore((s) => s.setCategories);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    getDb()
      .then((db) =>
        db.select<Category[]>("SELECT * FROM categories ORDER BY name")
      )
      .then(setCategories)
      .catch(console.error);
  }, [setCategories]);

  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="w-52 shrink-0 border-r flex flex-col bg-[hsl(var(--muted))]">
          <div className="px-4 py-3 border-b">
            <img src={logoUrl} alt="Compass" className="h-9 w-auto" />
          </div>
          <nav className="flex-1 py-4 space-y-1 px-3">
            {NAV_ITEMS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                      : "hover:bg-[hsl(var(--border))] text-[hsl(var(--foreground))]"
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="px-4 pb-4">
            <button
              onClick={() => setDark((d) => !d)}
              className="w-full text-xs px-3 py-2 rounded-md border hover:bg-[hsl(var(--border))] transition-colors"
            >
              {dark ? "Light mode" : "Dark mode"}
            </button>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/trends" element={<TrendsPage />} />
            <Route path="/budgets" element={<BudgetsPage />} />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/reports" element={<ReportsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;

