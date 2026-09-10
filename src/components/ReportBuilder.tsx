import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, LineChart, Line, ReferenceLine,
} from "recharts";
import { FloppyDiskIcon, XIcon } from "@phosphor-icons/react";
import { getDb } from "@/lib/db";
import { incomeSumSql, expenseSumSql } from "@/lib/reportingSql";
import { merchantKey } from "@/lib/merchants";
import { formatCurrency, formatCurrencyWhole, formatMonthLabel, formatAxisCurrency } from "@/lib/utils";
import { handleLoadFailure } from "@/stores/toastStore";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import CountUp from "@/components/CountUp";

/**
 * The plotting table: any cut of the ledger, drawn four ways. Pick what to measure, what to
 * slice it by, how far back to look; read it as a sheet, bars, a wheel, or a line through
 * time. Presets are kept locally, like a drawer of saved charts.
 */

type Measure = "spending" | "income" | "net" | "count";
type Slice = "category" | "merchant" | "account" | "month" | "weekday";
type ViewKind = "sheet" | "bars" | "donut" | "line";
type Split = "none" | "month" | "account";
type AccountScope = "all" | "debit" | "credit";

interface ReportConfig {
  measure: Measure;
  slice: Slice;
  /** Months back; 0 = all time. */
  months: number;
  /** Second dimension: pivot columns on the sheet, series on the line, segments on the bars. */
  split: Split;
  /** Which accounts feed the cut: everything, cash/debit only, or credit cards only. */
  accounts: AccountScope;
  view: ViewKind;
  search: string;
  /** 0 = all rows. */
  topN: number;
}

interface SavedReport { name: string; config: ReportConfig; }

interface Row { key: string; label: string; color: string | null; perMonth: Map<string, number>; perAccount: Map<string, number>; total: number; }

const DEFAULT_CONFIG: ReportConfig = { measure: "spending", slice: "category", months: 6, split: "none", accounts: "all", view: "bars", search: "", topN: 10 };
const CONFIG_KEY = "compass_report_builder_cfg";
const PRESETS_KEY = "compass_report_presets";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** One family, stepped in intensity - gold and sea alternating, all at ledger lightness, so
 *  a ten-row chart reads as one instrument instead of a rainbow. */
const REPORT_PALETTE = [
  "hsl(42 55% 52%)", "hsl(220 45% 55%)", "hsl(42 38% 40%)", "hsl(220 30% 42%)", "hsl(42 32% 66%)",
  "hsl(220 24% 64%)", "hsl(30 32% 50%)", "hsl(200 30% 50%)", "hsl(50 26% 45%)", "hsl(240 20% 56%)",
];

/** "AMAZON MKTPL*B7340622 04/07 PURCHASE..." reads as "Amazon Mktpl" - the cleaned identity
 *  is the display for merchant rows; the sheet and tooltips still carry the full total. */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s./'-])[a-z]/g, (c) => c.toUpperCase());
}

const MEASURES: { key: Measure; label: string }[] = [
  { key: "spending", label: "Spending" }, { key: "income", label: "Income" }, { key: "net", label: "Net" }, { key: "count", label: "Purchases" },
];
const SLICES: { key: Slice; label: string }[] = [
  { key: "category", label: "Category" }, { key: "merchant", label: "Merchant" }, { key: "account", label: "Account" }, { key: "month", label: "Month" }, { key: "weekday", label: "Weekday" },
];
const RANGES: { key: number; label: string }[] = [
  { key: 3, label: "3mo" }, { key: 6, label: "6mo" }, { key: 12, label: "12mo" }, { key: 0, label: "All" },
];
const VIEWS: { key: ViewKind; label: string }[] = [
  { key: "sheet", label: "Sheet" }, { key: "bars", label: "Bars" }, { key: "donut", label: "Wheel" }, { key: "line", label: "Line" },
];
const TOPNS: { key: number; label: string }[] = [
  { key: 5, label: "Top 5" }, { key: 10, label: "Top 10" }, { key: 20, label: "Top 20" }, { key: 0, label: "All" },
];
const SPLITS: { key: Split; label: string }[] = [
  { key: "none", label: "None" }, { key: "month", label: "By month" }, { key: "account", label: "By account" },
];
const SCOPES: { key: AccountScope; label: string }[] = [
  { key: "all", label: "All" }, { key: "debit", label: "Cash & debit" }, { key: "credit", label: "Credit cards" },
];
const SCOPE_SQL: Record<AccountScope, string> = {
  all: "",
  debit: "AND a.account_type NOT IN ('credit','loan')",
  credit: "AND a.account_type='credit'",
};

