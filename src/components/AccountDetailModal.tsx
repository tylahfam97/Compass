import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { AreaChart, Area, XAxis, ResponsiveContainer, Tooltip } from "recharts";
import { X, TrendingUp, TrendingDown, Info, CheckCircle, AlertTriangle, Pencil } from "lucide-react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { getDb, setAccountInterestRate, setAccountMinimumPayment } from "@/lib/db";
import { formatCurrency, formatDate, parseDollarInput } from "@/lib/utils";
import type { Insight, InsightType, Transaction } from "@/lib/types";
import InsightCard from "@/components/InsightCard";

export interface AccountDetailAccount {
  id: number;
  name: string;
  accountType: "credit" | "loan" | "checking";
  color: string;
  balanceCents: number | null;
  series: { date: string; value: number }[];
  /** Loans and credit cards - informational, shown as-is. */
  interestRateBps?: number | null;
  minimumPaymentCents?: number | null;
}

interface Props {
  account: AccountDetailAccount;
  /** The profile's full insight list - filtered here down to whatever is relevant to this
   *  account's type, since insights aren't generated per-account. */
  insights: Insight[];
  onApply: (insight: Insight) => void;
  onClose: () => void;
  /** Called after the interest rate/minimum payment is edited, so the parent page can reload
   *  its own account data - this modal only ever receives a point-in-time snapshot as a prop. */
  onUpdated?: () => void;
}

// Insights aren't tagged to a specific account (besides the credit-card-debt ones below, which
// are), so this is a best-effort relevance mapping by type for everything else - good enough
// to surface the 1-2 most pertinent existing insights without needing a whole separate
// per-account insights engine.
const CREDIT_RELEVANT_TYPES: InsightType[] = [
  "credit_card_debt_high", "credit_card_debt_growing", "credit_card_debt_improving",
  "loan_payoff_projection", "debt_payoff_priority",
];
const CHECKING_RELEVANT_TYPES: InsightType[] = [
  "overdraft_alert", "emergency_fund_runway", "income_irregular", "savings_rate_low",
];
const LOAN_RELEVANT_TYPES: InsightType[] = [
  "loan_debt_high", "loan_debt_growing", "loan_debt_improving",
  "loan_payoff_projection", "debt_payoff_priority",
];

interface DerivedNote {
  title: string;
  description: string;
  severity: "info" | "success" | "warning";
}

const NOTE_ICONS: Record<DerivedNote["severity"], React.ElementType> = {
  info: Info, success: CheckCircle, warning: AlertTriangle,
};
const NOTE_ICON_CLS: Record<DerivedNote["severity"], string> = {
  info: "text-[hsl(var(--primary))]", success: "text-[hsl(var(--success))]", warning: "text-[hsl(var(--warning))]",
};

/** Loans and credit cards have no generic Insight type of their own for balance-trend/rate
 *  observations (see agent.ts) - these are simple, honest observations computed straight from
 *  the account's own data, not a full insights pipeline. */
function derivedDebtNotes(account: AccountDetailAccount): DerivedNote[] {
  const notes: DerivedNote[] = [];
  if (account.series.length > 1) {
    const changeCents = Math.round((account.series[account.series.length - 1].value - account.series[0].value) * 100);
    if (Math.abs(changeCents) >= 100) {
      notes.push(changeCents > 0
        ? { title: "Balance improving", description: `Paid down ${formatCurrency(Math.abs(changeCents))} since the earliest statement/transaction on file.`, severity: "success" }
        : { title: "Balance growing", description: `Grew by ${formatCurrency(Math.abs(changeCents))} since the earliest statement/transaction on file.`, severity: "warning" });
    }
  }
  if (account.interestRateBps == null) {
    notes.push({
      title: "No interest rate on file",
      description: account.accountType === "credit"
        ? "Add one next time you import a statement to include this card in Avalanche ranking on the Debt Dashboard."
        : "Add one (via \"Add a Statement\") to include this loan in Avalanche ranking on the Debt Dashboard.",
      severity: "info",
    });
  } else if (account.interestRateBps >= 1000) {
    notes.push({
      title: "High interest rate",
      description: `At ${(account.interestRateBps / 100).toFixed(2)}%, this is likely a strong Avalanche-method candidate to pay off first.`,
      severity: "warning",
    });
  }
  return notes;
}

/** Checking accounts get a simple balance-trend observation, same spirit as `derivedDebtNotes`
 *  but without any debt-specific framing (interest rate, Avalanche ranking, etc). */
