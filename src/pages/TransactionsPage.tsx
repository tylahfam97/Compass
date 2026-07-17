import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowUpDown, ArrowUp, ArrowDown, Plus, Sparkles, Download, Tag, Settings, SlidersHorizontal, ChevronDown, ChevronUp, Upload, Pencil, StickyNote } from "lucide-react";
import { getDb, reapplyCategorizationRules } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import type { Transaction } from "@/lib/types";
import { TRANSFER_CATEGORY_ID } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import CategoryOptions from "@/components/CategoryOptions";
import { useProfileStore } from "@/stores/profileStore";
import CategoryModal from "@/components/CategoryModal";
import CategorizationRulesModal from "@/components/CategorizationRulesModal";
import EditTransactionModal from "@/components/EditTransactionModal";
import { setPendingImportFiles } from "@/lib/pendingImport";
import InfoTooltip from "@/components/InfoTooltip";
import { TableSkeleton } from "@/components/Skeleton";

const MAX_ROWS = 500;
const ALL_TIME_LIMIT = 10000;
const TRANSFER_DISCLAIMER_TEXT =
  "Transfers tracks money moved between your own accounts (e.g. checking \u2192 savings). It's excluded from income and expense totals everywhere in the app.";
const TRANSFER_DISMISSED_KEY = "compass_transfer_disclaimer_dismissed";
const TRANSFER_SHOWN_SESSION_KEY = "compass_transfer_disclaimer_shown_session";

type SortCol = "date" | "description" | "category" | "amount" | "balance";
type SortDir = "asc" | "desc";

/** Map sort column keys to the SQL expression used in ORDER BY. */
const SORT_EXPR: Record<SortCol, string> = {
  date:        "t.date",
  description: "UPPER(t.description)",
  category:    "UPPER(COALESCE(c.name, ''))",
  amount:      "t.amount_cents",
  balance:     "COALESCE(t.balance_cents, 0)",
};