/** Mirrors the "Cash & debit" scope: these types never count toward its line. */
const IGNORED_IN_DEBIT = new Set(["credit", "loan"]);

function loadConfig(): ReportConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    // Older saves used a boolean month split.
    if (parsed.overTime && !parsed.split) parsed.split = "month";
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch { return DEFAULT_CONFIG; }
}
function loadPresets(): SavedReport[] {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "[]"); } catch { return []; }
}

/** One sentence that says what the current cut is - the report describing itself. */
function describe(cfg: ReportConfig): string {
  const measure = MEASURES.find((m) => m.key === cfg.measure)!.label.toLowerCase();
  const slice = cfg.slice === "month" ? "by month" : `by ${cfg.slice}`;
  const range = cfg.months === 0 ? "all time" : `last ${cfg.months} months`;
  const extras = [
    cfg.accounts !== "all" ? SCOPES.find((s) => s.key === cfg.accounts)!.label.toLowerCase() : null,
    cfg.split !== "none" && cfg.slice !== cfg.split ? `split ${SPLITS.find((s) => s.key === cfg.split)!.label.toLowerCase()}` : null,
    cfg.topN > 0 ? `top ${cfg.topN}` : null,
    cfg.search ? `matching "${cfg.search}"` : null,
  ].filter(Boolean).join(", ");
  return `${measure.charAt(0).toUpperCase()}${measure.slice(1)} ${slice}, ${range}${extras ? `, ${extras}` : ""}.`;
}

