import ScopeToggle from "@/components/ScopeToggle";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CaretDownIcon, CaretRightIcon, CheckCircleIcon, TargetIcon, InfoIcon, QuestionIcon, TrendUpIcon, TrendDownIcon,
  SlidersHorizontalIcon, EyeSlashIcon, GlobeIcon, UserIcon,
} from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { getDb, getAccountsSummaryForProfile, setAccountExcludedFromInsights, getLoanAccountsForProfile, getCreditAccountsForProfile, getLoanBalanceHistory, type AccountSummary, type LoanAccount } from "@/lib/db";
import { categorySpendSql } from "@/lib/reportingSql";
import { formatCurrency, formatCurrencyWhole, formatMonthLabel } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import { handleLoadFailure, toast } from "@/stores/toastStore";
import { hideCharge, unhideCharge, listHiddenCharges, clearHiddenCharges } from "@/lib/hiddenCharges";
import {
  generateInsights, getSpendingProfile, getSavingsHistory, computeHealthScore, computeCreditCardHealthScore, detectRecurringCharges,
} from "@/lib/agent";
import {
  computeNetWorth, getNetWorthHistory, computeInvestmentReturn, computeInvestmentHealthScore, getTopRoiHoldings,
  type NetWorthSnapshot, type InvestmentReturn, type TopRoiHolding,
} from "@/lib/netWorth";
import { getFixedFlexibleInputs } from "@/lib/forecastData";
import { summarizeFixedFlexible, monthsWithIncome, type FixedFlexibleSummary } from "@/lib/insights/shape";
import { resolveInsightAction } from "@/lib/insightActions";
import { gradeTint, scoreGrade } from "@/lib/benchmarks";
import { series, chartTooltipStyle, chartTooltipText, chartTooltipWrapper, axisTick, harmonizeColor } from "@/lib/chartTheme";
import { useIsDark } from "@/hooks/useIsDark";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import { staggerContainer, riseIn } from "@/lib/motionPresets";
import type { Insight, Profile, HealthScore, SecurityType, CreditCardHealthScore, InvestmentHealthScore, RecurringCharge } from "@/lib/types";
import InsightCard from "@/components/InsightCard";
import { hasDetail } from "@/components/InsightDetail";
import InfoTooltip from "@/components/InfoTooltip";
import ClickHint from "@/components/ClickHint";
import CountUp from "@/components/CountUp";
import TrendChip from "@/components/TrendChip";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import PinModal from "@/components/PinModal";
import DebtPayoffModal from "@/components/DebtPayoffModal";
import MilestoneCelebration from "@/components/MilestoneCelebration";
import LockedProfilesNotice from "@/components/LockedProfilesNotice";
import FixedFlexibleBar from "@/components/FixedFlexibleBar";
import CostOfMoney from "@/components/CostOfMoney";
import { getCostOfMoneyInputs } from "@/lib/costOfMoneyData";
import { summarizeCostOfMoney, ASSUMED_YIELD_KEY, DEFAULT_ASSUMED_YIELD_BPS, type CostOfMoneyInputs } from "@/lib/costOfMoney";
import { detectNewMilestones } from "@/lib/milestones";
import { useMilestoneQueue } from "@/hooks/useMilestoneQueue";
import { CardListSkeleton } from "@/components/Skeleton";

const ROI_SECTION_LABELS: Record<SecurityType, string> = {
  stock: "Stocks", etf: "ETFs", mutual_fund: "Mutual funds", cash: "Cash", other: "Other",
};
const ROI_SECTION_ORDER: SecurityType[] = ["stock", "etf", "mutual_fund", "other", "cash"];

/** Small standalone benchmark-based score card (Credit Card Health / Investment Health). */
function MiniScoreCard({
  label, score, infoText, onClick,
}: {
  label: string;
  score: CreditCardHealthScore | InvestmentHealthScore | null;
  infoText: string;
  onClick?: () => void;
}) {
  if (!score || !score.hasData) {
    return (
      <div className="border rounded-2xl p-4 flex flex-col justify-center text-center min-h-[104px]">
        <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">{label}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">No data yet</p>
      </div>
    );
  }
  const inner = (
    <>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-medium" style={{ color: score.color }}>{label}</p>
        <InfoTooltip text={infoText} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[26px] leading-none font-medium tabular-nums" style={{ color: score.color }}>
          <CountUp value={score.score} format={(v) => Math.round(v).toString()} />
        </span>
        {score.grade !== "—" && <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">{score.grade}</span>}
      </div>
      <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1.5 leading-snug">{score.detail}</p>
      {onClick && (
        <p className="text-[11px] font-medium mt-2 text-[hsl(var(--gold-ink))]">See your payoff plan</p>
      )}
      {onClick && <ClickHint />}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="border rounded-2xl p-4 text-left cursor-pointer hover:shadow-md transition-shadow chart-clickable w-full">
      {inner}
    </button>
  ) : (
    <div className="border rounded-2xl p-4">{inner}</div>
  );
}

interface CatDelta {
  category_name: string;
  category_color: string;
  this_month: number;
  last_month: number;
  avg_3: number;
  delta_cents: number;
  delta_pct: number | null;
}

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const next = new Date(y, m, 1);
  return [`${y}-${String(m).padStart(2, "0")}-01`, `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`];
}
function prevYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLong(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(y, m - 1, 1));
}
function viewKey(profileId: number) { return `compass_insight_view_${profileId}`; }

function loadGroupState(): Record<string, boolean> {
  try {
    const s = localStorage.getItem("compass_insight_groups");
    return s ? JSON.parse(s) : {};
  } catch { return {}; }
}