function derivedCheckingNotes(account: AccountDetailAccount): DerivedNote[] {
  const notes: DerivedNote[] = [];
  if (account.series.length > 1) {
    const changeCents = Math.round((account.series[account.series.length - 1].value - account.series[0].value) * 100);
    if (Math.abs(changeCents) >= 100) {
      notes.push(changeCents > 0
        ? { title: "Balance growing", description: `Up ${formatCurrency(Math.abs(changeCents))} over the period shown.`, severity: "success" }
        : { title: "Balance shrinking", description: `Down ${formatCurrency(Math.abs(changeCents))} over the period shown.`, severity: "warning" });
    }
  }
  return notes;
}

export default function AccountDetailModal({ account, insights, onApply, onClose, onUpdated }: Props) {
  const { onBackdropClick } = useModalDismiss(onClose);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [loadingTxns, setLoadingTxns] = useState(account.accountType === "credit" || account.accountType === "checking");
  const [editingRates, setEditingRates] = useState(false);
  const [rateInput, setRateInput] = useState(account.interestRateBps != null ? (account.interestRateBps / 100).toFixed(2) : "");
  const [paymentInput, setPaymentInput] = useState(account.minimumPaymentCents != null ? (account.minimumPaymentCents / 100).toFixed(2) : "");
  const [savingRates, setSavingRates] = useState(false);
  // Mirrors account.interestRateBps/minimumPaymentCents until a save happens - the parent only
  // passes a point-in-time snapshot, so this modal must track its own edits to reflect them
  // immediately instead of showing the stale value until closed and reopened.
  const [displayRateBps, setDisplayRateBps] = useState(account.interestRateBps ?? null);
  const [displayPaymentCents, setDisplayPaymentCents] = useState(account.minimumPaymentCents ?? null);

  useEffect(() => {
    if (account.accountType !== "credit" && account.accountType !== "checking") return;
    (async () => {
      setLoadingTxns(true);
      try {
        const db = await getDb();
        const rows = await db.select<Transaction[]>(
          `SELECT t.*, c.name as category_name, c.color as category_color
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.account_id=? ORDER BY t.date DESC, t.id DESC LIMIT 8`,
          [account.id]
        );
        setTxns(rows);
      } catch {
        setTxns([]);
      } finally {
        setLoadingTxns(false);
      }
    })();
  }, [account.id, account.accountType]);

  const series = account.series;
  const last = series.length > 0 ? series[series.length - 1].value : (account.balanceCents ?? 0) / 100;
  const first = series.length > 0 ? series[0].value : last;
  const changeCents = Math.round((last - first) * 100);
  const improved = changeCents > 0;
  const lastCents = Math.round(last * 100);

  const matchedInsights = account.accountType === "credit"
    ? insights.filter((i) => CREDIT_RELEVANT_TYPES.includes(i.type) && i.accountId === account.id).slice(0, 2)
    : account.accountType === "checking"
    ? insights.filter((i) => CHECKING_RELEVANT_TYPES.includes(i.type)).slice(0, 2)
    : account.accountType === "loan"
    ? insights.filter((i) => LOAN_RELEVANT_TYPES.includes(i.type) && i.accountId === account.id).slice(0, 2)
    : [];
  const notes = account.accountType === "loan" || account.accountType === "credit"
    ? derivedDebtNotes({ ...account, interestRateBps: displayRateBps, minimumPaymentCents: displayPaymentCents }).slice(0, 2)
    : derivedCheckingNotes(account).slice(0, 2);

  const saveRates = async () => {
    setSavingRates(true);
    try {
      const rate = rateInput.trim();
      const payment = paymentInput.trim();
      const rateBps = rate ? Math.round(parseFloat(rate) * 100) : null;
      const paymentCents = payment ? Math.round(parseDollarInput(payment) * 100) : null;
      await setAccountInterestRate(account.id, rateBps);
      await setAccountMinimumPayment(account.id, paymentCents);
      setDisplayRateBps(rateBps);
      setDisplayPaymentCents(paymentCents);
      setEditingRates(false);
      onUpdated?.();
    } finally {
      setSavingRates(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[hsl(var(--background))] border rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: account.color }} />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold truncate">{account.name}</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                {account.accountType === "credit" ? "Credit Card" : account.accountType === "checking" ? "Bank Account" : "Loan"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center justify-between mb-3">
          <p className={`text-2xl font-bold ${lastCents < 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--success))]"}`}>
            {formatCurrency(lastCents)}
          </p>
          {series.length > 1 && Math.abs(changeCents) >= 100 && (
            <span className={`text-sm font-semibold flex items-center gap-1 ${improved ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
              {improved ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              {formatCurrency(Math.abs(changeCents))}
            </span>
          )}
        </div>

        {(account.accountType === "loan" || account.accountType === "credit") && (
          editingRates ? (
            <div className="flex items-center gap-2 mb-3 text-xs">
              <div className="relative w-24">
                <input
                  type="text" inputMode="decimal" placeholder="APR %" value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                  className="w-full border rounded-md pl-2 pr-5 py-1 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]">%</span>
              </div>
              <div className="relative w-28">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]">$</span>
                <input
                  type="text" inputMode="decimal" placeholder="Min/mo" value={paymentInput}
                  onChange={(e) => setPaymentInput(e.target.value)}
                  className="w-full border rounded-md pl-5 pr-2 py-1 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                />
              </div>
              <button onClick={saveRates} disabled={savingRates}
                className="px-2 py-1 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-medium disabled:opacity-50">
                {savingRates ? "Saving…" : "Save"}
              </button>
              <button onClick={() => setEditingRates(false)} className="px-2 py-1 rounded-md border hover:bg-[hsl(var(--muted))] transition-colors">
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingRates(true)}
              title="Edit interest rate / minimum payment"
              className="flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] mb-3 transition-colors"
            >
              {(displayRateBps != null || displayPaymentCents != null) ? (
                <>
                  {displayRateBps != null && <>{(displayRateBps / 100).toFixed(2)}% APR</>}
                  {displayRateBps != null && displayPaymentCents != null && " · "}
                  {displayPaymentCents != null && <>{formatCurrency(displayPaymentCents)} min/mo</>}
                </>
              ) : (
                <span>Add interest rate / minimum payment</span>
              )}
              <Pencil size={11} className="shrink-0" />
            </button>
          )
        )}

        {series.length > 1 && (
          <div className="h-24 -mx-1 mb-5">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                <defs>
                  <linearGradient id={`detail-grad-${account.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={account.color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={account.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" hide />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }}
                  wrapperStyle={{ zIndex: 50 }}
                  formatter={(v) => [formatCurrency(Math.round(Number(v) * 100)), account.name]}
                  labelFormatter={(l) => formatDate(String(l))}
                />
                <Area type="monotone" dataKey="value" stroke={account.color} strokeWidth={1.5} fill={`url(#detail-grad-${account.id})`} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {(matchedInsights.length > 0 || notes.length > 0) && (
          <div className="mb-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2">
              Top Insights
            </h3>
            <div className="space-y-2">
              {matchedInsights.map((ins) => (
                <InsightCard key={ins.id} insight={ins} onApply={onApply} variant="row" />
              ))}
              {notes.map((n, i) => {
                const Icon = NOTE_ICONS[n.severity];
                return (
                  <div key={i} className="flex items-start gap-2 px-1 py-1.5 text-sm">
                    <Icon size={14} className={`shrink-0 mt-0.5 ${NOTE_ICON_CLS[n.severity]}`} />
                    <div>
                      <p className="font-medium leading-snug">{n.title}</p>
                      <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{n.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {account.accountType === "credit" || account.accountType === "checking" ? (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2">
              Recent Transactions
            </h3>
            {loadingTxns ? (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Loading…</p>
            ) : txns.length === 0 ? (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">No transactions on this account yet.</p>
            ) : (
              <div className="space-y-1">
                {txns.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b last:border-0">
                    <div className="min-w-0">
                      <p className="truncate">{t.description}</p>
                      <p className="text-[10px] text-[hsl(var(--muted-foreground))]">{formatDate(t.date)}</p>
                    </div>
                    <span className={`shrink-0 font-medium ${t.amount_cents < 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--success))]"}`}>
                      {formatCurrency(t.amount_cents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2">
              Statement History
            </h3>
            {series.length === 0 ? (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">No statements uploaded yet.</p>
            ) : (
              <div className="space-y-1">
                {[...series].reverse().slice(0, 6).map((pt, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-sm py-1 border-b last:border-0">
                    <span className="text-[hsl(var(--muted-foreground))]">{formatDate(pt.date)}</span>
                    <span className="font-medium text-[hsl(var(--error))]">{formatCurrency(Math.round(pt.value * 100))}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
