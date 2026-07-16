import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, CheckCircle, Target, Info, HelpCircle, TrendingUp, TrendingDown } from "lucide-react";
import { motion, AnimatePresence, animate, useMotionValue } from "motion/react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import {
  generateInsights, getSpendingProfile, getSavingsHistory, computeHealthScore, computeCreditCardHealthScore,
} from "@/lib/agent";
import {
  computeNetWorth, getNetWorthHistory, computeInvestmentReturn, computeInvestmentHealthScore, getTopRoiHoldings,
  type NetWorthSnapshot, type InvestmentReturn, type TopRoiHolding,
} from "@/lib/netWorth";
import type { Insight, Profile, HealthScore, SecurityType, CreditCardHealthScore, InvestmentHealthScore } from "@/lib/types";
import InsightCard from "@/components/InsightCard";
import InfoTooltip from "@/components/InfoTooltip";
import SpotlightCard from "@/components/SpotlightCard";
import PinModal from "@/components/PinModal";

const ROI_SECTION_LABELS: Record<SecurityType, string> = {
  stock: "Stocks", etf: "ETFs", mutual_fund: "Mutual Funds", cash: "Cash", other: "Other",
};
const ROI_SECTION_ORDER: SecurityType[] = ["stock", "etf", "mutual_fund", "other", "cash"];

/** Animates a number counting up to `value` on change/mount, using motion's imperative animate(). */
function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const mv = useMotionValue(0);
  const [display, setDisplay] = useState(() => format(0));
  useEffect(() => {
    const controls = animate(mv, value, {
      duration: 0.7, ease: "easeOut",
      onUpdate: (v) => setDisplay(format(v)),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <>{display}</>;
}

/** Small standalone benchmark-based score card (Credit Card Health / Investment Health). */
function MiniScoreCard({
  label, score, infoText,
}: {
  label: string;
  score: CreditCardHealthScore | InvestmentHealthScore | null;
  infoText: string;
}) {
  if (!score || !score.hasData) {
    return (
      <div className="border rounded-2xl p-4 flex flex-col justify-center text-center min-h-[104px]">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">{label}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">No data yet</p>
      </div>
    );
  }
  return (
    <div className="border rounded-2xl p-4" style={{ borderColor: score.color + "40" }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: score.color }}>{label}</p>
        <InfoTooltip text={infoText} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-black tabular-nums" style={{ color: score.color }}>
          <CountUp value={score.score} format={(v) => Math.round(v).toString()} />
        </span>
        <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">{score.grade}</span>
      </div>
      <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-1.5 leading-snug">{score.detail}</p>
    </div>
  );
}

interface SubItem {
  description: string;
  amount_cents: number;
  month_count: number;
  category_name: string;
  category_color: string;
}
interface CatDelta {
  category_name: string;
  category_color: string;
  this_month: number;
  last_month: number;
  delta_pct: number;
}

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [`${y}-${String(m).padStart(2, "0")}-01`, new Date(y, m, 1).toISOString().split("T")[0]];
}
function prevYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function viewKey(profileId: number) { return `compass_insight_view_${profileId}`; }

function loadGroupState(): Record<string, boolean> {
  try {
    const s = localStorage.getItem("compass_insight_groups");
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}

// ── Scope toggle ──────────────────────────────────────────────────────────────
interface ScopeToggleProps { isGlobal: boolean; onToggle: () => void; }
function ScopeToggle({ isGlobal, onToggle }: ScopeToggleProps) {
  return (
    <button role="switch" aria-checked={isGlobal} onClick={onToggle}
      style={{
        width: 52, height: 28, borderRadius: 14, padding: 3,
        backgroundColor: isGlobal ? "#C08A1C" : "#3b82f6",
        transition: "background-color 0.3s", cursor: "pointer",
        display: "inline-flex", alignItems: "center",
        border: "none", flexShrink: 0, boxShadow: "inset 0 1px 3px rgba(0,0,0,0.18)",
      }}>
      <div style={{
        width: 22, height: 22, borderRadius: 11, backgroundColor: "white",
        transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
        transform: isGlobal ? "translateX(24px)" : "translateX(0)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.28)", flexShrink: 0,
      }} />
    </button>
  );
}

// ── Collapsible data section ──────────────────────────────────────────────────
interface CollapsibleSectionProps {
  title: string; subtitle?: string; expanded: boolean;
  onToggle: () => void; children: React.ReactNode;
}
function CollapsibleSection({ title, subtitle, expanded, onToggle, children }: CollapsibleSectionProps) {
  return (
    <section className="border rounded-2xl overflow-hidden">
      <button onClick={onToggle}
        className="w-full px-5 py-4 bg-[hsl(var(--muted))] flex items-center justify-between
                   hover:bg-[hsl(var(--muted))/80] transition-colors text-left">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm">{title}</span>
          {subtitle && <span className="text-xs text-[hsl(var(--muted-foreground))]">{subtitle}</span>}
        </div>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {expanded && children}
    </section>
  );
}

// ── Insight severity accordion ────────────────────────────────────────────────
interface InsightGroupProps {
  label: string;
  severity: "warning" | "info" | "success";
  items: Insight[];
  onApply: (i: Insight) => void;
  open: boolean;
  onToggle: () => void;
}
function InsightGroup({ label, severity, items, onApply, open, onToggle }: InsightGroupProps) {
  if (items.length === 0) return null;

  type StyleMap = { wrap: string; header: string; iconCls: string; labelCls: string; badgeCls: string; };
  const styles: Record<string, StyleMap> = {
    success: {
      wrap:     "border-emerald-300 dark:border-emerald-700/60",
      header:   "bg-emerald-600 dark:bg-emerald-700 hover:bg-emerald-600/90 dark:hover:bg-emerald-700/90",
      iconCls:  "text-white",
      labelCls: "text-white",
      badgeCls: "bg-white/20 text-white",
    },
    info: {
      wrap:     "border-[hsl(var(--border))]",
      header:   "bg-[hsl(var(--muted))] hover:bg-[hsl(var(--muted))/70]",
      iconCls:  "text-blue-500",
      labelCls: "text-[hsl(var(--foreground))]",
      badgeCls: "bg-blue-100/80 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
    },
    warning: {
      wrap:     "border-amber-200 dark:border-amber-800/50",
      header:   "bg-amber-50 dark:bg-amber-950/25 hover:bg-amber-100/80 dark:hover:bg-amber-950/35",
      iconCls:  "text-amber-500",
      labelCls: "text-amber-900 dark:text-amber-200",
      badgeCls: "bg-amber-200/80 dark:bg-amber-800/60 text-amber-800 dark:text-amber-100",
    },
  };
  const s = styles[severity];
  const GroupIcon = severity === "success" ? CheckCircle : severity === "info" ? Info : Target;

  return (
    <div className={`rounded-2xl border overflow-hidden ${s.wrap}`}>
      <button onClick={onToggle}
        className={`w-full flex items-center justify-between px-5 py-4 transition-colors ${s.header}`}>
        <div className="flex items-center gap-3">
          <GroupIcon size={15} className={s.iconCls} />
          <span className={`font-semibold text-sm ${s.labelCls}`}>{label}</span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full tabular-nums ${s.badgeCls}`}>
            {items.length}
          </span>
        </div>
        <ChevronDown
          size={15}
          className={`${s.iconCls} transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="bg-[hsl(var(--background))]">
          {items.map((ins) => (
            <InsightCard key={ins.id} insight={ins} onApply={onApply} variant="row" />
          ))}
        </div>
      )}
    </div>
  );
}

