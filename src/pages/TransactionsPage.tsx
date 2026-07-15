import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { getDb, reapplyCategorizationRules } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import type { Transaction } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import CategoryModal from "@/components/CategoryModal";
import CategorizationRulesModal from "@/components/CategorizationRulesModal";
import EditTransactionModal from "@/components/EditTransactionModal";

const MAX_ROWS = 500;

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

/** Extract a clean merchant key from a raw bank description for rule creation. */
function extractMerchantKey(description: string): string {
  let s = description.toUpperCase().trim();
  s = s.replace(/^[A-Z]{2,4}[\s*]+/, "");          // strip PP*, DD *, IC* …
  s = s.replace(/\s+\d{2}\/\d{2}\s+.*$/, "");       // strip " 05/21 PURCHASE …"
  s = s.replace(/\*[A-Z0-9]{4,}/g, "");             // strip *1A52U9IQ3
  const words = s.trim().split(/\s+/);
  return words.slice(0, 2).join(" ").slice(0, 30);
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
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [rulePrompt, setRulePrompt] = useState<{ txn: Transaction; newCatId: number } | null>(null);
  const [autoCatResult, setAutoCatResult] = useState<{ updated: number; mode: string } | null>(null);
  const [autoCatRunning, setAutoCatRunning] = useState(false);
  const [autoCatError, setAutoCatError] = useState<string | null>(null);
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  const [addingTxn, setAddingTxn] = useState(false);
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

  const recategorize = async (txn: Transaction, categoryId: number) => {
    const db = await getDb();
    await db.execute("UPDATE transactions SET category_id=? WHERE id=?", [
      categoryId,
      txn.id,
    ]);
    setEditingId(null);
    // Update the row in-place so scroll position is preserved (no full reload)
    const cat = categories.find((c) => c.id === categoryId);
    setRows((prev) =>
      prev.map((r) =>
        r.id === txn.id
          ? { ...r, category_id: categoryId, category_name: cat?.name, category_color: cat?.color }
          : r
      )
    );
    // Offer to create a rule so future imports are auto-categorized
    setRulePrompt({ txn, newCatId: categoryId });
  };

  const createRuleFromPrompt = async () => {
    if (!rulePrompt) return;
    const pattern = extractMerchantKey(rulePrompt.txn.description);
    if (!pattern) { setRulePrompt(null); return; }
    const db = await getDb();
    await db.execute(
      "INSERT OR IGNORE INTO categorization_rules (pattern, match_type, category_id, priority, profile_id) VALUES (?,?,?,?,?)",
      [pattern, "contains", rulePrompt.newCatId, 75, profileId]
    );
    setRulePrompt(null);
  };

  const exportCsv = async () => {
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
      `SELECT t.*, c.name as category_name
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       WHERE t.profile_id=? ${dateWhere}${searchWhere}
       ORDER BY t.date DESC, t.id DESC`,
      params
    );
    const header = "Date,Description,Category,Amount,Balance,Notes";
    const lines = data.map((r) =>
      [
        r.date,
        `"${(r.description ?? "").replace(/"/g, '""')}"`,
        `"${(r.category_name ?? "Uncategorized").replace(/"/g, '""')}"`,
        (r.amount_cents / 100).toFixed(2),
        r.balance_cents != null ? (r.balance_cents / 100).toFixed(2) : "",
        `"${(r.notes ?? "").replace(/"/g, '""')}"`,
      ].join(",")
    );
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `compass-${allTime ? "all-time" : month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runAutoCategorize = async (mode: "uncategorized" | "all") => {
    setAutoCatRunning(true);
    setAutoCatResult(null);
    setAutoCatError(null);
    try {
      const updated = await reapplyCategorizationRules(profileId, mode);
      setAutoCatResult({ updated, mode });
    } catch (e) {
      setAutoCatError(String(e));
    } finally {
      await loadRows();
      setAutoCatRunning(false);
    }
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
          onClick={exportCsv}
          title="Export current view as CSV"
          className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                     transition-colors"
        >
          ↓ Export
        </button>
        <button
          onClick={() => setAddingTxn(true)}
          className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                     transition-colors"
        >
          ＋ Add
        </button>
        <button
          onClick={() => runAutoCategorize("uncategorized")}
          disabled={autoCatRunning}
          title="Re-run rules on uncategorized transactions only"
          className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                     transition-colors disabled:opacity-50"
        >
          {autoCatRunning ? "Running…" : "✦ Auto-Categorize"}
        </button>
        <button
          onClick={() => setCatModalOpen(true)}
          className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                     transition-colors"
        >
          ＋ Category
        </button>
        <button
          onClick={() => setRulesModalOpen(true)}
          className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                     transition-colors"
        >
          ⚙ Rules
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
                <th className="px-4 py-3 w-10" />
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
                        onChange={(e) => recategorize(t, parseInt(e.target.value))}
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
                  <td className="px-2 py-3 text-center">
                    <button
                      onClick={() => setEditTxn(t)}
                      title={t.notes ? `Note: ${t.notes}` : "Edit transaction"}
                      className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors text-sm"
                    >
                      {t.notes ? "📝" : "✏️"}
                    </button>
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

      {rulesModalOpen && (
        <CategorizationRulesModal onClose={() => setRulesModalOpen(false)} profileId={profileId} />
      )}

      {editTxn && (
        <EditTransactionModal
          transaction={editTxn}
          onClose={() => setEditTxn(null)}
          onSaved={() => loadRows()}
          profileId={profileId}
        />
      )}

      {addingTxn && (
        <EditTransactionModal
          onClose={() => setAddingTxn(false)}
          onSaved={() => loadRows()}
          profileId={profileId}
        />
      )}

      {/* Auto-categorize result / error toast */}
      {(autoCatResult || autoCatError) && (
        <div className={`fixed bottom-6 right-6 z-50 border shadow-xl rounded-xl px-5 py-3
                        flex items-center gap-4 text-sm max-w-sm
                        bg-[hsl(var(--background))]
                        ${autoCatError ? "border-red-500" : ""}`}>
          <span className="flex-1 text-[hsl(var(--foreground))]">
            {autoCatError
              ? <span className="text-red-500">Error: {autoCatError}</span>
              : autoCatResult!.updated === 0
                ? "No uncategorized transactions matched any rule."
                : <><strong>{autoCatResult!.updated}</strong> transaction{autoCatResult!.updated !== 1 ? "s" : ""} categorized.</>
            }
          </span>
          <button
            onClick={() => { setAutoCatResult(null); setAutoCatError(null); }}
            className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] text-lg leading-none"
          >
            ✕
          </button>
        </div>
      )}

      {/* "Create rule?" toast after manual recategorize */}
      {rulePrompt && (() => {
        const cat = categories.find((c) => c.id === rulePrompt.newCatId);
        const key = extractMerchantKey(rulePrompt.txn.description);
        return (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50
                          bg-[hsl(var(--background))] border shadow-xl rounded-xl
                          px-5 py-3 flex items-center gap-4 text-sm max-w-lg w-full">
            <span className="flex-1 text-[hsl(var(--foreground))]">
              Always categorize <strong>"{key}"</strong> as{" "}
              <span className="font-medium" style={{ color: cat?.color }}>
                {cat?.name ?? "this category"}
              </span>?
            </span>
            <button
              onClick={createRuleFromPrompt}
              className="px-3 py-1.5 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                         rounded-lg font-medium hover:opacity-90 transition-opacity"
            >
              Create Rule
            </button>
            <button
              onClick={() => setRulePrompt(null)}
              className="px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))] transition-colors"
            >
              Dismiss
            </button>
          </div>
        );
      })()}
    </div>
  );
}

