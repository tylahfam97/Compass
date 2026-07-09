import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import type { Transaction } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import CategoryModal from "@/components/CategoryModal";

const MAX_ROWS = 500;

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

export default function TransactionsPage() {
  const location = useLocation();
  const initialMonth = (location.state as { month?: string } | null)?.month;
  const [month, setMonth] = useAutoMonth(initialMonth);
  const [allTime, setAllTime] = useState(false);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [catModalOpen, setCatModalOpen] = useState(false);
  const categories = useCategoryStore((s) => s.categories);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;

  const loadRows = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const hasSearch = search.trim().length > 0;
    let params: unknown[];
    let dateWhere = "";
    if (!allTime) {
      const [start, end] = monthBounds(month);
      dateWhere = "AND t.date>=? AND t.date<? ";
      params = hasSearch ? [profileId, start, end, `%${search.toUpperCase()}%`] : [profileId, start, end];
    } else {
      params = hasSearch ? [profileId, `%${search.toUpperCase()}%`] : [profileId];
    }
    const searchWhere = hasSearch ? "AND UPPER(t.description) LIKE ?" : "";
    const data = await db.select<Transaction[]>(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       WHERE t.profile_id=? ${dateWhere}${searchWhere}
       ORDER BY t.date DESC, t.id DESC
       LIMIT ${MAX_ROWS + 1}`,
      params
    );
    setRows(data);
    setLoading(false);
  }, [month, allTime, search, profileId]);

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
    <div className="p-6 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <button
          onClick={() => setCatModalOpen(true)}
          className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                     transition-colors"
        >
          ＋ Category
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        {!allTime && (
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                       text-[hsl(var(--foreground))]"
          />
        )}
        <button
          onClick={() => setAllTime((v) => !v)}
          className={`text-sm px-3 py-1.5 border rounded-lg transition-colors ${
            allTime
              ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent"
              : "hover:bg-[hsl(var(--muted))]"
          }`}
        >
          All time
        </button>
        <input
          type="text"
          placeholder="Search descriptions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-40 border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                     text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
        />
      </div>

      {/* Summary strip */}
      {!loading && rows.length > 0 && (
        <div className="flex gap-6 mb-4 text-sm text-[hsl(var(--muted-foreground))]">
          <span>{Math.min(rows.length, MAX_ROWS)} transaction{rows.length !== 1 ? "s" : ""}{rows.length > MAX_ROWS ? ` (showing first ${MAX_ROWS})` : ""}</span>
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
        <div className="border rounded-xl overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--muted))] text-left border-b">
                <th className="px-4 py-3 font-medium w-28">Date</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium text-right w-32">Amount</th>
                <th className="px-4 py-3 font-medium text-right w-32">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((t) => (
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
                  <td className={`px-4 py-3 text-right font-mono ${t.amount_cents < 0 ? "text-red-500" : "text-green-600"}`}>
                    {formatCurrency(t.amount_cents)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[hsl(var(--muted-foreground))]">
                    {t.balance_cents != null ? formatCurrency(t.balance_cents) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {catModalOpen && (
        <CategoryModal onClose={() => setCatModalOpen(false)} profileId={profileId} />
      )}
    </div>
  );
}