// Module-level flag: resets on every app restart, never written to localStorage
let scoreIntroShownThisSession = false;

// ── Health Score Hero Card ────────────────────────────────────────────────────
function ScoreHeroCard({ score, scopeLabel, onOpen }: { score: HealthScore; scopeLabel?: string; onOpen: () => void }) {
  const comps = [
    { label: "Savings Rate",     s: score.components.savingsRate.score,     max: 40 },
    { label: "Budget Health",    s: score.components.budgetHealth.score,    max: 30 },
    { label: "Balance Runway",   s: score.components.balanceRunway.score,   max: 20 },
    { label: "Income Stability", s: score.components.incomeStability.score, max: 10 },
  ];
  return (
    <button
      onClick={onOpen}
      className="group w-full text-left border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow chart-clickable"
      style={{ borderColor: score.color + "40" }}
    >
      <div className="px-6 pt-5 pb-5" style={{ backgroundColor: score.color + "08" }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-2"
               style={{ color: score.color }}>{scopeLabel ?? "Financial Health Score"}</p>
            <div className="flex items-baseline gap-3">
              <span className="text-6xl font-black tabular-nums leading-none"
                    style={{ color: score.color }}><CountUp value={score.total} format={(v) => Math.round(v).toString()} /></span>
              <div className="flex flex-col">
                <span className="text-xl font-bold" style={{ color: score.color }}>{score.grade}</span>
                <span className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{score.label}</span>
              </div>
            </div>
          </div>
          <div className="shrink-0 p-1.5 rounded-full border mt-1 transition-all duration-200 group-hover:scale-110"
               style={{ borderColor: score.color + "50", color: score.color, backgroundColor: score.color + "00" }}
               onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = score.color + "18")}
               onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = score.color + "00")}
          >
            <HelpCircle size={14} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
          {comps.map(({ label, s, max }) => (
            <div key={label}>
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
                <span className="font-semibold" style={{ color: score.color }}>{s}/{max}</span>
              </div>
              <div className="h-1.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
                <div className="h-full rounded-full"
                     style={{ width: `${(s / max) * 100}%`, backgroundColor: score.color }} />
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-3.5 text-center">
          Tap to learn how this score is calculated
        </p>
      </div>
    </button>
  );
}

// ── Net Worth Card ────────────────────────────────────────────────────────────
function NetWorthCard({
  netWorth, history, investmentReturn, savingsRatePct,
}: {
  netWorth: NetWorthSnapshot;
  history: { month: string; netWorthCents: number; liquidCents: number; debtCents: number; investmentCents: number }[];
  investmentReturn: InvestmentReturn | null;
  savingsRatePct: number;
}) {
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const first = history[0]?.netWorthCents ?? netWorth.netWorthCents;
  const changeCents = netWorth.netWorthCents - first;
  const changePct = first !== 0 ? (changeCents / Math.abs(first)) * 100 : 0;
  const isGrowing = changeCents > 0;
  const isFlat = Math.abs(changeCents) < 100; // under $1 - treat as flat
  const selected = history.find((h) => h.month === selectedMonth) ?? null;

  return (
    <section className="border rounded-2xl overflow-hidden shadow-sm">
      <div className="px-6 pt-5 pb-5">
        <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-2">
              Net Worth
            </p>
            <p className={`text-4xl font-black tabular-nums ${netWorth.netWorthCents >= 0 ? "text-[hsl(var(--foreground))]" : "text-red-500"}`}>
              <CountUp value={netWorth.netWorthCents} format={(v) => formatCurrency(Math.round(v))} />
            </p>
          </div>
          {history.length >= 2 && !isFlat && (
            <div className={`flex items-center gap-1 text-sm font-semibold ${isGrowing ? "text-green-600" : "text-red-500"}`}>
              {isGrowing ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
              {formatCurrency(Math.abs(changeCents))} ({Math.abs(Math.round(changePct))}%) this year
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Liquid</p>
            <p className="text-sm font-bold">{formatCurrency(netWorth.liquidCents)}</p>
          </div>
          <div>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Investments</p>
            <p className="text-sm font-bold">{formatCurrency(netWorth.investmentCents)}</p>
          </div>
          <div>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide">Debt</p>
            <p className={`text-sm font-bold ${netWorth.debtCents < 0 ? "text-red-500" : ""}`}>{formatCurrency(netWorth.debtCents)}</p>
          </div>
        </div>

        {history.length >= 2 && (
          <>
            <div className="h-16 -mx-2 mb-1 chart-clickable rounded-lg">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={history}
                  margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
                  onClick={(state) => {
                    const label = state?.activeLabel as string | undefined;
                    if (label) setSelectedMonth((cur) => (cur === label ? null : label));
                  }}
                >
                  <defs>
                    <linearGradient id="netWorthGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip
                    formatter={(v) => [formatCurrency(v as number), "Net Worth"]}
                    labelFormatter={(l) => String(l)}
                    contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }}
                  />
                  <Area type="monotone" dataKey="netWorthCents" stroke="#6366f1" strokeWidth={2} fill="url(#netWorthGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[9px] text-[hsl(var(--muted-foreground))] text-center mb-3">
              Click a point on the chart for that month's breakdown
            </p>

            <AnimatePresence initial={false}>
              {selected && (
                <motion.div
                  key={selected.month}
                  layout
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-4 gap-3 text-center rounded-xl p-3 mb-4 bg-[hsl(var(--muted))]/40">
                    <div>
                      <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase">{selected.month}</p>
                      <p className="text-xs font-bold">{formatCurrency(selected.netWorthCents)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase">Liquid</p>
                      <p className="text-xs font-bold">{formatCurrency(selected.liquidCents)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase">Investments</p>
                      <p className="text-xs font-bold">{formatCurrency(selected.investmentCents)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-[hsl(var(--muted-foreground))] uppercase">Debt</p>
                      <p className={`text-xs font-bold ${selected.debtCents < 0 ? "text-red-500" : ""}`}>{formatCurrency(selected.debtCents)}</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        <div className="grid grid-cols-2 gap-4 pt-3 border-t">
          <div>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-0.5">Savings Rate</p>
            <p className={`text-lg font-bold ${savingsRatePct >= 20 ? "text-green-600" : savingsRatePct >= 10 ? "text-amber-500" : "text-red-500"}`}>
              {savingsRatePct}%
            </p>
          </div>
          <div>
            <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-wide mb-0.5">Investment Return</p>
            <p className="text-lg font-bold">
              {investmentReturn?.annualizedReturnPct !== null && investmentReturn?.annualizedReturnPct !== undefined
                ? `${investmentReturn.annualizedReturnPct >= 0 ? "+" : ""}${investmentReturn.annualizedReturnPct.toFixed(1)}%/yr`
                : investmentReturn?.absoluteReturnPct !== null && investmentReturn?.absoluteReturnPct !== undefined
                ? `${investmentReturn.absoluteReturnPct >= 0 ? "+" : ""}${investmentReturn.absoluteReturnPct.toFixed(1)}%`
                : "—"}
            </p>
            {investmentReturn?.hasCostBasis && investmentReturn.annualizedReturnPct === null && (
              <p className="text-[9px] text-[hsl(var(--muted-foreground))] mt-0.5">Absolute (needs trade dates to annualize)</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Health Score Intro Modal ──────────────────────────────────────────────────
function ScoreIntroModal({
  globalScore, profileScore, profileName, onClose,
}: {
  globalScore: HealthScore;
  profileScore: HealthScore | null;
  profileName: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"global" | "profile">("global");
  const score = tab === "global" ? globalScore : (profileScore ?? globalScore);

  const grades = [
    { g: "A", r: "85–100", l: "Excellent",       c: "#059669" },
    { g: "B", r: "70–84",  l: "Good",             c: "#2563eb" },
    { g: "C", r: "55–69",  l: "Building",         c: "#d97706" },
    { g: "D", r: "40–54",  l: "Developing",       c: "#ea580c" },
    { g: "—", r: "< 40",   l: "Getting Started",  c: "#6b7280" },
  ];
  const comps = [
    { label: "Savings Rate",     detail: "3-month avg net vs income",          s: score.components.savingsRate.score,     max: 40 },
    { label: "Budget Health",    detail: "% of budgets on track this month",    s: score.components.budgetHealth.score,    max: 30 },
    { label: "Balance Runway",   detail: "Months of expenses in account",       s: score.components.balanceRunway.score,   max: 20 },
    { label: "Income Stability", detail: "Variance across 6 months of income",  s: score.components.incomeStability.score, max: 10 },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6"
         style={{ backgroundColor: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
         onClick={onClose}>
      <div className="bg-[hsl(var(--background))] border rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>

        {/* Global / Profile tab toggle */}
        <div className="flex border-b">
          <button onClick={() => setTab("global")}
            className="flex-1 py-3 text-xs font-semibold transition-colors"
            style={{
              backgroundColor: tab === "global" ? "rgba(192,138,28,0.08)" : "transparent",
              color: tab === "global" ? "#C08A1C" : "hsl(var(--muted-foreground))",
              borderBottom: tab === "global" ? "2px solid #C08A1C" : "2px solid transparent",
            }}>
            🌐 Global
          </button>
          <button onClick={() => setTab("profile")}
            className="flex-1 py-3 text-xs font-semibold transition-colors"
            style={{
              backgroundColor: tab === "profile" ? "rgba(59,130,246,0.08)" : "transparent",
              color: tab === "profile" ? "#3b82f6" : "hsl(var(--muted-foreground))",
              borderBottom: tab === "profile" ? "2px solid #3b82f6" : "2px solid transparent",
            }}>
            👤 {profileName}
          </button>
        </div>

        {/* Score hero */}
        <div className="px-6 pt-6 pb-5 border-b text-center" style={{ backgroundColor: score.color + "0A" }}>
          <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: score.color }}>
            Financial Health Score
          </p>
          <div className="flex items-baseline justify-center gap-3 mb-1">
            <span className="text-7xl font-black tabular-nums" style={{ color: score.color }}>{score.total}</span>
            <div className="text-left">
              <div className="text-2xl font-bold" style={{ color: score.color }}>{score.grade}</div>
              <div className="text-sm text-[hsl(var(--muted-foreground))]">{score.label}</div>
            </div>
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
            {tab === "global"
              ? "All profiles aggregated · auto-computed each visit"
              : `${profileName}'s individual financial health`}
          </p>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
              Breakdown
            </p>
            {comps.map(({ label, detail, s, max }) => (
              <div key={label}>
                <div className="flex justify-between text-sm mb-0.5">
                  <span className="font-medium">{label}</span>
                  <span className="text-[hsl(var(--muted-foreground))] tabular-nums">{s} / {max} pts</span>
                </div>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mb-1">{detail}</p>
                <div className="h-2 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
                  <div className="h-full rounded-full"
                       style={{ width: `${(s / max) * 100}%`, backgroundColor: score.color, transition: "width 0.35s ease" }} />
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
              Grade Scale
            </p>
            {grades.map(({ g, r, l, c }) => (
              <div key={g} className="flex items-center gap-3 text-sm">
                <span className="font-bold w-5 shrink-0" style={{ color: c }}>{g}</span>
                <span className="text-[hsl(var(--muted-foreground))] w-16 shrink-0 tabular-nums text-xs">{r}</span>
                <span className="font-medium" style={{ color: c }}>{l}</span>
              </div>
            ))}
          </div>
          <button onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: score.color }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AgentPage() {
  const navigate = useNavigate();
  const { activeProfile, profiles, unlockedIds, unlockProfile, dismissedInsights, clearDismissed } = useProfileStore();
  const profileId = activeProfile?.id ?? 1;

  const [viewMode, setViewMode] = useState<"profile" | "global">(() => {
    const saved = localStorage.getItem(viewKey(activeProfile?.id ?? 1));
    return saved === "global" ? "global" : "profile";
  });
  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);

  const [loading, setLoading]                   = useState(true);
  const [insights, setInsights]                 = useState<Insight[]>([]);
  const [globalHealthScore, setGlobalHealthScore] = useState<HealthScore | null>(null);
  const [profileHealthScore, setProfileHealthScore] = useState<HealthScore | null>(null);
  const [savingsHistory, setSavingsHistory]     = useState<{ month: string; rate: number; net: number }[]>([]);
  const [spendingProfile, setSpendingProfile]   = useState<Awaited<ReturnType<typeof getSpendingProfile>>>(null);
  const [subscriptions, setSubscriptions]       = useState<SubItem[]>([]);
  const [catDeltas, setCatDeltas]               = useState<CatDelta[]>([]);
  const [hasEnoughData, setHasEnoughData]       = useState(true);
  const [refreshedAt, setRefreshedAt]           = useState<Date | null>(null);
  const [netWorth, setNetWorth]                 = useState<NetWorthSnapshot | null>(null);
  const [netWorthHistory, setNetWorthHistory]   = useState<{ month: string; netWorthCents: number; liquidCents: number; debtCents: number; investmentCents: number }[]>([]);
  const [investmentReturn, setInvestmentReturn] = useState<InvestmentReturn | null>(null);
  const [creditScore, setCreditScore]           = useState<CreditCardHealthScore | null>(null);
  const [investmentScore, setInvestmentScore]   = useState<InvestmentHealthScore | null>(null);
  const [topRoi, setTopRoi]                     = useState<Partial<Record<SecurityType, TopRoiHolding[]>>>({});

  const [sectExpanded, setSectExpanded] = useState<{ trends: boolean; subs: boolean; topRoi: boolean }>(() => {
    try { const s = localStorage.getItem("compass_insight_sections"); return s ? JSON.parse(s) : { trends: false, subs: false, topRoi: false }; }
    catch { return { trends: false, subs: false, topRoi: false }; }
  });
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(loadGroupState);
  const didSetDefaults = useRef(false);
  const [showScoreIntro, setShowScoreIntro] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(viewKey(profileId));
    setViewMode(saved === "global" ? "global" : "profile");
  }, [profileId]);

  // Score intro: once per app session (shows tabbed global+profile modal)
  useEffect(() => {
    if (globalHealthScore && !scoreIntroShownThisSession) {
      scoreIntroShownThisSession = true;
      setShowScoreIntro(true);
    }
  }, [globalHealthScore]);

  const unlockedProfileIds = useMemo(
    () => profiles.filter((p) => !p.pin_hash || p.id === profileId || unlockedIds.has(p.id)).map((p) => p.id),
    [profiles, profileId, unlockedIds]
  );

  const handleSwitchToGlobal = () => {
    const locked = profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id));
    if (locked.length > 0) { setPinQueue(locked); setPinQueueIdx(0); }
    else { localStorage.setItem(viewKey(profileId), "global"); setViewMode("global"); }
  };
  const handleSwitchToProfile = () => { localStorage.setItem(viewKey(profileId), "profile"); setViewMode("profile"); };
  const advancePinQueue = (unlockedId?: number) => {
    if (unlockedId !== undefined) unlockProfile(unlockedId);
    const next = pinQueueIdx + 1;
    if (next >= pinQueue.length) {
      setPinQueue([]); setPinQueueIdx(0);
      localStorage.setItem(viewKey(profileId), "global"); setViewMode("global");
    } else { setPinQueueIdx(next); }
  };

  const toggleSection = useCallback((k: "trends" | "subs" | "topRoi") => {
    setSectExpanded((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      localStorage.setItem("compass_insight_sections", JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleGroup = useCallback((k: string) => {
    setGroupOpen((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      localStorage.setItem("compass_insight_groups", JSON.stringify(next));
      return next;
    });
  }, []);

  // Adaptive defaults — open the right group after first data load
  useEffect(() => {
    if (insights.length === 0 || didSetDefaults.current) return;
    if (localStorage.getItem("compass_insight_groups")) return; // user has custom state
    didSetDefaults.current = true;
    const visible = insights.filter((i) => !dismissedInsights.includes(i.dismissKey));
    const wins = visible.filter((i) => i.severity === "success").length;
    const obs  = visible.filter((i) => i.severity === "info").length;
    setGroupOpen({ success: wins > 0, info: wins === 0 && obs > 0, warning: wins === 0 && obs === 0 });
  }, [insights, dismissedInsights]);

  const pinTarget = pinQueue.length > 0 && pinQueueIdx < pinQueue.length ? pinQueue[pinQueueIdx] : null;
  const lockedExcluded = viewMode === "global"
    ? profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id)) : [];

  useEffect(() => {
    if (!activeProfile) return;
    let cancelled = false;
    const ids = viewMode === "global" ? (unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId]) : [profileId];

    async function load() {
      setLoading(true);
      const db = await getDb();
      const ph = ids.map(() => "?").join(",");

      const [allInsights, history, profile, globalScore, profileScore, nw, nwHistory, invReturn, topRoiHoldings, ccScore, invHealthScore] = await Promise.all([
        generateInsights(ids),
        getSavingsHistory(ids, 12),
        getSpendingProfile(ids),
        computeHealthScore(unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId]), // always global
        computeHealthScore([profileId]),  // always this profile only
        computeNetWorth(ids),
        getNetWorthHistory(ids, 12),
        computeInvestmentReturn(ids),
        getTopRoiHoldings(ids, 3),
        computeCreditCardHealthScore(ids),
        computeInvestmentHealthScore(ids),
      ]);
      if (cancelled) return;

      if (!profile || history.length < 2) { setHasEnoughData(false); setLoading(false); return; }
      setHasEnoughData(true);
      setInsights(allInsights);
      setSavingsHistory(history);
      setSpendingProfile(profile);
      setGlobalHealthScore(globalScore);
      setProfileHealthScore(profileScore);
      setNetWorth(nw);
      setNetWorthHistory(nwHistory);
      setInvestmentReturn(invReturn);
      setTopRoi(topRoiHoldings);
      setCreditScore(ccScore);
      setInvestmentScore(invHealthScore);

      const thisMonth = currentYM();
      const lMonth = prevYM(thisMonth);
      const [ts, te] = monthBounds(thisMonth);
      const [ls, le] = monthBounds(lMonth);

      const [subs, thisCats, lastCats] = await Promise.all([
        db.select<SubItem[]>(
          `SELECT t.description, t.amount_cents,
                  COUNT(DISTINCT strftime('%Y-%m', t.date)) as month_count,
                  c.name as category_name, c.color as category_color
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.profile_id IN (${ph}) AND t.amount_cents<0
             AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.description, t.amount_cents HAVING month_count>=2
           ORDER BY month_count DESC, ABS(t.amount_cents) DESC LIMIT 10`,
          [...ids]
        ),
        db.select<{ category_id: number; category_name: string; category_color: string; total: number }[]>(
          `SELECT t.category_id, c.name as category_name, c.color as category_color,
                  SUM(ABS(t.amount_cents)) as total
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND t.amount_cents<0
             AND t.category_id!=15 AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.category_id ORDER BY total DESC LIMIT 8`,
          [...ids, ts, te]
        ),
        db.select<{ category_id: number; total: number }[]>(
          `SELECT category_id, SUM(ABS(amount_cents)) as total
           FROM transactions
           WHERE profile_id IN (${ph}) AND date>=? AND date<? AND amount_cents<0
             AND (category_id IS NULL OR category_id != 20)
           GROUP BY category_id`,
          [...ids, ls, le]
        ),
      ]);
      if (cancelled) return;
      setSubscriptions(subs);
      const lastMap = new Map(lastCats.map((c) => [c.category_id, c.total]));
      setCatDeltas(thisCats.map((c) => ({
        category_name: c.category_name, category_color: c.category_color,
        this_month: c.total, last_month: lastMap.get(c.category_id) ?? 0,
        delta_pct: (lastMap.get(c.category_id) ?? 0) > 0
          ? Math.round(((c.total - (lastMap.get(c.category_id) ?? 0)) / (lastMap.get(c.category_id) ?? 1)) * 100)
          : 100,
      })));
      setRefreshedAt(new Date());
      setLoading(false);
    }
    load().catch(console.error);
    return () => { cancelled = true; };
  }, [profileId, activeProfile, viewMode, unlockedProfileIds]);

  const visibleInsights  = insights.filter((i) => !dismissedInsights.includes(i.dismissKey));
  const successInsights  = visibleInsights.filter((i) => i.severity === "success");
  const infoInsights     = visibleInsights.filter((i) => i.severity === "info");
  const warningInsights  = visibleInsights.filter((i) => i.severity === "warning");

  const handleApply = (insight: Insight) => {
    if (!insight.action) return;
    if (insight.action.type === "create_budget") navigate("/budgets", { state: { prefillBudget: insight.action.payload } });
    else navigate("/goals");
  };

  const avgSavingsRatePct = spendingProfile ? Math.round(spendingProfile.avgSavingsRate * 100) : 0;
  const totalSubCost = subscriptions.reduce((s, r) => s + Math.abs(r.amount_cents), 0);
  const annualSubCost = totalSubCost * 12;

  // ── Shared sticky header ─────────────────────────────────────────────────
  const PageHeader = (
    <div className="sticky top-0 z-20 border-b px-8 py-4 flex items-center justify-between gap-6"
      style={{ backgroundColor: "hsl(var(--background))", backdropFilter: "blur(8px)" }}>
      <div className="flex items-center gap-3 min-w-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Insights</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            {refreshedAt
              ? `Updated ${refreshedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Rule-based analysis of your financial habits."}
          </p>
        </div>
        {globalHealthScore && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full shrink-0 cursor-pointer"
            onClick={() => setShowScoreIntro(true)}
            style={{
              backgroundColor: (viewMode === "global" ? globalHealthScore : (profileHealthScore ?? globalHealthScore)).color + "20",
              border: `1px solid ${(viewMode === "global" ? globalHealthScore : (profileHealthScore ?? globalHealthScore)).color}50`,
            }}>
            <span className="text-xs font-bold tabular-nums"
              style={{ color: (viewMode === "global" ? globalHealthScore : (profileHealthScore ?? globalHealthScore)).color }}>
              {(viewMode === "global" ? globalHealthScore : (profileHealthScore ?? globalHealthScore)).total}
            </span>
            <span className="text-xs font-semibold"
              style={{ color: (viewMode === "global" ? globalHealthScore : (profileHealthScore ?? globalHealthScore)).color }}>
              · {(viewMode === "global" ? globalHealthScore : (profileHealthScore ?? globalHealthScore)).label}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-semibold select-none"
          style={{ color: viewMode !== "profile" ? "hsl(var(--muted-foreground))" : "#3b82f6", transition: "color 0.3s" }}>
          Profile
        </span>
        <ScopeToggle isGlobal={viewMode === "global"}
          onToggle={() => viewMode === "global" ? handleSwitchToProfile() : handleSwitchToGlobal()} />
        <span className="text-sm font-semibold select-none"
          style={{ color: viewMode === "global" ? "#C08A1C" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
          Global
        </span>
      </div>
    </div>
  );

  if (loading) {
    return (
      <>
        {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
        {PageHeader}
        <div className="flex items-center justify-center py-24">
          <div className="flex flex-col items-center gap-3 text-[hsl(var(--muted-foreground))]">
            <div className="w-8 h-8 rounded-full border-2 border-current animate-spin" style={{ borderTopColor: "transparent" }} />
            <p className="text-sm">Analysing your data...</p>
          </div>
        </div>
      </>
    );
  }

  if (!hasEnoughData) {
    return (
      <>
        {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
        {PageHeader}
        <div className="p-8 max-w-xl mx-auto">
          <div className="border-2 border-dashed rounded-2xl p-16 text-center mt-8">
            <p className="text-4xl mb-4">📊</p>
            <p className="font-semibold text-lg mb-2">Not enough data yet</p>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
              Import at least 2 months of transactions to unlock insights, the health score, and trend analysis.
            </p>
            <Link to="/import"
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium">
              Import Transactions
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
      {showScoreIntro && globalHealthScore && (
        <ScoreIntroModal
          globalScore={globalHealthScore}
          profileScore={profileHealthScore}
          profileName={activeProfile?.name ?? "Profile"}
          onClose={() => setShowScoreIntro(false)}
        />
      )}
      {PageHeader}

      <div className="p-6 max-w-3xl space-y-6 mx-auto w-full">

        {/* Locked-profile notice */}
        {lockedExcluded.length > 0 && (
          <div className="rounded-2xl px-5 py-3 flex flex-col gap-2"
            style={{ border: "1px solid rgba(245,158,11,0.35)", backgroundColor: "rgba(245,158,11,0.07)" }}>
            <p className="text-sm font-semibold" style={{ color: "#b45309" }}>
              {lockedExcluded.length === 1 ? "1 profile is PIN-locked" : `${lockedExcluded.length} profiles are PIN-locked`}
              {" "}— their data is excluded from global insights.
            </p>
            <div className="flex flex-wrap gap-2">
              {lockedExcluded.map((p) => (
                <button key={p.id} onClick={() => { setPinQueue([p]); setPinQueueIdx(0); }}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{ border: "1px solid rgba(245,158,11,0.5)", color: "#92400e" }}>
                  🔒 Unlock {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Global mode chip */}
        {viewMode === "global" && lockedExcluded.length === 0 && (
          <div className="rounded-2xl px-5 py-2.5 flex items-center gap-3"
            style={{ border: "1px solid rgba(192,138,28,0.35)", backgroundColor: "rgba(192,138,28,0.07)" }}>
            <span className="font-semibold text-sm" style={{ color: "#C08A1C" }}>Global view</span>
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              — insights and data aggregated across {profiles.length} profile{profiles.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}

        {/* ── Score Hero ── */}
        {(viewMode === "global" ? globalHealthScore : profileHealthScore) && (
          <ScoreHeroCard
            score={(viewMode === "global" ? globalHealthScore : profileHealthScore)!}
            scopeLabel={viewMode === "global"
              ? "Global Health Score"
              : `${activeProfile?.name ?? "Profile"} Score`}
            onOpen={() => setShowScoreIntro(true)}
          />
        )}

        {/* ── Net Worth ── */}
        {netWorth && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
            <NetWorthCard
              netWorth={netWorth}
              history={netWorthHistory}
              investmentReturn={investmentReturn}
              savingsRatePct={avgSavingsRatePct}
            />
          </motion.div>
        )}

        {/* ── Credit Card Health / Investment Health ── */}
        {(creditScore?.hasData || investmentScore?.hasData) && (
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.06 }}
            className="grid grid-cols-2 gap-3"
          >
            <MiniScoreCard
              label="Credit Card Health"
              score={creditScore}
              infoText="Scored against the average American's ~$6,000 credit card balance, with a small bonus or penalty depending on whether your balance shrank or grew this month."
            />
            <MiniScoreCard
              label="Investment Health"
              score={investmentScore}
              infoText="Scored against the long-run ~7%/yr average U.S. stock market return, adjusted for inflation."
            />
          </motion.div>
        )}

        {/* ── Top Performers ── */}
        {Object.keys(topRoi).length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.12 }}>
            <CollapsibleSection title="Top Performers" subtitle="highest ROI per section"
              expanded={sectExpanded.topRoi} onToggle={() => toggleSection("topRoi")}>
              <div className="divide-y">
                {ROI_SECTION_ORDER.filter((t) => (topRoi[t]?.length ?? 0) > 0).map((type) => (
                  <div key={type} className="px-5 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-2">
                      {ROI_SECTION_LABELS[type]}
                    </p>
                    <div className="space-y-1.5">
                      {topRoi[type]!.map((h) => (
                        <div key={`${type}-${h.symbol ?? h.description}`} className="flex items-center justify-between gap-3 text-sm">
                          <span className="truncate flex-1">{h.symbol ?? h.description}</span>
                          <span className={`font-mono font-semibold flex items-center gap-1 shrink-0 ${h.roiPct >= 0 ? "text-green-600" : "text-red-500"}`}>
                            {h.roiPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                            {h.roiPct >= 0 ? "+" : ""}{h.roiPct.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          </motion.div>
        )}

        {/* ── KPI Strip ── */}
        {spendingProfile && (
          <section className="border rounded-2xl overflow-hidden shadow-sm">
            <div className="flex divide-x">
              {[
                {
                  label: "Avg Monthly Income",
                  value: formatCurrency(spendingProfile.avgMonthlyIncome),
                  color: "text-green-600",
                  sub: null,
                },
                {
                  label: "Avg Monthly Spend",
                  value: formatCurrency(spendingProfile.avgMonthlyExpenses),
                  color: "text-red-500",
                  sub: null,
                },
                {
                  label: "Avg Savings Rate",
                  value: `${avgSavingsRatePct}%`,
                  color: avgSavingsRatePct >= 20 ? "text-green-600" : avgSavingsRatePct >= 10 ? "text-amber-500" : "text-red-500",
                  sub: avgSavingsRatePct >= 20 ? "Healthy" : avgSavingsRatePct >= 10 ? "Building" : "Below target",
                },
                {
                  label: "Top Category",
                  value: spendingProfile.topCategory,
                  color: "text-[hsl(var(--foreground))]",
                  sub: null,
                },
              ].map(({ label, value, color, sub }) => (
                <div key={label} className="flex-1 px-6 py-6">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-2">
                    {label}
                  </p>
                  <p className={`text-xl font-bold tabular-nums ${color}`}>{value}</p>
                  {sub && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{sub}</p>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Savings Rate Sparkline ── */}
        {savingsHistory.length >= 2 && (
          <section className="border rounded-2xl overflow-hidden">
            <div className="px-6 pt-5 pb-0 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
                Savings Rate · 12 months
              </p>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))]">— 20% target</p>
            </div>
            <ResponsiveContainer width="100%" height={110}>
              <AreaChart data={savingsHistory} margin={{ left: 0, right: 20, top: 8, bottom: 4 }}>
                <defs>
                  <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="month" tick={{ fontSize: 9 }} tickFormatter={(v: string) => v.slice(5)}
                       axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => `${v}%`} width={30}
                       axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v) => [`${v ?? 0}%`, "Rate"]}
                  contentStyle={{
                    backgroundColor: "hsl(var(--background))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "6px", fontSize: "11px",
                  }}
                />
                <ReferenceLine y={20} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.6} />
                <Area type="monotone" dataKey="rate" stroke="#6366f1" strokeWidth={2}
                      fill="url(#sparkGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </section>
        )}

        {/* ── Spotlight ── */}
        {(() => {
          const SPOTLIGHT_WINS    = new Set(["positive_streak", "most_improved"]);
          const SPOTLIGHT_ACTIONS = new Set(["savings_rate_low", "spending_velocity", "emergency_fund_runway"]);
          const spotWin    = successInsights.find((i) => SPOTLIGHT_WINS.has(i.type)    && !!i.richData);
          const spotAction = [...warningInsights, ...infoInsights]
            .find((i) => SPOTLIGHT_ACTIONS.has(i.type) && !!i.richData);
          const cards = [spotWin, spotAction].filter(Boolean) as typeof visibleInsights;
          if (cards.length === 0) return null;
          return (
            <section className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
                Spotlight
              </p>
              <div className={`grid gap-3 ${cards.length > 1 ? "sm:grid-cols-2" : ""}`}>
                {cards.map((ins) => (
                  <SpotlightCard key={ins.id} insight={ins} onApply={handleApply} />
                ))}
              </div>
            </section>
          );
        })()}

        {/* ── Insights section ── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
              Insights
            </p>
            {dismissedInsights.length > 0 && (
              <button onClick={clearDismissed}
                className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors">
                Restore {dismissedInsights.length} dismissed
              </button>
            )}
          </div>

          {visibleInsights.length === 0 && (
            <div className="border-2 border-dashed border-emerald-200 dark:border-emerald-900/60 rounded-2xl py-14 text-center">
              <p className="text-4xl mb-3">🎉</p>
              <p className="font-semibold text-base text-emerald-700 dark:text-emerald-400">All clear!</p>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1.5">
                No active insights — your finances are looking healthy.
              </p>
            </div>
          )}

          {/* Wins first — positive reinforcement anchor */}
          <InsightGroup label="Wins" severity="success"
            items={successInsights} onApply={handleApply}
            open={!!groupOpen.success} onToggle={() => toggleGroup("success")} />

          {/* Observations — neutral information */}
          <InsightGroup label="Observations" severity="info"
            items={infoInsights} onApply={handleApply}
            open={!!groupOpen.info} onToggle={() => toggleGroup("info")} />

          {/* Action Items — constructive, not alarming */}
          <InsightGroup label="Action Items" severity="warning"
            items={warningInsights} onApply={handleApply}
            open={!!groupOpen.warning} onToggle={() => toggleGroup("warning")} />
        </section>

        {/* ── Category Trends ── */}
        {catDeltas.length > 0 && (
          <CollapsibleSection title="Category Trends" subtitle="this vs last month"
            expanded={sectExpanded.trends} onToggle={() => toggleSection("trends")}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))]">Category</th>
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">This month</th>
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Last month</th>
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {catDeltas.map((r) => (
                  <tr key={r.category_name} className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: r.category_color }} />
                        {r.category_name}
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono">{formatCurrency(r.this_month)}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {r.last_month > 0 ? formatCurrency(r.last_month) : "—"}
                    </td>
                    <td className={`px-5 py-2.5 text-right font-semibold ${
                      r.last_month === 0 ? "text-[hsl(var(--muted-foreground))]"
                      : r.delta_pct > 0  ? "text-red-500" : "text-green-600"}`}>
                      {r.last_month === 0 ? "New" : `${r.delta_pct > 0 ? "+" : ""}${r.delta_pct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsibleSection>
        )}

        {/* ── Subscription Inventory ── */}
        {subscriptions.length > 0 && (
          <CollapsibleSection title="Subscription Inventory"
            subtitle={`~${formatCurrency(annualSubCost)}/year`}
            expanded={sectExpanded.subs} onToggle={() => toggleSection("subs")}>
            <table className="w-full text-sm">
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={`${s.description}_${s.amount_cents}`}
                    className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                    <td className="px-5 py-2.5 max-w-xs truncate">{s.description}</td>
                    <td className="px-5 py-2.5">
                      <span className="text-xs px-2 py-0.5 rounded-full text-white"
                        style={{ backgroundColor: s.category_color ?? "#9ca3af" }}>
                        {s.category_name ?? "Uncategorized"}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-[hsl(var(--muted-foreground))]">{s.month_count} months</td>
                    <td className="px-5 py-2.5 text-right font-mono text-red-500">
                      {formatCurrency(Math.abs(s.amount_cents))}/mo
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-5 py-3 border-t text-xs text-[hsl(var(--muted-foreground))]">
              {formatCurrency(totalSubCost)}/month · {formatCurrency(annualSubCost)}/year
            </div>
          </CollapsibleSection>
        )}

        <div className="h-6" />
      </div>
    </>
  );
}