/** Small sort indicator icon for a table header. */
function SortIndicator({ col, sortCol, sortDir }: { col: SortCol; sortCol: SortCol | null; sortDir: SortDir }) {
  if (sortCol !== col) return <ArrowUpDown size={13} className="opacity-30 shrink-0" />;
  return sortDir === "asc"
    ? <ArrowUp size={13} className="text-[hsl(var(--primary))] shrink-0" />
    : <ArrowDown size={13} className="text-[hsl(var(--primary))] shrink-0" />;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

/** Build the WHERE clause + params array shared by loadRows and exportCsv. */
function buildQueryParts(opts: {
  profileId: number;
  allTime: boolean;
  month: string;
  search: string;
  filterCategory: string;          // "" = all, "uncategorized", or stringified id
  filterType: "all" | "income" | "expense";
  filterAmountMin: string;         // dollar string, empty = no bound
  filterAmountMax: string;         // dollar string, empty = no bound
}): { where: string; params: unknown[] } {
  const conditions: string[] = ["t.profile_id=?"];
  const params: unknown[] = [opts.profileId];

  if (!opts.allTime) {
    const [start, end] = monthBounds(opts.month);
    conditions.push("t.date>=? AND t.date<?");
    params.push(start, end);
  }
  if (opts.search.trim()) {
    conditions.push("UPPER(t.description) LIKE ?");
    params.push(`%${opts.search.toUpperCase().trim()}%`);
  }
  if (opts.filterCategory === "uncategorized") {
    conditions.push("(t.category_id = 15 OR t.category_id IS NULL)");
  } else if (opts.filterCategory) {
    conditions.push("t.category_id = ?");
    params.push(parseInt(opts.filterCategory, 10));
  }
  if (opts.filterType === "income")  conditions.push("t.amount_cents > 0");
  if (opts.filterType === "expense") conditions.push("t.amount_cents < 0");

  const minCents = opts.filterAmountMin.trim() ? Math.round(parseFloat(opts.filterAmountMin) * 100) : NaN;
  const maxCents = opts.filterAmountMax.trim() ? Math.round(parseFloat(opts.filterAmountMax) * 100) : NaN;
  if (!isNaN(minCents) && minCents >= 0) { conditions.push("ABS(t.amount_cents) >= ?"); params.push(minCents); }
  if (!isNaN(maxCents) && maxCents >= 0) { conditions.push("ABS(t.amount_cents) <= ?"); params.push(maxCents); }

  return { where: conditions.join(" AND "), params };
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
  const navigate = useNavigate();
  const navState = location.state as { month?: string; category?: number | null } | null;
  const initialMonth = navState?.month;
  const initialCategory = navState?.category;
  const [month, setMonth] = useAutoMonth(initialMonth);
  const [allTime, setAllTime] = useState(false);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTransferNotice, setShowTransferNotice] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const monthInputRef = useRef<HTMLInputElement>(null);
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

  // Extended filters
  const [filterCategory, setFilterCategory] = useState(() => {  // "" | "uncategorized" | "<id>"
    if (initialCategory === undefined) return "";
    return initialCategory === null ? "uncategorized" : String(initialCategory);
  });
  const [filterType, setFilterType]         = useState<"all" | "income" | "expense">("all");
  const [filterAmountMin, setFilterAmountMin] = useState("");
  const [filterAmountMax, setFilterAmountMax] = useState("");
  // Advanced filters start expanded if one is already active (e.g. arriving via a
  // "View all" link from another page with a category pre-filled) so nothing feels hidden.
  const [showMoreFilters, setShowMoreFilters] = useState(
    () => filterCategory !== "" || filterType !== "all" || filterAmountMin !== "" || filterAmountMax !== ""
  );

  // Column sort state — null = default (date DESC)
  const [sortCol, setSortCol] = useState<SortCol | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      // Same column: flip direction
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      // New column: sensible default direction
      setSortCol(col);
      setSortDir(col === "date" || col === "amount" || col === "balance" ? "desc" : "asc");
    }
  };

  const hasActiveFilters =
    filterCategory !== "" || filterType !== "all" ||
    filterAmountMin !== "" || filterAmountMax !== "";
  const activeFilterCount =
    [filterCategory !== "", filterType !== "all", filterAmountMin !== "", filterAmountMax !== ""]
      .filter(Boolean).length;

  const clearFilters = () => {
    setFilterCategory(""); setFilterType("all");
    setFilterAmountMin(""); setFilterAmountMax("");
  };

  const loadRows = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const { where, params } = buildQueryParts({
      profileId, allTime, month, search,
      filterCategory, filterType, filterAmountMin, filterAmountMax,
    });
    const orderBy = sortCol
      ? `${SORT_EXPR[sortCol]} ${sortDir.toUpperCase()}, t.id ${sortDir.toUpperCase()}`
      : "t.date DESC, t.id DESC";
    const data = await db.select<Transaction[]>(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ${allTime ? ALL_TIME_LIMIT + 1 : MAX_ROWS + 1}`,
      params
    );
    setRows(data);
    setLoading(false);
  }, [month, allTime, search, profileId, filterCategory, filterType, filterAmountMin, filterAmountMax, sortCol, sortDir]);

  useEffect(() => {
    loadRows().catch(console.error);
  }, [loadRows]);

  // First time a Transfers-categorized row appears (and it hasn't been dismissed
  // this session or permanently), surface a one-time explainer so it's clear why
  // transfers are excluded from income/expense totals. Note: merely rendering the
  // banner does NOT count as "shown" - only clicking "Got it"/"Don't show again"
  // does, so navigating to another tab and back doesn't silently suppress it.
  useEffect(() => {
    if (showTransferNotice) return;
    if (localStorage.getItem(TRANSFER_DISMISSED_KEY) === "1") return;
    if (sessionStorage.getItem(TRANSFER_SHOWN_SESSION_KEY) === "1") return;
    if (rows.some((r) => r.category_id === TRANSFER_CATEGORY_ID)) {
      setShowTransferNotice(true);
    }
  }, [rows, showTransferNotice]);

  const dismissTransferNotice = () => {
    sessionStorage.setItem(TRANSFER_SHOWN_SESSION_KEY, "1");
    setShowTransferNotice(false);
  };
  const dismissTransferNoticeForever = () => {
    localStorage.setItem(TRANSFER_DISMISSED_KEY, "1");
    setShowTransferNotice(false);
  };

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
      [pattern, "contains", rulePrompt.newCatId, 250, profileId]
    );
    setRulePrompt(null);
  };

  const exportCsv = async () => {
    const db = await getDb();
    const { where, params } = buildQueryParts({
      profileId, allTime, month, search,
      filterCategory, filterType, filterAmountMin, filterAmountMax,
    });
    const data = await db.select<Transaction[]>(
      `SELECT t.*, c.name as category_name
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       WHERE ${where}
       ORDER BY ${sortCol ? `${SORT_EXPR[sortCol]} ${sortDir.toUpperCase()}, t.id ${sortDir.toUpperCase()}` : "t.date DESC, t.id DESC"}`,
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
    const suggestedName = `compass-${allTime ? "all-time" : month}.csv`;

    // Use the native File System Access API (available in WebView2 / Chromium).
    // This opens the OS save-file dialog so the user can choose location and name.
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (opts: unknown) => Promise<{
          createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
        }>;
      }).showSaveFilePicker({
        suggestedName,
        types: [{ description: "CSV file", accept: { "text/csv": [".csv"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(csv);
      await writable.close();
    } catch (err: unknown) {
      // AbortError = user dismissed the dialog — that's fine, do nothing.
      if ((err as { name?: string })?.name !== "AbortError") {
        console.error("Export failed:", err);
      }
    }
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
  const netAmount = totalIncome + totalExpenses;

  const handlePageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith(".csv"));
    if (files.length === 0) return;
    setPendingImportFiles(files);
    navigate("/import");
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  return (
    <div
      className="p-6 flex flex-col h-full relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handlePageDrop}
    >
      {/* CSV drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center
                        bg-black/20 backdrop-blur-sm border-2 border-dashed
                        border-[hsl(var(--primary))] rounded-xl pointer-events-none">
          <Upload size={40} className="text-[hsl(var(--primary))] mb-3" />
          <p className="font-semibold text-[hsl(var(--primary))] text-lg">Drop CSV to import</p>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">Opens the import wizard</p>
        </div>
      )}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAddingTxn(true)}
            className="text-sm px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       hover:opacity-90 transition-opacity flex items-center gap-1.5 font-medium"
          >
            <Plus size={14} /> Add
          </button>
          <button
            onClick={() => runAutoCategorize("uncategorized")}
            disabled={autoCatRunning}
            title="Apply your rules to all transactions; system rules fill remaining uncategorized ones"
            className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                       transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            <Sparkles size={14} /> {autoCatRunning ? "Running…" : "Auto-Categorize"}
          </button>
          <button
            onClick={exportCsv}
            title="Export current view as CSV"
            className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                       transition-colors flex items-center gap-1.5"
          >
            <Download size={14} /> Export
          </button>
          <button
            onClick={() => setCatModalOpen(true)}
            title="Manage categories"
            className="text-sm px-2.5 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                       transition-colors flex items-center"
          >
            <Tag size={14} />
          </button>
          <button
            onClick={() => setRulesModalOpen(true)}
            title="Manage categorization rules"
            className="text-sm px-2.5 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                       transition-colors flex items-center"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Transfers explainer - shows once per session (or until permanently dismissed) */}
      {showTransferNotice && (
        <div className="mb-4 rounded-xl px-4 py-3 flex items-start gap-3 text-sm"
          style={{ border: "1px solid hsl(var(--primary)/0.35)", backgroundColor: "hsl(var(--primary)/0.06)" }}>
          <span className="text-base leading-none mt-0.5">↔️</span>
          <p className="flex-1 text-[hsl(var(--muted-foreground))]">
            <strong className="text-[hsl(var(--foreground))]">Transfers</strong> is not spending or income - {TRANSFER_DISCLAIMER_TEXT}
          </p>
          <div className="flex gap-2 shrink-0">
            <button onClick={dismissTransferNoticeForever}
              className="text-xs px-2.5 py-1 rounded-md border hover:bg-[hsl(var(--muted))] transition-colors">
              Don't show again
            </button>
            <button onClick={dismissTransferNotice}
              className="text-xs px-2.5 py-1 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity">
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="space-y-2 mb-4">
        {/* Row 1 — the essentials, always visible */}
        <div className="flex gap-3 flex-wrap items-center">
          {!allTime && (
            <input
              ref={monthInputRef}
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              onClick={() => { try { monthInputRef.current?.showPicker(); } catch { /* unsupported */ } }}
              className="cursor-pointer border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
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
          <button
            onClick={() => setShowMoreFilters((v) => !v)}
            className={`text-sm px-3 py-1.5 border rounded-lg transition-colors flex items-center gap-1.5 ${
              hasActiveFilters ? "bg-[hsl(var(--primary)/0.1)] border-[hsl(var(--primary)/0.4)] text-[hsl(var(--primary))]" : "hover:bg-[hsl(var(--muted))]"
            }`}
          >
            <SlidersHorizontal size={14} />
            More filters
            {hasActiveFilters && (
              <span className="w-4 h-4 rounded-full bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-[10px] font-bold flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
            {showMoreFilters ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                         transition-colors px-1"
            >
              × Clear
            </button>
          )}
        </div>

        {/* Row 2 — category + type + amount, tucked behind "More filters" so the common
            case (just browsing a month or searching) isn't competing with 6+ controls */}
        {showMoreFilters && (
          <div className="flex gap-3 flex-wrap items-center border-t pt-3">
            {/* Category */}
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                         text-[hsl(var(--foreground))] cursor-pointer"
            >
              <option value="">All categories</option>
              <option value="uncategorized">Uncategorized</option>
              <CategoryOptions categories={categories.filter((c) => c.id !== 15)} />
            </select>
            <InfoTooltip text={TRANSFER_DISCLAIMER_TEXT} />

            {/* Income / Expense / All toggle */}
            <div className="flex border rounded-lg overflow-hidden text-sm">
              {(["all", "income", "expense"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setFilterType(t)}
                  className={`px-3 py-1.5 transition-colors ${
                    filterType === t
                      ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                      : "hover:bg-[hsl(var(--muted))]"
                  } ${
                    t === "income" ? "border-x" : ""
                  }`}
                >
                  {t === "all" ? "All" : t === "income" ? "Income" : "Expenses"}
                </button>
              ))}
            </div>

            {/* Amount range */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-[hsl(var(--muted-foreground))]">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Min"
                value={filterAmountMin}
                onChange={(e) => setFilterAmountMin(e.target.value)}
                className="w-20 border rounded-lg px-2 py-1.5 text-sm bg-[hsl(var(--background))]
                           text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
              />
              <span className="text-[hsl(var(--muted-foreground))] text-sm">—</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Max"
                value={filterAmountMax}
                onChange={(e) => setFilterAmountMax(e.target.value)}
                className="w-24 border rounded-lg px-2 py-1.5 text-sm bg-[hsl(var(--background))]
                           text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
              />
            </div>
          </div>
        )}
      </div>

      {/* Summary card */}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="border rounded-xl px-4 py-3 text-center">
            <p className="text-xs text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-1">Income</p>
            <p className="text-lg font-bold text-green-600">{formatCurrency(totalIncome)}</p>
          </div>
          <div className="border rounded-xl px-4 py-3 text-center">
            <p className="text-xs text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-1">Expenses</p>
            <p className="text-lg font-bold text-red-500">{formatCurrency(Math.abs(totalExpenses))}</p>
          </div>
          <div className="border rounded-xl px-4 py-3 text-center">
            <p className="text-xs text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-1">Net</p>
            <p className={`text-lg font-bold ${netAmount >= 0 ? "text-green-600" : "text-red-500"}`}>{formatCurrency(netAmount)}</p>
          </div>
        </div>
      )}

      {loading && <TableSkeleton rows={8} cols={5} />}

      {!loading && rows.length === 0 && (
        <p className="text-[hsl(var(--muted-foreground))] mt-8 text-center">
          No transactions found. Try a different month or search term.
        </p>
      )}

      {!loading && rows.length > 0 && (
        <div className="border rounded-xl overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b text-[hsl(var(--muted-foreground))]">
                {([
                  { key: "date",        label: "Date",        cls: "w-28" },
                  { key: "description", label: "Description", cls: "" },
                  { key: "category",    label: "Category",    cls: "" },
                  { key: "amount",      label: "Amount",      cls: "w-32 text-right" },
                  { key: "balance",     label: "Balance",     cls: "w-32 text-right" },
                ] as { key: SortCol; label: string; cls: string }[]).map(({ key, label, cls }) => (
                  <th key={key}
                    className={`px-4 py-3 font-medium cursor-pointer select-none group
                               hover:bg-[hsl(var(--muted-foreground)/0.08)] transition-colors ${cls}`}
                    onClick={() => handleSort(key)}>
                    <div className={`flex items-center gap-1 ${cls.includes("text-right") ? "justify-end" : ""}`}>
                      {label}
                      <SortIndicator col={key} sortCol={sortCol} sortDir={sortDir} />
                    </div>
                  </th>
                ))}
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, allTime ? ALL_TIME_LIMIT : MAX_ROWS).map((t) => (
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
                        <CategoryOptions categories={categories} />
                      </select>
                    ) : (
                      <button
                        onClick={() => setEditingId(t.id)}
                        title="Click to change category"
                        className="inline-block px-2 py-0.5 rounded-full text-xs text-white
                                   hover:opacity-80 transition-opacity"
                        style={{ backgroundColor: t.category_color ?? "hsl(var(--neutral))" }}
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
                      className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
                    >
                      {t.notes ? <StickyNote size={14} /> : <Pencil size={14} />}
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

