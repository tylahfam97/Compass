import { useState, useEffect, useCallback } from "react";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import type { Transaction } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

export default function TransactionsPage() {
  const [month, setMonth] = useAutoMonth();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const categories = useCategoryStore((s) => s.categories);

  const loadRows = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const [start, end] = monthBounds(month);
    const hasSearch = search.trim().length > 0;
    const params: unknown[] = hasSearch
      ? [start, end, `%${search.toUpperCase()}%`]
      : [start, end];
    const where = hasSearch ? "AND UPPER(t.description) LIKE ?" : "";
    const data = await db.select<Transaction[]>(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       WHERE t.date>=? AND t.date<? ${where}
       ORDER BY t.date DESC, t.id DESC`,
      params
    );
    setRows(data);
    setLoading(false);
  }, [month, search]);

  useEffect(() => {
    loadRows().catch(console.error);
  }, [loadRows]);

  const recategorize = async (txnId: number, categoryId: number) => {
    const db = await getDb();
    await db.execute("UPDATE transactions SET category_id=? WHERE id=?", [
      categoryId,
      txnId,
    ]);
    setEditingId(null);
    await loadRows();
  };

  const totalIncome = rows.filter((r) => r.amount_cents > 0)
    .reduce((s, r) => s + r.amount_cents, 0);
  const totalExpenses = rows.filter((r) => r.amount_cents < 0)
    .reduce((s, r) => s + r.amount_cents, 0);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Transactions</h1>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                     text-[hsl(var(--foreground))]"
        />
        <input
          type="text"
          placeholder="Search descriptions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                     text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
        />
      </div>

      {/* Summary strip */}
      {!loading && rows.length > 0 && (
        <div className="flex gap-6 mb-4 text-sm text-[hsl(var(--muted-foreground))]">
          <span>{rows.length} transactions</span>
          <span className="text-green-600 font-medium">{formatCurrency(totalIncome)} in</span>
          <span className="text-red-500 font-medium">{formatCurrency(Math.abs(totalExpenses))} out</span>
        </div>
      )}

      {loading && <p className="text-[hsl(var(--muted-foreground))]">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-[hsl(var(--muted-foreground))] mt-8 text-center">
          No transactions found. Try a different month or search term.
        </p>
      )}

      {!loading && rows.length > 0 && (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--muted))] text-left border-b">
                <th className="px-4 py-3 font-medium w-28">Date</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium text-right w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                  <td className="px-4 py-3 text-[hsl(var(--muted-foreground))] whitespace-nowrap">
                    {formatDate(t.date)}
                  </td>
                  <td className="px-4 py-3 max-w-xs truncate">{t.description}</td>
                  <td className="px-4 py-3">
                    {editingId === t.id ? (
                      <select
                        autoFocus
                        defaultValue={t.category_id ?? 15}
                        onBlur={() => setEditingId(null)}
                        onChange={(e) => recategorize(t.id, parseInt(e.target.value))}
                        className="border rounded px-2 py-1 text-xs bg-[hsl(var(--background))]
                                   text-[hsl(var(--foreground))]"
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    ) : (
                      <button
                        onClick={() => setEditingId(t.id)}
                        title="Click to change category"
                        className="inline-block px-2 py-0.5 rounded-full text-xs text-white
                                   hover:opacity-80 transition-opacity"
                        style={{ backgroundColor: t.category_color ?? "#9ca3af" }}
                      >
                        {t.category_name ?? "Uncategorized"}
                      </button>
                    )}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-mono ${t.amount_cents < 0 ? "text-red-500" : "text-green-600"}`}
                  >
                    {formatCurrency(t.amount_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

