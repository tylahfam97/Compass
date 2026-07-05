import { useState, useEffect, useCallback } from "react";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";

interface BudgetRow {
  id: number;
  category_id: number;
  category_parent_id: number | null;
  category_name: string;
  category_color: string;
  amount_cents: number;
  period: string;
  spent_cents: number;
  earned_cents: number;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

export default function BudgetsPage() {
  const [month, setMonth] = useAutoMonth();
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const categories = useCategoryStore((s) => s.categories);

  // New budget form state
  const [formCatId, setFormCatId] = useState<number>(0);
  const [formAmount, setFormAmount] = useState("");
  const [formPeriod, setFormPeriod] = useState<"monthly" | "weekly">("monthly");
  const [saving, setSaving] = useState(false);

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const loadBudgets = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const [start, end] = monthBounds(month);
    const rows = await db.select<BudgetRow[]>(
      `SELECT b.id, b.category_id, c.parent_id as category_parent_id,
              c.name as category_name, c.color as category_color,
              b.amount_cents, b.period,
              COALESCE(SUM(CASE WHEN t.amount_cents<0 THEN ABS(t.amount_cents) ELSE 0 END),0) as spent_cents,
              COALESCE(SUM(CASE WHEN t.amount_cents>0 THEN t.amount_cents ELSE 0 END),0) as earned_cents
       FROM budgets b
       JOIN categories c ON b.category_id=c.id
       LEFT JOIN transactions t ON t.category_id=b.category_id
         AND t.date>=? AND t.date<?
       GROUP BY b.id
       ORDER BY c.name`,
      [start, end]
    );
    setBudgets(rows);
    setLoading(false);
  }, [month]);

  useEffect(() => {
    loadBudgets().catch(console.error);
  }, [loadBudgets]);

  useEffect(() => {
    if (categories.length > 0 && formCatId === 0) {
      setFormCatId(categories[0].id);
    }
  }, [categories, formCatId]);

  const addBudget = async () => {
    const amount = parseFloat(formAmount);
    if (isNaN(amount) || amount <= 0 || formCatId === 0) return;
    setSaving(true);
    const db = await getDb();
    const [start] = monthBounds(month);
    await db.execute(
      "INSERT INTO budgets (category_id, amount_cents, period, start_date) VALUES (?,?,?,?)",
      [formCatId, Math.round(amount * 100), formPeriod, start]
    );
    setFormAmount("");
    setSaving(false);
    await loadBudgets();
  };

  const deleteBudget = async (id: number) => {
    const db = await getDb();
    await db.execute("DELETE FROM budgets WHERE id=?", [id]);
    await loadBudgets();
  };

  return (
    <div className="p-6 max-w-2xl space-y-6">
      {/* Header with month navigation */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Budgets</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            Soft limits — no penalties, just awareness.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navMonth(-1)}
            aria-label="Previous month"
            className="p-1.5 border rounded-lg text-base leading-none
                       hover:bg-[hsl(var(--muted))] transition-colors"
          >
            ‹
          </button>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                       text-[hsl(var(--foreground))]"
          />
          <button
            onClick={() => navMonth(1)}
            aria-label="Next month"
            className="p-1.5 border rounded-lg text-base leading-none
                       hover:bg-[hsl(var(--muted))] transition-colors"
          >
            ›
          </button>
        </div>
      </div>

      {/* Add budget form */}
      <div className="border rounded-xl p-5">
        <h2 className="font-semibold mb-4">Add Budget</h2>
        <div className="flex gap-3 flex-wrap">
          <select
            value={formCatId}
            onChange={(e) => setFormCatId(parseInt(e.target.value))}
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-36
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
          >
            {categories
              .filter((c) => !c.is_system || c.id !== 15)
              .map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
          </select>
          <input
            type="number"
            min="1"
            step="0.01"
            placeholder="Amount ($)"
            value={formAmount}
            onChange={(e) => setFormAmount(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm w-36
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]"
          />
          <select
            value={formPeriod}
            onChange={(e) => setFormPeriod(e.target.value as "monthly" | "weekly")}
            className="border rounded-lg px-3 py-2 text-sm
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
          >
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
          </select>
          <button
            onClick={addBudget}
            disabled={saving || !formAmount}
            className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90
                       transition-opacity"
          >
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
      </div>

      {/* Budget list */}
      {loading && <p className="text-[hsl(var(--muted-foreground))]">Loading…</p>}

      {!loading && budgets.length === 0 && (
        <p className="text-[hsl(var(--muted-foreground))] text-center py-8">
          No budgets set. Add one above to start tracking.
        </p>
      )}

      {!loading && budgets.map((b) => {
        const isIncome = b.category_id === 1 || b.category_parent_id === 1;
        const displayCents = isIncome ? b.earned_cents : b.spent_cents;
        const displayLabel = isIncome ? "earned" : "spent";
        const pct = b.amount_cents > 0
          ? Math.min(100, Math.round((displayCents / b.amount_cents) * 100))
          : 0;
        const over = !isIncome && displayCents > b.amount_cents;
        const under = isIncome && displayCents < b.amount_cents;
        return (
          <div key={b.id} className="border rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: b.category_color }}
                />
                <span className="font-medium">{b.category_name}</span>
                <span className="text-xs text-[hsl(var(--muted-foreground))] capitalize">
                  ({b.period})
                </span>
              </div>
              <button
                onClick={() => deleteBudget(b.id)}
                className="text-xs text-[hsl(var(--muted-foreground))] hover:text-red-500
                           transition-colors"
              >
                Remove
              </button>
            </div>

            <div className="h-3 rounded-full bg-[hsl(var(--muted))] overflow-hidden mb-2">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${pct}%`,
                  backgroundColor: over ? "#ef4444" : b.category_color,
                }}
              />
            </div>

            <div className="flex justify-between text-sm">
              <span className={over ? "text-red-500 font-medium" : under ? "text-orange-500 font-medium" : "text-[hsl(var(--muted-foreground))]"}>
                {formatCurrency(displayCents)} {displayLabel}
                {over && " — over budget"}
                {under && " — below target"}
              </span>
              <span className="text-[hsl(var(--muted-foreground))]">
                {isIncome ? "Target:" : "Limit:"} {formatCurrency(b.amount_cents)} · {pct}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}