// ── Insights account-exclusion dropdown (sits next to the Profile/Global scope toggle) ────────
interface InsightsExcludeDropdownProps {
  profileIds: number[];
  profileNames: Map<number, string>;
  onChanged: () => void;
}
function InsightsExcludeDropdown({ profileIds, profileNames, onChanged }: InsightsExcludeDropdownProps) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [accountProfile, setAccountProfile] = useState<Map<number, number>>(new Map());
  const { onBackdropClick } = useModalDismiss(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    (async () => {
      const lists = await Promise.all(profileIds.map((id) => getAccountsSummaryForProfile(id)));
      const merged: AccountSummary[] = [];
      const ownerMap = new Map<number, number>();
      lists.forEach((list, i) => list.forEach((a) => { merged.push(a); ownerMap.set(a.id, profileIds[i]); }));
      setAccounts(merged);
      setAccountProfile(ownerMap);
    })().catch(console.error);
  }, [open, profileIds]);

  const toggleAccount = async (a: AccountSummary) => {
    const next = !a.excluded_from_insights;
    await setAccountExcludedFromInsights(a.id, next);
    setAccounts((prev) => prev.map((x) => (x.id === a.id ? { ...x, excluded_from_insights: next } : x)));
    onChanged();
  };

  const excludedCount = accounts.filter((a) => a.excluded_from_insights).length;
  const showProfileName = profileIds.length > 1;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Exclude accounts from Insights"
        className="flex items-center gap-1 text-xs px-2 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))] transition-colors"
      >
        <SlidersHorizontalIcon size={13} />
        {excludedCount > 0 && <span className="font-semibold">{excludedCount}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={onBackdropClick} />
          <div className="absolute right-0 top-full mt-2 z-50 w-72 border rounded-xl bg-[hsl(var(--surface-raised))] shadow-xl p-3">
            <p className="text-xs font-semibold mb-1">Exclude from Insights</p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mb-2">
              Excluded accounts are skipped in savings rate, health score, and spending insights.
              They still show normally on the Dashboard and Overview.
            </p>
            {accounts.length === 0 ? (
              <p className="text-xs text-[hsl(var(--muted-foreground))] py-1">No accounts yet.</p>
            ) : (
              <div className="space-y-0.5 max-h-64 overflow-y-auto">
                {accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-xs px-1.5 py-1.5 rounded-lg hover:bg-[hsl(var(--muted))] cursor-pointer">
                    <input type="checkbox" checked={a.excluded_from_insights} onChange={() => toggleAccount(a)} className="shrink-0" />
                    <span className="flex-1 truncate">
                      {a.name}
                      {showProfileName && (
                        <span className="text-[hsl(var(--muted-foreground))]">
                          {" "}({profileNames.get(accountProfile.get(a.id) ?? -1) ?? ""})
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
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
        aria-expanded={expanded}
        className="w-full px-5 py-4 bg-[hsl(var(--muted))] flex items-center justify-between
                   hover:bg-[hsl(var(--muted))/80] transition-colors text-left">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm">{title}</span>
          {subtitle && <span className="text-xs text-[hsl(var(--muted-foreground))]">{subtitle}</span>}
        </div>
        {expanded ? <CaretDownIcon size={15} /> : <CaretRightIcon size={15} />}
      </button>
      {expanded && children}
    </section>
  );
}

// ── Insight severity accordion ────────────────────────────────────────────────
const GROUP_PAGE = 6;

interface InsightGroupProps {
  label: string;
  severity: "warning" | "info" | "success";
  items: Insight[];
  onApply: (i: Insight) => void;
  open: boolean;
  onToggle: () => void;
}
function InsightGroup({ label, severity, items, onApply, open, onToggle }: InsightGroupProps) {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;

  type StyleMap = { iconWrap: string; chevronCls: string; badgeCls: string; };
  const styles: Record<string, StyleMap> = {
    success: {
      iconWrap:   "bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]",
      chevronCls: "text-[hsl(var(--success)/0.8)]",
      badgeCls:   "bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]",
    },
    info: {
      iconWrap:   "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--gold-ink))]",
      chevronCls: "text-[hsl(var(--primary)/0.8)]",
      badgeCls:   "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--gold-ink))]",
    },
    warning: {
      iconWrap:   "bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]",
      chevronCls: "text-[hsl(var(--warning)/0.8)]",
      badgeCls:   "bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]",
    },
  };
  const s = styles[severity];
  const GroupIcon = severity === "success" ? CheckCircleIcon : severity === "info" ? InfoIcon : TargetIcon;
  const atStake = severity === "warning" ? items.reduce((sum, i) => sum + Math.abs(i.impactCents ?? 0), 0) : 0;
  const visible = showAll ? items : items.slice(0, GROUP_PAGE);
  // The top-ranked problem opens on arrival; nothing else auto-opens.
  const firstWithDetail = severity === "warning" ? items.findIndex((i) => hasDetail(i)) : -1;

  return (
    <div className="border-t overflow-hidden">
      <button onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between py-4 transition-colors
                   hover:bg-[hsl(var(--muted))/40]">
        <div className="flex items-center gap-3">
          <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${s.iconWrap}`}>
            <GroupIcon size={14} />
          </span>
          <span className="font-semibold text-sm tracking-tight text-[hsl(var(--foreground))]">{label}</span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full tabular-nums ${s.badgeCls}`}>
            {items.length}
          </span>
        </div>
        <span className="flex items-center">
          {atStake > 0 && <span className="insight-group-sum">{formatCurrencyWhole(atStake)} at stake</span>}
          <CaretDownIcon
            size={15}
            className={`${s.chevronCls} transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="pb-3 border-t border-[hsl(var(--border))]/50">
          {visible.map((insight, i) => (
            <InsightCard key={insight.id} insight={insight} onApply={onApply} variant="row" defaultExpanded={i === firstWithDetail} />
          ))}
          {items.length > GROUP_PAGE && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-xs text-[hsl(var(--gold-ink))] hover:underline">
              {showAll ? "Show fewer" : `Show ${items.length - GROUP_PAGE} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}


// ── Health Score Hero Card ────────────────────────────────────────────────────
function ScoreHeroCard({ score, scopeLabel, onOpen }: { score: HealthScore; scopeLabel?: string; onOpen: () => void }) {
  const comps = [
    { label: "Savings rate",     s: score.components.savingsRate.score,     max: 40 },
    { label: "Budget health",    s: score.components.budgetHealth.score,    max: 30 },
    { label: "Balance runway",   s: score.components.balanceRunway.score,   max: 20 },
    { label: "Income stability", s: score.components.incomeStability.score, max: 10 },
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full text-left border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow chart-clickable"
    >
      <div className="px-6 pt-5 pb-5" style={{ backgroundColor: gradeTint(score.tone, 0.05) }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-xs font-medium mb-2" style={{ color: score.color }}>{scopeLabel ?? "Financial health score"}</p>
            <div className="flex items-baseline gap-3">
              <span className="text-[40px] font-medium tabular-nums leading-none" style={{ color: score.color }}>
                <CountUp value={score.total} format={(v) => Math.round(v).toString()} />
              </span>
              <div className="flex flex-col">
                {score.grade !== "—" && <span className="text-xl font-semibold" style={{ color: score.color }}>{score.grade}</span>}
                <span className="text-sm font-medium text-[hsl(var(--muted-foreground))]">{score.label}</span>
              </div>
            </div>
          </div>
          <span
            className="shrink-0 p-1.5 rounded-full border mt-1 transition-colors group-hover:bg-[hsl(var(--primary)/0.1)]"
            style={{ borderColor: gradeTint(score.tone, 0.5), color: score.color }}
            aria-hidden="true"
          >
            <QuestionIcon size={14} />
          </span>
        </div>
        <div className="score-meters">
          {comps.map(({ label, s, max }) => (
            <div key={label}>
              <div className="flex justify-between text-[11px] mb-1">
                <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
                <span className="font-medium tabular-nums" style={{ color: score.color }}>{s}/{max}</span>
              </div>
              <div className="h-1.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
                <div className="h-full rounded-full"
                     style={{ width: `${(s / max) * 100}%`, backgroundColor: score.color }} />
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-3.5 text-center">
          How is this calculated?
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
  const selected = history.find((h) => h.month === selectedMonth) ?? null;

  return (
    <section className="border rounded-2xl overflow-hidden shadow-sm">
      <div className="px-6 pt-5 pb-5">
        <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
          <div>
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-2">
              Net worth
            </p>
            <p className={`text-4xl font-medium tabular-nums ${netWorth.netWorthCents >= 0 ? "text-[hsl(var(--foreground))]" : "text-[hsl(var(--error))]"}`}>
              <CountUp value={netWorth.netWorthCents} format={(v) => formatCurrency(Math.round(v))} />
            </p>
          </div>
          {history.length >= 2 && (
            <TrendChip deltaCents={changeCents} pct={changePct} compareLabel="this year" />
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Liquid</p>
            <p className="text-sm font-semibold tabular-nums">{formatCurrency(netWorth.liquidCents)}</p>
          </div>
          <div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Investments</p>
            <p className="text-sm font-semibold tabular-nums">{formatCurrency(netWorth.investmentCents)}</p>
          </div>
          <div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Debt</p>
            <p className={`text-sm font-semibold tabular-nums ${(netWorth.debtCents + netWorth.loanDebtCents) < 0 ? "text-[hsl(var(--error))]" : ""}`}>{formatCurrency(netWorth.debtCents + netWorth.loanDebtCents)}</p>
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
                      <stop offset="5%" stopColor={series.balance} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={series.balance} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="month" hide />
                  <Tooltip
                    formatter={(v) => [formatCurrency(v as number), "Net worth"]}
                    labelFormatter={(l) => formatMonthLabel(String(l))}
                    contentStyle={chartTooltipStyle}
                    itemStyle={chartTooltipText}
                    labelStyle={chartTooltipText}
                    wrapperStyle={chartTooltipWrapper}
                  />
                  <Area type="monotone" dataKey="netWorthCents" stroke={series.balance} strokeWidth={2} fill="url(#netWorthGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] text-center mb-3">
              Click a point on the chart for that month's breakdown
            </p>

            <AnimatePresence initial={false} mode="wait">
              {selected && (
                <motion.div
                  key={selected.month}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <div className="grid grid-cols-4 gap-3 text-center rounded-xl p-3 mb-4 bg-[hsl(var(--muted))]/40">
                    <div>
                      <p className="text-[11px] text-[hsl(var(--muted-foreground))]">{formatMonthLabel(selected.month)}</p>
                      <p className="text-xs font-semibold tabular-nums">{formatCurrency(selected.netWorthCents)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Liquid</p>
                      <p className="text-xs font-semibold tabular-nums">{formatCurrency(selected.liquidCents)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Investments</p>
                      <p className="text-xs font-semibold tabular-nums">{formatCurrency(selected.investmentCents)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Debt</p>
                      <p className={`text-xs font-semibold tabular-nums ${selected.debtCents < 0 ? "text-[hsl(var(--error))]" : ""}`}>{formatCurrency(selected.debtCents)}</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        <div className="grid grid-cols-2 gap-4 pt-3 border-t">
          <div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mb-0.5">Savings rate</p>
            <p className={`text-lg font-semibold tabular-nums ${savingsRatePct >= 20 ? "text-[hsl(var(--foreground))]" : savingsRatePct >= 10 ? "text-[hsl(var(--warning))]" : "text-[hsl(var(--error))]"}`}>
              {savingsRatePct}%
            </p>
          </div>
          <div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mb-0.5">Investment return</p>
            <p className="text-lg font-semibold tabular-nums">
              {investmentReturn?.annualizedReturnPct !== null && investmentReturn?.annualizedReturnPct !== undefined
                ? `${investmentReturn.annualizedReturnPct >= 0 ? "+" : ""}${investmentReturn.annualizedReturnPct.toFixed(1)}% a year`
                : investmentReturn?.absoluteReturnPct !== null && investmentReturn?.absoluteReturnPct !== undefined
                ? `${investmentReturn.absoluteReturnPct >= 0 ? "+" : ""}${investmentReturn.absoluteReturnPct.toFixed(1)}%`
                : "No data"}
            </p>
            {investmentReturn?.hasCostBasis && investmentReturn.annualizedReturnPct === null && (
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Absolute (needs trade dates to annualize)</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Debt Dashboard (loans + credit cards) ──────────────────────────────────────
const DEBT_TIPS: Record<"avalanche" | "snowball" | "cashflow", string> = {
  avalanche: "The avalanche method targets your highest interest rate first, no matter the balance. Mathematically it saves the most money over time, but the first win can take a while if that account has a large balance.",
  snowball: "The snowball method targets your smallest balance first. Research on debt payoff behavior consistently finds people are more likely to stick with a payoff plan when they get a quick win early, even though it is not always the cheapest path on paper.",
  cashflow: "Paying off the account with the highest minimum payment first frees up the most monthly cash flow the soonest. Useful if your goal is breathing room in your budget rather than minimizing total interest paid.",
};

type LoanRankMethod = "avalanche" | "snowball" | "cashflow";

/** A loan or credit card, tagged so the Debt Dashboard can rank both together while still
 *  showing which is which. `firstKnownBalanceCents` is the earliest balance on record (from the
 *  same balance-history series `trendCents` is derived from) - lets the Debt Payoff modal show
 *  "X% paid off since you started tracking this" without a separate DB round-trip. */
type DebtEntry = LoanAccount & { trendCents: number | null; firstKnownBalanceCents: number | null; debtKind: "loan" | "credit" };

interface RankedLoan extends DebtEntry {
  rankable: boolean;
}

function rankLoans(loans: DebtEntry[], method: LoanRankMethod): RankedLoan[] {
  const withFlag = loans.map((l) => ({
    ...l,
    rankable: method === "avalanche" ? l.interest_rate_bps != null
      : method === "cashflow" ? l.minimum_payment_cents != null
      : true,
  }));
  const rankableLoans = withFlag.filter((l) => l.rankable);
  const unrankable = withFlag.filter((l) => !l.rankable);
  rankableLoans.sort((a, b) => {
    if (method === "avalanche") return (b.interest_rate_bps ?? 0) - (a.interest_rate_bps ?? 0);
    if (method === "cashflow") return (b.minimum_payment_cents ?? 0) - (a.minimum_payment_cents ?? 0);
    return Math.abs(a.balance_cents ?? 0) - Math.abs(b.balance_cents ?? 0); // snowball: smallest balance first
  });
  return [...rankableLoans, ...unrankable];
}

function LoanDashboardCard({ loans, onSelectLoan }: { loans: DebtEntry[]; onSelectLoan: (loan: DebtEntry) => void }) {
  const [method, setMethod] = useState<LoanRankMethod>("avalanche");
  const hasAnyRate = loans.some((l) => l.interest_rate_bps != null);
  const hasAnyPayment = loans.some((l) => l.minimum_payment_cents != null);
  const totalDebtCents = loans.reduce((s, l) => s + Math.abs(l.balance_cents ?? 0), 0);
  const ranked = rankLoans(loans, method);
  const loanCount = loans.filter((l) => l.debtKind === "loan").length;
  const creditCount = loans.filter((l) => l.debtKind === "credit").length;

  const methodLabel: Record<LoanRankMethod, string> = {
    avalanche: "Avalanche saves the most money",
    snowball: "Snowball gives the fastest first payoff",
    cashflow: "Cash-flow first frees up money fastest",
  };

  return (
    <section className="border rounded-2xl overflow-hidden shadow-sm">
      <div className="px-6 pt-5 pb-5">
        <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
          <div>
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-2">
              Debt payoff
            </p>
            <p className="text-[26px] leading-none font-medium tabular-nums text-[hsl(var(--error))]">
              {formatCurrency(-totalDebtCents)}
            </p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
              {loanCount > 0 && `${loanCount} loan${loanCount !== 1 ? "s" : ""}`}
              {loanCount > 0 && creditCount > 0 && " and "}
              {creditCount > 0 && `${creditCount} credit card${creditCount !== 1 ? "s" : ""}`}
              {", not counted toward income or expenses"}
            </p>
          </div>
        </div>

        <div className="flex gap-2 mb-3 flex-wrap">
          {(["avalanche", "snowball", "cashflow"] as LoanRankMethod[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              aria-pressed={method === m}
              disabled={m === "cashflow" && !hasAnyPayment}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                ${method === m
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "border hover:bg-[hsl(var(--muted))]"}`}
            >
              {m === "avalanche" ? "Avalanche" : m === "snowball" ? "Snowball" : "Cash-flow first"}
            </button>
          ))}
        </div>

        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-3">{methodLabel[method]}</p>

        <div className="space-y-1.5 mb-4">
          {ranked.map((loan, i) => (
            <button
              key={loan.id}
              type="button"
              onClick={() => onSelectLoan(loan)}
              className={`w-full flex items-center gap-3 border rounded-lg px-3 py-2 cursor-pointer hover:bg-[hsl(var(--muted))] transition-colors chart-clickable text-left ${!loan.rankable ? "opacity-50" : ""}`}
            >
              <span className="text-xs font-semibold w-5 text-center shrink-0 text-[hsl(var(--muted-foreground))] tabular-nums">
                {loan.rankable ? i + 1 : ""}
              </span>
              <span className="flex-1 min-w-0 truncate text-sm font-medium">{loan.name}</span>
              <span className="text-[10px] font-medium shrink-0 px-1.5 py-0.5 rounded-full border text-[hsl(var(--muted-foreground))]">
                {loan.debtKind === "credit" ? "Card" : "Loan"}
              </span>
              <span className="text-sm font-semibold tabular-nums text-[hsl(var(--error))] shrink-0">{formatCurrency(loan.balance_cents ?? 0)}</span>
              {method === "avalanche" && (
                <span className="text-xs text-[hsl(var(--muted-foreground))] shrink-0 w-16 text-right tabular-nums">
                  {loan.interest_rate_bps != null ? `${(loan.interest_rate_bps / 100).toFixed(2)}%` : "no rate"}
                </span>
              )}
              {method === "cashflow" && (
                <span className="text-xs text-[hsl(var(--muted-foreground))] shrink-0 w-20 text-right tabular-nums">
                  {loan.minimum_payment_cents != null ? `${formatCurrency(loan.minimum_payment_cents)}/mo` : "no payment"}
                </span>
              )}
            </button>
          ))}
        </div>

        {method === "avalanche" && !hasAnyRate && (
          <p className="text-xs text-[hsl(var(--warning))] mb-3 flex items-start gap-1.5">
            <InfoIcon size={12} className="shrink-0 mt-0.5" />
            Add an interest rate to your loans (via Add a statement) to rank them by avalanche priority.
          </p>
        )}

        <p className="text-[11px] text-[hsl(var(--muted-foreground))] mb-3">
          Click any account above for a personalized payoff plan: most aggressive, balanced, or at your current pace.
        </p>

        <div className="rounded-xl p-3 bg-[hsl(var(--muted))]/40 flex items-start gap-2">
          <InfoIcon size={13} className="shrink-0 mt-0.5 text-[hsl(var(--muted-foreground))]" />
          <p className="text-xs text-[hsl(var(--muted-foreground))]">{DEBT_TIPS[method]}</p>
        </div>
      </div>
    </section>
  );
}


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
  const { onBackdropClick, containerRef } = useModalDismiss(onClose);

  const grades = [
    { g: "A", r: "85 to 100", l: "Excellent",       c: scoreGrade(90).color },
    { g: "B", r: "70 to 84",  l: "Good",            c: scoreGrade(75).color },
    { g: "C", r: "55 to 69",  l: "Building",        c: scoreGrade(60).color },
    { g: "D", r: "40 to 54",  l: "Developing",      c: scoreGrade(45).color },
    { g: "",  r: "Under 40",  l: "Getting started", c: scoreGrade(0).color },
  ];
  const comps = [
    { label: "Savings rate",     detail: "3-month average net against income",   s: score.components.savingsRate.score,     max: 40 },
    { label: "Budget health",    detail: "Share of budgets on track this month",   s: score.components.budgetHealth.score,    max: 30 },
    { label: "Balance runway",   detail: "Months of expenses in your accounts",    s: score.components.balanceRunway.score,   max: 20 },
    { label: "Income stability", detail: "Variance across 6 months of income",     s: score.components.incomeStability.score, max: 10 },
  ];
  const tabCls = (active: boolean) => `flex-1 py-3 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 border-b-2 ${active ? "text-[hsl(var(--gold-ink))] bg-[hsl(var(--primary)/0.08)] border-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))] border-transparent"}`;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ backgroundColor: "hsl(var(--scrim) / 0.55)", backdropFilter: "blur(4px)" }}
      onClick={onBackdropClick} ref={containerRef}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        className="bg-[hsl(var(--surface-raised))] border rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">

        {/* Global / Profile tab toggle */}
        <div className="flex border-b" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "global"} onClick={() => setTab("global")} className={tabCls(tab === "global")}>
            <GlobeIcon size={13} /> Global
          </button>
          <button type="button" role="tab" aria-selected={tab === "profile"} onClick={() => setTab("profile")} className={tabCls(tab === "profile")}>
            <UserIcon size={13} /> {profileName}
          </button>
        </div>

        {/* Score hero */}
        <div className="px-6 pt-6 pb-5 border-b text-center" style={{ backgroundColor: gradeTint(score.tone, 0.06) }}>
          <p className="text-xs font-semibold mb-3" style={{ color: score.color }}>
            Financial health score
          </p>
          <div className="flex items-baseline justify-center gap-3 mb-1">
            <span className="text-[44px] leading-none font-medium tabular-nums" style={{ color: score.color }}>{score.total}</span>
            <div className="text-left">
              {score.grade !== "—" && <div className="text-2xl font-semibold" style={{ color: score.color }}>{score.grade}</div>}
              <div className="text-sm text-[hsl(var(--muted-foreground))]">{score.label}</div>
            </div>
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
            {tab === "global"
              ? "All unlocked profiles combined, calculated each visit"
              : `${profileName}'s individual financial health`}
          </p>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div className="space-y-3">
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
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
            <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
              Grade scale
            </p>
            {grades.map(({ g, r, l, c }) => (
              <div key={l} className="flex items-center gap-3 text-sm">
                <span className="font-semibold w-5 shrink-0" style={{ color: c }}>{g}</span>
                <span className="text-[hsl(var(--muted-foreground))] w-20 shrink-0 tabular-nums text-xs">{r}</span>
                <span className="font-medium" style={{ color: c }}>{l}</span>
              </div>
            ))}
          </div>
          <button type="button" onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-semibold bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90">
            Got it
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AgentPage() {
  const navigate = useNavigate();
  const isDark = useIsDark();
  const reduced = useAppReducedMotion();
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
  const [subscriptions, setSubscriptions]       = useState<RecurringCharge[]>([]);
  const [catDeltas, setCatDeltas]               = useState<CatDelta[]>([]);
  const [hasEnoughData, setHasEnoughData]       = useState(true);
  const [refreshedAt, setRefreshedAt]           = useState<Date | null>(null);
  const [netWorth, setNetWorth]                 = useState<NetWorthSnapshot | null>(null);
  const [netWorthHistory, setNetWorthHistory]   = useState<{ month: string; netWorthCents: number; liquidCents: number; debtCents: number; investmentCents: number }[]>([]);
  const [investmentReturn, setInvestmentReturn] = useState<InvestmentReturn | null>(null);
  const [creditScore, setCreditScore]           = useState<CreditCardHealthScore | null>(null);
  const [investmentScore, setInvestmentScore]   = useState<InvestmentHealthScore | null>(null);
  const [topRoi, setTopRoi]                     = useState<Partial<Record<SecurityType, TopRoiHolding[]>>>({});
  const [loans, setLoans]                       = useState<DebtEntry[]>([]);
  const [fixedFlex, setFixedFlex]               = useState<{ summary: FixedFlexibleSummary; label: string } | null>(null);
  const [costInputs, setCostInputs]             = useState<CostOfMoneyInputs | null>(null);
  const [assumedYieldBps, setAssumedYieldBps]   = useState(() => {
    const stored = Number(localStorage.getItem(ASSUMED_YIELD_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_ASSUMED_YIELD_BPS;
  });
  // The yield is the instrument's one assumption; summarising is pure, so changing it never
  // needs another database round-trip.
  const costOfMoney = useMemo(() => (costInputs ? summarizeCostOfMoney({ ...costInputs, assumedYieldBps }) : null), [costInputs, assumedYieldBps]);
  const [payoffModal, setPayoffModal] = useState<{ debts: DebtEntry[]; title: string; subtitle?: string } | null>(null);
  const { active: activeMilestone, enqueue: enqueueMilestones, dismiss: dismissMilestone } = useMilestoneQueue();
  const subsRef = useRef<HTMLDivElement | null>(null);
  const trendsRef = useRef<HTMLDivElement | null>(null);

  const hiddenChargeCount = listHiddenCharges(profileId).length;

  const hideSubscription = (description: string) => {
    hideCharge(profileId, description);
    setReloadTick((t) => t + 1);
    toast.info("Hidden from subscriptions and the Plan forecast.", {
      action: {
        label: "Undo",
        onClick: () => { unhideCharge(profileId, description); setReloadTick((t) => t + 1); },
      },
    });
  };

  const restoreHiddenSubscriptions = () => {
    clearHiddenCharges(profileId);
    setReloadTick((t) => t + 1);
    toast.success("Restored every hidden charge.");
  };

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

  const unlockedProfileIds = useMemo(
    () => profiles.filter((p) => !p.pin_hash || p.id === profileId || unlockedIds.has(p.id)).map((p) => p.id),
    [profiles, profileId, unlockedIds]
  );

  const scopeIds = useMemo(
    () => viewMode === "global" ? (unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId]) : [profileId],
    [viewMode, unlockedProfileIds, profileId]
  );
  const profileNames = useMemo(() => new Map(profiles.map((p) => [p.id, p.name])), [profiles]);
  const [reloadTick, setReloadTick] = useState(0);

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

  const setSection = useCallback((k: "trends" | "subs" | "topRoi", value: boolean | ((prev: boolean) => boolean)) => {
    setSectExpanded((prev) => {
      const next = { ...prev, [k]: typeof value === "function" ? value(prev[k]) : value };
      localStorage.setItem("compass_insight_sections", JSON.stringify(next));
      return next;
    });
  }, []);
  const toggleSection = useCallback((k: "trends" | "subs" | "topRoi") => setSection(k, (v) => !v), [setSection]);

  const toggleGroup = useCallback((k: string) => {
    setGroupOpen((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      localStorage.setItem("compass_insight_groups", JSON.stringify(next));
      return next;
    });
  }, []);

  // Adaptive defaults, open the right group after first data load
  useEffect(() => {
    if (insights.length === 0 || didSetDefaults.current) return;
    if (localStorage.getItem("compass_insight_groups")) return; // user has custom state
    didSetDefaults.current = true;
    const visible = insights.filter((i) => !dismissedInsights.includes(i.dismissKey));
    const warnings = visible.some((insight) => insight.severity === "warning");
    setGroupOpen({ success: !warnings, info: !warnings, warning: true });
  }, [insights, dismissedInsights]);

  const pinTarget = pinQueue.length > 0 && pinQueueIdx < pinQueue.length ? pinQueue[pinQueueIdx] : null;
  const lockedExcluded = viewMode === "global"
    ? profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id)) : [];

  useEffect(() => {
    if (!activeProfile) return;
    let cancelled = false;
    const ids = scopeIds;

    async function load() {
      setLoading(true);
      const db = await getDb();
      const ph = ids.map(() => "?").join(",");

      const [allInsights, history, profile, globalScore, profileScore, nw, nwHistory, invReturn, topRoiHoldings, ccScore, invHealthScore, fixedFlexInputs, costOfMoneyInputs] = await Promise.all([
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
        getFixedFlexibleInputs(ids),
        getCostOfMoneyInputs(ids, prevYM(currentYM()), DEFAULT_ASSUMED_YIELD_BPS),
      ]);
      if (cancelled) return;

      setCostInputs(costOfMoneyInputs);
      setHasEnoughData(!!profile && history.length >= 2);
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

      // The instrument: only complete months that actually had income count toward the average.
      const ffMonths = monthsWithIncome(fixedFlexInputs.txns, fixedFlexInputs.candidateMonths);
      const ffSummary = summarizeFixedFlexible(fixedFlexInputs.txns, fixedFlexInputs.bills, fixedFlexInputs.detected, ffMonths, {
        incomeCents: fixedFlexInputs.plannedIncomeCents,
        billsCents: fixedFlexInputs.plannedBillsCents,
      });
      if (ffSummary && ffSummary.avgIncomeCents > 0) {
        const newest = ffMonths[0];
        const oldest = ffMonths[ffMonths.length - 1];
        const label = ffMonths.length === 1
          ? `${monthLong(newest)}, 1 complete month`
          : `Average of ${monthLong(oldest)} to ${monthLong(newest)}, ${ffMonths.length} complete months`;
        setFixedFlex({ summary: ffSummary, label });
      } else {
        setFixedFlex(null);
      }

      const [loanLists, creditLists] = await Promise.all([
        Promise.all(ids.map((id) => getLoanAccountsForProfile(id))),
        Promise.all(ids.map((id) => getCreditAccountsForProfile(id))),
      ]);
      const allDebts: (LoanAccount & { debtKind: "loan" | "credit" })[] = [
        ...loanLists.flat().map((l) => ({ ...l, debtKind: "loan" as const })),
        ...creditLists.flat().map((c) => ({ ...c, debtKind: "credit" as const })),
      ];
      const debtTrends = await Promise.all(allDebts.map((l) => getLoanBalanceHistory(l.id)));
      if (cancelled) return;
      const debtsWithTrend = allDebts.map((l, i) => {
        const series = debtTrends[i];
        const trendCents = series.length > 1 ? Math.round((series[series.length - 1].value - series[0].value) * 100) : null;
        const firstKnownBalanceCents = series.length > 0 ? Math.round(series[0].value * 100) : null;
        return { ...l, trendCents, firstKnownBalanceCents };
      });
      setLoans(debtsWithTrend);

      const newMilestones = detectNewMilestones(profileId, {
        netWorthCents: nw.netWorthCents,
        debts: debtsWithTrend.map((d) => ({ id: d.id, name: d.name, balanceCents: d.balance_cents, firstKnownBalanceCents: d.firstKnownBalanceCents })),
        healthGrade: profileScore.grade,
      });
      enqueueMilestones(newMilestones);

      const lastMonth = prevYM(currentYM());
      const monthBefore = prevYM(lastMonth);
      const [ts, te] = monthBounds(lastMonth);
      const [ls, le] = monthBounds(monthBefore);
      // Three months before last month, for the trend table's average column.
      const avgStart = monthBounds(prevYM(prevYM(monthBefore)))[0];

      const [subs, thisCats, lastCats, avgCats] = await Promise.all([
        detectRecurringCharges(ids),
        db.select<{ category_id: number; category_name: string; category_color: string; total: number }[]>(
          `SELECT t.category_id, c.name as category_name, c.color as category_color,
                  ${categorySpendSql()} as total
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
             AND t.category_id!=15 AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
           GROUP BY t.category_id ORDER BY total DESC LIMIT 8`,
          [...ids, ts, te]
        ),
        db.select<{ category_id: number; total: number }[]>(
          `SELECT t.category_id, ${categorySpendSql()} as total
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
             AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
           GROUP BY t.category_id`,
          [...ids, ls, le]
        ),
        db.select<{ category_id: number; total: number }[]>(
          `SELECT category_id, CAST(SUM(monthly) / 3 AS INTEGER) as total FROM (
             SELECT t.category_id, strftime('%Y-%m', t.date) as mo, ${categorySpendSql()} as monthly
             FROM transactions t JOIN accounts a ON a.id=t.account_id
             WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND a.excluded_from_insights=0
               AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
             GROUP BY t.category_id, mo)
           GROUP BY category_id`,
          [...ids, avgStart, ts]
        ),
      ]);
      if (cancelled) return;
      setSubscriptions(subs);
      const lastMap = new Map(lastCats.map((c) => [c.category_id, c.total]));
      const avgMap = new Map(avgCats.map((c) => [c.category_id, c.total]));
      setCatDeltas(thisCats.map((c) => {
        const last = lastMap.get(c.category_id) ?? 0;
        return {
          category_name: c.category_name ?? "Uncategorized", category_color: c.category_color,
          this_month: c.total, last_month: last, avg_3: avgMap.get(c.category_id) ?? 0,
          delta_cents: c.total - last,
          delta_pct: last > 0 ? Math.round(((c.total - last) / last) * 100) : null,
        };
      }));
      setRefreshedAt(new Date());
      setLoading(false);
    }
    load().catch((error) => { if (!cancelled) handleLoadFailure("your insights", setLoading, () => setReloadTick((t) => t + 1))(error); });
    return () => { cancelled = true; };
  }, [profileId, activeProfile, viewMode, unlockedProfileIds, scopeIds, reloadTick, enqueueMilestones]);

  const visibleInsights  = insights.filter((i) => !dismissedInsights.includes(i.dismissKey));
  const successInsights  = visibleInsights.filter((i) => i.severity === "success");
  const infoInsights     = visibleInsights.filter((i) => i.severity === "info");
  const warningInsights  = visibleInsights.filter((i) => i.severity === "warning");

  const openAllDebtsPayoff = () => {
    if (loans.length === 0) return;
    setPayoffModal({
      debts: loans,
      title: "Your debt payoff plan",
      subtitle: `${loans.length} account${loans.length !== 1 ? "s" : ""}, ${formatCurrency(-loans.reduce((s, l) => s + Math.abs(l.balance_cents ?? 0), 0))} total debt`,
    });
  };

  const handleApply = (insight: Insight) => {
    if (!insight.action) return;
    if (insight.action.type === "open_payoff") { openAllDebtsPayoff(); return; }
    if (insight.action.type === "open_section") {
      const section = (insight.action.payload as { section?: string }).section === "trends" ? "trends" : "subs";
      setSection(section, true);
      const ref = section === "trends" ? trendsRef : subsRef;
      setTimeout(() => ref.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" }), 50);
      return;
    }
    const target = resolveInsightAction(insight.action);
    if (target) navigate(target.to, target.state ? { state: target.state } : undefined);
  };

  const avgSavingsRatePct = spendingProfile ? Math.round(spendingProfile.avgSavingsRate * 100) : 0;
  const totalSubCost = subscriptions.reduce((s, r) => s + Math.abs(r.amount_cents), 0);
  const annualSubCost = totalSubCost * 12;
  const activeScore = viewMode === "global" ? globalHealthScore : (profileHealthScore ?? globalHealthScore);
  const colorMode = isDark ? "dark" : "light";

  // ── Shared sticky header ─────────────────────────────────────────────────
  const PageHeader = (
    <div className="insights-heading sticky top-0 z-20 border-b px-8 py-4 flex flex-wrap items-center justify-between gap-4"
      style={{ backgroundColor: "hsl(var(--background))", backdropFilter: "blur(8px)" }}>
      <div className="flex items-center gap-3 min-w-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Insights</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            {refreshedAt
              ? `Calculated ${refreshedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Calculated on this computer from your imported data."}
          </p>
        </div>
        {activeScore && (
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full shrink-0 border"
            onClick={() => setShowScoreIntro(true)}
            aria-label="How is this calculated?"
            style={{ backgroundColor: gradeTint(activeScore.tone, 0.12), borderColor: gradeTint(activeScore.tone, 0.5) }}>
            <span className="text-xs font-bold tabular-nums" style={{ color: activeScore.color }}>{activeScore.total}</span>
            <span className="text-xs font-semibold" style={{ color: activeScore.color }}>{activeScore.label}</span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <div role="group" aria-label="Scope" className="flex items-center gap-3">
          <span className="text-sm font-semibold select-none"
            style={{ color: viewMode === "profile" ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
            Profile
          </span>
          <ScopeToggle isGlobal={viewMode === "global"} ariaLabel="Global scope"
            onToggle={() => viewMode === "global" ? handleSwitchToProfile() : handleSwitchToGlobal()} />
          <span className="text-sm font-semibold select-none"
            style={{ color: viewMode === "global" ? "hsl(var(--gold-ink))" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
            Global
          </span>
        </div>
        <InsightsExcludeDropdown
          profileIds={scopeIds}
          profileNames={profileNames}
          onChanged={() => setReloadTick((t) => t + 1)}
        />
      </div>
    </div>
  );

  if (loading) {
    return (
      <>
        {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
        {PageHeader}
        <div className="p-8">
          <CardListSkeleton count={4} />
        </div>
      </>
    );
  }

  const changeTone = (pct: number | null) =>
    pct === null ? "text-[hsl(var(--muted-foreground))]"
    : pct >= 20 ? "text-[hsl(var(--error))]"
    : pct <= -20 ? "text-[hsl(var(--success))]"
    : "text-[hsl(var(--foreground))]";

  return (
    <>
      <MilestoneCelebration event={activeMilestone} onDismiss={dismissMilestone} />
      {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
      <AnimatePresence>
        {showScoreIntro && globalHealthScore && (
          <ScoreIntroModal
            key="score-intro-modal"
            globalScore={globalHealthScore}
            profileScore={profileHealthScore}
            profileName={activeProfile?.name ?? "Profile"}
            onClose={() => setShowScoreIntro(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {payoffModal && (
          <DebtPayoffModal
            key="debt-payoff-modal"
            profileIds={scopeIds}
            debts={payoffModal.debts}
            title={payoffModal.title}
            subtitle={payoffModal.subtitle}
            onClose={() => setPayoffModal(null)}
          />
        )}
      </AnimatePresence>
      {PageHeader}

      <div className="workspace-page space-y-6 insights-workspace">
        {!hasEnoughData && <div role="status" className="insights-readiness border-b pb-4 text-sm">
          <p>Limited history. Trends need at least two months; available balances and review items are shown below.</p>
          <Link to="/import" className="inline-block mt-2 text-[hsl(var(--gold-ink))]">Import transactions</Link>
        </div>}

        <section className="insights-context" aria-label="Financial context and scores">
          <h2 className="font-semibold">Financial context and scores</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
            {viewMode === "global"
              ? `Global view, ${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"} combined.`
              : "This profile."} Budget analysis uses accounts enabled for insights.
          </p>
          <motion.div
            className="insights-context-content space-y-5 pt-4"
            variants={staggerContainer}
            initial={reduced ? false : "hidden"}
            animate="show"
          >

        {/* Locked-profile notice */}
        {lockedExcluded.length > 0 && (
          <LockedProfilesNotice
            profiles={lockedExcluded}
            onUnlock={(p) => { setPinQueue([p]); setPinQueueIdx(0); }}
            context="their data is left out of the global view"
          />
        )}

        {/* ── Score Hero ── */}
        {(viewMode === "global" ? globalHealthScore : profileHealthScore) && (
          <motion.div variants={riseIn}>
            <ScoreHeroCard
              score={(viewMode === "global" ? globalHealthScore : profileHealthScore)!}
              scopeLabel={viewMode === "global"
                ? "Global health score"
                : `${activeProfile?.name ?? "Profile"} score`}
              onOpen={() => setShowScoreIntro(true)}
            />
          </motion.div>
        )}

        {/* ── Fixed and flexible: the page's instrument ── */}
        {fixedFlex && (
          <motion.div variants={riseIn}>
            <FixedFlexibleBar
              summary={fixedFlex.summary}
              monthsLabel={fixedFlex.label}
            />
          </motion.div>
        )}

        {/* ── Cost of money: what borrowing cost against what the money earned, live today ── */}
        {costOfMoney && (
          <motion.div variants={riseIn}>
            <CostOfMoney
              summary={costOfMoney}
              monthLabel={`${monthLong(prevYM(currentYM()))}, the last complete month`}
              onYieldChange={(bps) => { setAssumedYieldBps(bps); localStorage.setItem(ASSUMED_YIELD_KEY, String(bps)); }}
            />
          </motion.div>
        )}

        {/* ── Net Worth ── */}
        {netWorth && (
          <motion.div variants={riseIn}>
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
          <motion.div variants={riseIn} className="grid grid-cols-2 gap-3">
            <MiniScoreCard
              label="Credit card health"
              score={creditScore}
              infoText="Scored against the average American's credit card balance of about $6,000, with a small bonus or penalty depending on whether your balance shrank or grew this month."
              onClick={loans.length > 0 ? openAllDebtsPayoff : undefined}
            />
            <MiniScoreCard
              label="Investment health"
              score={investmentScore}
              infoText="Scored against the long-run average U.S. stock market return of about 7% a year, adjusted for inflation."
            />
          </motion.div>
        )}

        {/* ── Debt Payoff Dashboard (loans + credit cards) ── */}
        {loans.length > 0 && (
          <motion.div variants={riseIn}>
            <LoanDashboardCard
              loans={loans}
              onSelectLoan={(loan) => setPayoffModal({
                debts: [loan],
                title: `${loan.name} payoff plan`,
                subtitle: `${loan.debtKind === "credit" ? "Credit card" : "Loan"}, ${formatCurrency(loan.balance_cents ?? 0)} balance`,
              })}
            />
          </motion.div>
        )}

        {/* ── Top Performers ── */}
        {Object.keys(topRoi).length > 0 && (
          <motion.div variants={riseIn}>
            <CollapsibleSection title="Top performers" subtitle="highest return per section"
              expanded={sectExpanded.topRoi} onToggle={() => toggleSection("topRoi")}>
              <div className="divide-y">
                {ROI_SECTION_ORDER.filter((t) => (topRoi[t]?.length ?? 0) > 0).map((type) => (
                  <div key={type} className="px-5 py-3">
                    <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-2">
                      {ROI_SECTION_LABELS[type]}
                    </p>
                    <div className="space-y-1.5">
                      {topRoi[type]!.map((h) => (
                        <div key={`${type}-${h.symbol ?? h.description}`} className="flex items-center justify-between gap-3 text-sm">
                          <span className="truncate flex-1">{h.symbol ?? h.description}</span>
                          <span className={`font-semibold flex items-center gap-1 shrink-0 tabular-nums ${h.roiPct >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
                            {h.roiPct >= 0 ? <TrendUpIcon size={12} /> : <TrendDownIcon size={12} />}
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

        {/* ── Savings Rate Sparkline ── */}
        {savingsHistory.length >= 2 && (
          <motion.section variants={riseIn} className="border rounded-2xl overflow-hidden">
            <div className="px-6 pt-5 pb-0 flex items-center justify-between">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
                Savings rate, 12 months
              </p>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">20% target</p>
            </div>
            <ResponsiveContainer width="100%" height={110}>
              <AreaChart data={savingsHistory} margin={{ left: 0, right: 20, top: 8, bottom: 4 }}>
                <defs>
                  <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={series.balance} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={series.balance} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="month" tick={axisTick} tickFormatter={formatMonthLabel}
                       axisLine={false} tickLine={false} />
                <YAxis tick={axisTick} tickFormatter={(v: number) => `${v}%`} width={34}
                       axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v) => [`${v ?? 0}%`, "Rate"]}
                  labelFormatter={(l) => formatMonthLabel(String(l))}
                  contentStyle={chartTooltipStyle}
                  itemStyle={chartTooltipText}
                  labelStyle={chartTooltipText}
                  wrapperStyle={chartTooltipWrapper}
                />
                <ReferenceLine y={20} stroke={series.reference} strokeDasharray="4 4" strokeOpacity={0.6} />
                <Area type="monotone" dataKey="rate" stroke={series.balance} strokeWidth={2}
                      fill="url(#sparkGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </motion.section>
        )}

          </motion.div>
        </section>

        <section className="insights-review space-y-3" aria-label="Items to review">
          <div className="workspace-heading"><h2 className="font-semibold">Review</h2>
            {dismissedInsights.length > 0 && <button onClick={clearDismissed} className="text-xs text-[hsl(var(--muted-foreground))]">Restore {dismissedInsights.length} dismissed</button>}
          </div>
          {visibleInsights.length === 0 && <p className="py-6 text-sm text-[hsl(var(--muted-foreground))]">Nothing left to review. This list is not an assessment of your financial health.</p>}
          <InsightGroup label="Action items" severity="warning" items={warningInsights} onApply={handleApply} open={!!groupOpen.warning} onToggle={() => toggleGroup("warning")} />
          <InsightGroup label="Observations" severity="info" items={infoInsights} onApply={handleApply} open={!!groupOpen.info} onToggle={() => toggleGroup("info")} />
          <InsightGroup label="Wins" severity="success" items={successInsights} onApply={handleApply} open={!!groupOpen.success} onToggle={() => toggleGroup("success")} />
        </section>

        {/* ── Category Trends ── */}
        {catDeltas.length > 0 && (
          <div ref={trendsRef}>
            <CollapsibleSection title="Category trends" subtitle={`${formatMonthLabel(prevYM(currentYM()))} against ${formatMonthLabel(prevYM(prevYM(currentYM())))}`}
              expanded={sectExpanded.trends} onToggle={() => toggleSection("trends")}>
              <div className="insights-table">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))]">Category</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">{formatMonthLabel(prevYM(currentYM()))}</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">{formatMonthLabel(prevYM(prevYM(currentYM())))}</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">3-month average</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catDeltas.map((r) => (
                      <tr key={r.category_name} className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: harmonizeColor(r.category_color, colorMode) }} />
                            {r.category_name}
                          </div>
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{formatCurrency(r.this_month)}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{formatCurrency(r.last_month)}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-[hsl(var(--muted-foreground))]">{r.avg_3 > 0 ? formatCurrency(r.avg_3) : "No data"}</td>
                        <td className={`px-5 py-2.5 text-right tabular-nums font-medium ${changeTone(r.delta_pct)}`}>
                          {r.delta_pct === null
                            ? "New"
                            : `${r.delta_cents > 0 ? "+" : r.delta_cents < 0 ? "-" : ""}${formatCurrency(Math.abs(r.delta_cents))} (${r.delta_pct > 0 ? "+" : ""}${r.delta_pct}%)`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsibleSection>
          </div>
        )}

        {/* ── Subscription Inventory ── */}
        {subscriptions.length > 0 && (
          <div ref={subsRef}>
            <CollapsibleSection title="Subscription inventory"
              subtitle={`${formatCurrency(annualSubCost)} a year`}
              expanded={sectExpanded.subs} onToggle={() => toggleSection("subs")}>
              <div className="insights-table">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))]">Charge</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))]">Category</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))]">Cadence</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Since</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Months</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Change</th>
                      <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Per month</th>
                      <th className="pr-4 py-2.5" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptions.map((s) => {
                      const change = s.previousAmountCents !== null ? Math.abs(s.amount_cents) - s.previousAmountCents : null;
                      const rise = change !== null && s.previousAmountCents !== null && change / s.previousAmountCents >= 0.1;
                      return (
                        <tr key={`${s.description}_${s.amount_cents}_${s.last_seen}`}
                          className="border-b last:border-0 hover:bg-[hsl(var(--muted))] group">
                          <td className="px-5 py-2.5 max-w-xs truncate">{s.description}</td>
                          <td className="px-5 py-2.5">
                            <span className="inline-flex items-center gap-2 text-[13px]">
                              <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: s.category_color ? harmonizeColor(s.category_color, colorMode) : "hsl(var(--neutral))" }} />
                              {s.category_name ?? "Uncategorized"}
                            </span>
                          </td>
                          <td className="px-5 py-2.5 text-[hsl(var(--muted-foreground))]">{s.patternLabel}</td>
                          <td className="px-5 py-2.5 text-right text-[hsl(var(--muted-foreground))] tabular-nums">{formatMonthLabel(s.first_seen.slice(0, 7))}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{s.month_count}</td>
                          <td className={`px-5 py-2.5 text-right tabular-nums ${rise ? "text-[hsl(var(--warning))]" : "text-[hsl(var(--muted-foreground))]"}`}>
                            {change === null || change === 0 ? "" : `${change > 0 ? "+" : "-"}${formatCurrency(Math.abs(change))}`}
                          </td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{formatCurrency(Math.abs(s.amount_cents))}</td>
                          <td className="pr-4 py-2.5 text-right">
                            <button
                              onClick={() => hideSubscription(s.description)}
                              aria-label={`Hide ${s.description}`}
                              title="Not a subscription. Hide it from here and from the Plan forecast"
                              className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))]
                                         opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                            >
                              <EyeSlashIcon size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t text-xs text-[hsl(var(--muted-foreground))] flex items-center justify-between gap-3">
                <span className="tabular-nums">{formatCurrency(totalSubCost)} a month, {formatCurrency(annualSubCost)} a year</span>
                {hiddenChargeCount > 0 && (
                  <button onClick={restoreHiddenSubscriptions} className="underline hover:text-[hsl(var(--foreground))]">
                    Restore {hiddenChargeCount} hidden
                  </button>
                )}
              </div>
            </CollapsibleSection>
          </div>
        )}

        <div className="h-6" />
      </div>
    </>
  );
}