export default function ReportBuilder({ profileId }: { profileId: number }) {
  const reduced = useAppReducedMotion();
  const [cfg, setCfg] = useState<ReportConfig>(loadConfig);
  const [presets, setPresets] = useState<SavedReport[]>(loadPresets);
  const [naming, setNaming] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  // month × account totals across the whole cut, for account-series lines.
  const [moAcct, setMoAcct] = useState<Map<string, Map<string, number>>>(new Map());
  // account name → account_type, for the cash-vs-credit line pair.
  const [acctTypes, setAcctTypes] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const set = <K extends keyof ReportConfig>(key: K, value: ReportConfig[K]) => {
    setCfg((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const db = await getDb();
      const now = new Date();
      const params: (string | number)[] = [profileId];
      let dateClause = "";
      if (cfg.months > 0) {
        dateClause = "AND t.date>=?";
        params.push(new Date(now.getFullYear(), now.getMonth() - (cfg.months - 1), 1).toISOString().split("T")[0]);
      }
      let searchClause = "";
      if (cfg.search.trim()) {
        searchClause = "AND t.description LIKE ?";
        params.push(`%${cfg.search.trim()}%`);
      }
      const keyExpr = {
        category: "COALESCE(c.name,'Uncategorized')",
        merchant: "t.description",
        account: "a.name",
        month: "strftime('%Y-%m', t.date)",
        weekday: "strftime('%w', t.date)",
      }[cfg.slice];
      const raw = await db.select<{ mo: string; k: string; acct: string; acct_type: string; color: string | null; income: number; expense: number; cnt: number }[]>(
        `SELECT strftime('%Y-%m', t.date) as mo, ${keyExpr} as k, a.name as acct, a.account_type as acct_type,
                ${cfg.slice === "category" ? "c.color" : "NULL"} as color,
                ${incomeSumSql()} as income,
                ${expenseSumSql()} as expense,
                SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id NOT IN (20,29)) THEN 1 ELSE 0 END) as cnt
         FROM transactions t JOIN accounts a ON a.id=t.account_id
         LEFT JOIN categories c ON c.id=t.category_id
         WHERE t.profile_id=? AND a.excluded_from_insights=0 ${SCOPE_SQL[cfg.accounts]} ${dateClause} ${searchClause}
         GROUP BY mo, k, acct`,
        params
      );
      if (cancelled) return;

      const value = (r: { income: number; expense: number; cnt: number }) =>
        cfg.measure === "spending" ? r.expense : cfg.measure === "income" ? r.income : cfg.measure === "net" ? r.income - r.expense : r.cnt;

      const byKey = new Map<string, Row>();
      const monthSet = new Set<string>();
      const accountSet = new Set<string>();
      const matrix = new Map<string, Map<string, number>>();
      const typeMap = new Map<string, string>();
      for (const r of raw) {
        const v = value(r);
        if (v === 0) continue;
        monthSet.add(r.mo);
        accountSet.add(r.acct);
        typeMap.set(r.acct, r.acct_type);
        const acctRow = matrix.get(r.mo) ?? new Map<string, number>();
        acctRow.set(r.acct, (acctRow.get(r.acct) ?? 0) + v);
        matrix.set(r.mo, acctRow);
        // Merchants fold on their normalized identity and display it cleaned.
        const key = cfg.slice === "merchant" ? (merchantKey(r.k) || r.k) : r.k;
        const label = cfg.slice === "weekday" ? WEEKDAYS[Number(r.k)] ?? r.k
          : cfg.slice === "month" ? formatMonthLabel(r.k)
          : cfg.slice === "merchant" ? titleCase(merchantKey(r.k) || r.k)
          : r.k;
        const row = byKey.get(key) ?? { key, label, color: r.color, perMonth: new Map<string, number>(), perAccount: new Map<string, number>(), total: 0 };
        row.perMonth.set(r.mo, (row.perMonth.get(r.mo) ?? 0) + v);
        row.perAccount.set(r.acct, (row.perAccount.get(r.acct) ?? 0) + v);
        row.total += v;
        byKey.set(key, row);
      }
      const ordered = [...byKey.values()].sort((a, b) =>
        cfg.slice === "month" || cfg.slice === "weekday" ? a.key.localeCompare(b.key) : Math.abs(b.total) - Math.abs(a.total));
      setMonths([...monthSet].sort());
      setAccounts([...accountSet].sort());
      setMoAcct(matrix);
      setAcctTypes(typeMap);
      setRows(ordered);
      setLoading(false);
    }
    load().catch(handleLoadFailure("your report", setLoading));
    return () => { cancelled = true; };
  }, [profileId, cfg.measure, cfg.slice, cfg.months, cfg.search, cfg.accounts]);

  const isMoney = cfg.measure !== "count";
  const fmt = (v: number) => (isMoney ? formatCurrency(v) : String(v));
  const fmtWhole = (v: number) => (isMoney ? formatCurrencyWhole(v) : String(v));

  // Top-N with the remainder folded into one honest "Everything else" row (never for line series).
  const { shown, other } = useMemo(() => {
    if (cfg.topN === 0 || rows.length <= cfg.topN || cfg.slice === "month" || cfg.slice === "weekday") return { shown: rows, other: null };
    const kept = rows.slice(0, cfg.topN);
    const rest = rows.slice(cfg.topN);
    const fold: Row = { key: "__other", label: `Everything else (${rest.length})`, color: null, perMonth: new Map(), perAccount: new Map(), total: 0 };
    for (const r of rest) {
      fold.total += r.total;
      for (const [mo, v] of r.perMonth) fold.perMonth.set(mo, (fold.perMonth.get(mo) ?? 0) + v);
      for (const [ac, v] of r.perAccount) fold.perAccount.set(ac, (fold.perAccount.get(ac) ?? 0) + v);
    }
    return { shown: kept, other: fold };
  }, [rows, cfg.topN, cfg.slice]);

  const grandTotal = useMemo(() => rows.reduce((s, r) => s + r.total, 0), [rows]);
  const colorOf = (row: Row, i: number) => row.key === "__other" ? "hsl(var(--neutral))" : row.color ?? REPORT_PALETTE[i % REPORT_PALETTE.length];
  const tooltipStyle = { backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px", boxShadow: "var(--shadow-raised)" };
  const truncate = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const tableRows = other ? [...shown, other] : shown;
  // The split is the second dimension: pivot columns on the sheet, segments on the bars.
  const split: Split = cfg.split === cfg.slice ? "none" : cfg.split;
  const pivotKeys = split === "month" ? months : split === "account" ? accounts : [];
  const pivotLabel = (k: string) => (split === "month" ? formatMonthLabel(k) : k);
  const pivotValue = (r: Row, k: string) => (split === "month" ? r.perMonth.get(k) : r.perAccount.get(k)) ?? 0;

  // Line view is inherently time-based: series follow the account slice or split, the top
  // slices under a month split, the cash-vs-credit pair when the scope holds both, or one total.
  const hasCredit = accounts.some((a) => acctTypes.get(a) === "credit");
  const hasDebit = accounts.some((a) => !IGNORED_IN_DEBIT.has(acctTypes.get(a) ?? ""));
  const lineSeries = useMemo(() => (
    split === "account" || cfg.slice === "account"
      ? (cfg.slice === "account"
          ? shown.filter((r) => r.key !== "__other").map((r) => ({ key: r.key, label: r.label }))
          : accounts.map((a) => ({ key: a, label: a })))
      : split === "month" && cfg.slice !== "month" ? shown.filter((r) => r.key !== "__other").slice(0, 5).map((r) => ({ key: r.key, label: r.label }))
      : cfg.accounts === "all" && hasCredit && hasDebit
        ? [{ key: "__debit", label: "Cash & debit" }, { key: "__credit", label: "Credit cards" }]
        : null
  ), [split, accounts, shown, cfg.slice, cfg.accounts, hasCredit, hasDebit]);
  const lineData = useMemo(() => months.map((mo) => {
    const point: Record<string, string | number> = { mo };
    if (lineSeries?.[0]?.key === "__debit") {
      // Same account groups as the Cash & debit / Credit cards scopes, drawn independently.
      let debit = 0, credit = 0;
      for (const [a, v] of moAcct.get(mo) ?? []) {
        const t = acctTypes.get(a) ?? "";
        if (t === "credit") credit += v;
        else if (!IGNORED_IN_DEBIT.has(t)) debit += v;
      }
      point.__debit = debit;
      point.__credit = credit;
    } else if (split === "account" && cfg.slice !== "account") {
      for (const a of accounts) point[a] = moAcct.get(mo)?.get(a) ?? 0;
    } else if (lineSeries) {
      for (const s of lineSeries) point[s.key] = rows.find((r) => r.key === s.key)?.perMonth.get(mo) ?? 0;
    } else {
      point.total = rows.reduce((s, r) => s + (r.perMonth.get(mo) ?? 0), 0);
    }
    return point;
  }), [months, rows, accounts, moAcct, acctTypes, split, cfg.slice, lineSeries]);

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const next = [...presets.filter((p) => p.name !== name), { name, config: cfg }];
    setPresets(next);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
    setNaming(false);
    setPresetName("");
  };
  const removePreset = (name: string) => {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
  };

  const segments = (
    groups: { key: string; label: string; options: { key: string | number; label: string }[]; value: string | number; onPick: (v: string) => void }[]
  ) => groups.map((g) => (
    <div key={g.key} className="rb-group">
      <span>{g.label}</span>
      <div className="workspace-segments" role="group" aria-label={g.label}>
        {g.options.map((o) => (
          <button key={String(o.key)} aria-pressed={g.value === o.key} onClick={() => g.onPick(String(o.key))}>{o.label}</button>
        ))}
      </div>
    </div>
  ));

  return (
    <section className="report-builder" aria-labelledby="rb-title">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h2 id="rb-title" className="font-semibold">Report builder</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-[52ch]">{describe(cfg)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{cfg.measure === "count" ? "Transactions in this cut" : "This cut comes to"}</p>
          <p className="hero-figure" style={{ color: cfg.measure === "net" && grandTotal < 0 ? "hsl(var(--error))" : "hsl(var(--gold-ink))" }}>
            <CountUp value={grandTotal} format={(v) => fmtWhole(Math.round(v))} />
          </p>
        </div>
      </div>

      <div className="rb-rail">
        {segments([
          { key: "measure", label: "Measure", options: MEASURES.map((m) => ({ key: m.key, label: m.label })), value: cfg.measure, onPick: (v) => set("measure", v as Measure) },
          { key: "slice", label: "Slice by", options: SLICES.map((s) => ({ key: s.key, label: s.label })), value: cfg.slice, onPick: (v) => set("slice", v as Slice) },
          { key: "split", label: "Split", options: SPLITS.map((s) => ({ key: s.key, label: s.label })), value: cfg.split, onPick: (v) => set("split", v as Split) },
          { key: "accounts", label: "Accounts", options: SCOPES.map((s) => ({ key: s.key, label: s.label })), value: cfg.accounts, onPick: (v) => set("accounts", v as AccountScope) },
          { key: "range", label: "Range", options: RANGES, value: cfg.months, onPick: (v) => set("months", Number(v)) },
          { key: "view", label: "Drawn as", options: VIEWS.map((v) => ({ key: v.key, label: v.label })), value: cfg.view, onPick: (v) => set("view", v as ViewKind) },
          { key: "topn", label: "Rows", options: TOPNS, value: cfg.topN, onPick: (v) => set("topN", Number(v)) },
        ])}
        <div className="rb-group">
          <span>Refine</span>
          <input
            type="search"
            value={cfg.search}
            onChange={(e) => set("search", e.target.value)}
            placeholder="Match descriptions…"
            aria-label="Match descriptions"
            className="rb-search"
          />
        </div>
      </div>

      {(presets.length > 0 || true) && (
        <div className="rb-presets">
          {presets.map((p) => (
            <span key={p.name} className="rb-preset">
              <button onClick={() => { setCfg(p.config); localStorage.setItem(CONFIG_KEY, JSON.stringify(p.config)); }}>{p.name}</button>
              <button aria-label={`Delete preset ${p.name}`} onClick={() => removePreset(p.name)}><XIcon size={11} /></button>
            </span>
          ))}
          {naming ? (
            <span className="rb-preset rb-preset-naming">
              <input
                autoFocus
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") savePreset(); if (e.key === "Escape") setNaming(false); }}
                placeholder="Name this report"
                aria-label="Preset name"
              />
              <button onClick={savePreset} aria-label="Save preset"><FloppyDiskIcon size={12} /></button>
            </span>
          ) : (
            <button className="rb-save" onClick={() => setNaming(true)}>
              <FloppyDiskIcon size={12} /> Save this report
            </button>
          )}
        </div>
      )}

      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={`${cfg.view}-${cfg.slice}-${cfg.measure}-${cfg.split}-${cfg.accounts}`}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? undefined : { opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="rb-canvas"
        >
          {loading ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))] py-10 text-center">Plotting…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))] py-10 text-center">Nothing matches this cut. Loosen the range or the search.</p>
          ) : cfg.view === "sheet" ? (
            <div className="rb-sheet">
              <table>
                <thead>
                  <tr>
                    <th>{SLICES.find((s) => s.key === cfg.slice)!.label}</th>
                    {pivotKeys.map((k) => <th key={k} className="rb-num">{pivotLabel(k)}</th>)}
                    <th className="rb-num">Total</th>
                    <th className="rb-num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colorOf(r, i) }} />
                          <span className="truncate">{r.label}</span>
                        </span>
                      </td>
                      {pivotKeys.map((k) => <td key={k} className="rb-num">{pivotValue(r, k) !== 0 ? fmt(pivotValue(r, k)) : "—"}</td>)}
                      <td className="rb-num font-medium">{fmt(r.total)}</td>
                      <td className="rb-num">{grandTotal !== 0 ? `${Math.round((r.total / grandTotal) * 100)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    {pivotKeys.map((k) => (
                      <td key={k} className="rb-num">{fmt(rows.reduce((s, r) => s + pivotValue(r, k), 0))}</td>
                    ))}
                    <td className="rb-num">{fmt(grandTotal)}</td>
                    <td className="rb-num">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : cfg.view === "bars" ? (
            <>
              {/* The fold row stays off the chart - one giant "everything else" bar would crush
                  the scale the top rows are being compared on; the sheet carries it instead. */}
              <ResponsiveContainer width="100%" height={Math.max(120, shown.length * 34)}>
                <BarChart
                  data={shown.map((r) => {
                    const point: Record<string, string | number> = { name: r.label, value: r.total };
                    for (const k of pivotKeys) point[k] = pivotValue(r, k);
                    return point;
                  })}
                  layout="vertical"
                  margin={{ left: 8, right: 40, top: 4, bottom: 4 }}
                >
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => truncate(String(v))} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={false}
                    contentStyle={tooltipStyle}
                    formatter={(v, name) => [fmt(v as number), pivotKeys.length > 0 ? pivotLabel(String(name)) : MEASURES.find((m) => m.key === cfg.measure)!.label]}
                    labelFormatter={(l) => String(l)}
                  />
                  {pivotKeys.length > 0 ? (
                    pivotKeys.map((k, i) => (
                      <Bar key={k} dataKey={k} stackId="split" fill={REPORT_PALETTE[i % REPORT_PALETTE.length]} radius={i === pivotKeys.length - 1 ? [0, 4, 4, 0] : undefined} />
                    ))
                  ) : (
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {shown.map((r, i) => <Cell key={r.key} fill={colorOf(r, i)} />)}
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
              {other && (
                <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
                  {other.label}: {fmt(other.total)} — kept off the bars so the comparison holds; the sheet lists it.
                </p>
              )}
            </>
          ) : cfg.view === "donut" ? (
            <div className="rb-donut">
              <div className="rb-donut-plot">
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={tableRows.filter((r) => r.total > 0).map((r) => ({ name: r.label, value: r.total }))}
                      dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={1.5} strokeWidth={0}
                    >
                      {tableRows.filter((r) => r.total > 0).map((r, i) => <Cell key={r.key} fill={colorOf(r, i)} />)}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(v) => [fmt(v as number), ""]} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="rb-donut-center" aria-hidden="true">
                  <strong>{fmtWhole(grandTotal)}</strong>
                  <small>{cfg.months === 0 ? "all time" : `${cfg.months} months`}</small>
                </div>
              </div>
              <ul className="rb-donut-legend">
                {tableRows.filter((r) => r.total > 0).map((r, i) => (
                  <li key={r.key}>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colorOf(r, i) }} />
                    <span className="truncate">{r.label}</span>
                    <strong>{fmt(r.total)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={lineData} margin={{ left: 8, right: 8, top: 8, bottom: 4 }}>
                <XAxis dataKey="mo" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={formatMonthLabel} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={isMoney ? formatAxisCurrency : undefined} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={64} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(l) => formatMonthLabel(String(l))}
                  formatter={(v, name) => [fmt(v as number), lineSeries?.find((s) => s.key === name)?.label ?? "Total"]}
                />
                {cfg.measure === "net" && <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />}
                {lineSeries === null || lineSeries.length === 0 ? (
                  <Line type="monotone" dataKey="total" stroke="hsl(var(--gold-ink))" strokeWidth={2} dot={false} />
                ) : (
                  lineSeries.map((s, i) => (
                    <Line key={s.key} type="monotone" dataKey={s.key} name={s.key} stroke={REPORT_PALETTE[i % REPORT_PALETTE.length]} strokeWidth={2} dot={false} />
                  ))
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </motion.div>
      </AnimatePresence>

      {((cfg.view === "line" && lineSeries && lineSeries.length > 0) || (cfg.view === "bars" && pivotKeys.length > 0)) && (
        <div className="trend-chips" aria-hidden="true">
          {(cfg.view === "line" ? lineSeries! : pivotKeys.map((k) => ({ key: k, label: pivotLabel(k) }))).map((s, i) => (
            <button key={s.key} tabIndex={-1} style={{ cursor: "default" }}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: REPORT_PALETTE[i % REPORT_PALETTE.length] }} />
              {s.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
