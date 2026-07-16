import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";
import { getDb } from "@/lib/db";
import { formatCurrency, combineAccountBalances } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import type { Profile } from "@/lib/types";

interface ProfileData {
  profileId: number;
  balance: number | null;
  income: number;
  expenses: number;
  sparkline: { date: string; balance: number }[];
  hasTransactions: boolean;
  portfolioValue: number;
}

const INCLUDE_INVESTMENTS_KEY = "compass_include_investments";

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const { profiles, setActiveProfile } = useProfileStore();
  const [month, setMonth] = useAutoMonth();
  const [data, setData] = useState<Map<number, ProfileData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [includeInvestments, setIncludeInvestments] = useState(
    () => localStorage.getItem(INCLUDE_INVESTMENTS_KEY) !== "false"
  );

  const toggleIncludeInvestments = () => {
    setIncludeInvestments((prev) => {
      const next = !prev;
      localStorage.setItem(INCLUDE_INVESTMENTS_KEY, String(next));
      return next;
    });
  };

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  useEffect(() => {
    if (profiles.length === 0) { setLoading(false); return; }
    setLoading(true);
    (async () => {
      const db = await getDb();
      const [start, end] = monthBounds(month);
      const entries = await Promise.all(
        profiles.map(async (p) => {
          const [balRow, incRow, expRow, txRow, sparkRows, portfolioRow] = await Promise.all([
            db.select<{ account_id: number; balance_cents: number | null }[]>(
              `SELECT a.id as account_id,
                 (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
                  ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
               FROM accounts a WHERE a.profile_id=? AND a.account_type IN ('checking','credit')`,
              [p.id]
            ),
            db.select<{ total: number }[]>(
              "SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE profile_id=? AND date>=? AND date<? AND amount_cents>0",
              [p.id, start, end]
            ),
            db.select<{ total: number }[]>(
              "SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0",
              [p.id, start, end]
            ),
            db.select<{ n: number }[]>(
              "SELECT COUNT(*) as n FROM transactions WHERE profile_id=?",
              [p.id]
            ),
            db.select<{ date: string; account_id: number; balance_cents: number }[]>(
              `SELECT t.date, t.account_id, t.balance_cents FROM transactions t
               JOIN accounts a ON a.id=t.account_id
               WHERE t.profile_id=? AND t.balance_cents IS NOT NULL AND a.account_type IN ('checking','credit')
                 AND t.date >= date('now','-60 days')
               ORDER BY t.date ASC, t.id ASC`,
              [p.id]
            ),
            db.select<{ total: number | null }[]>(
              `SELECT SUM(market_value_cents) as total FROM holdings
               WHERE profile_id=? AND as_of_date=(SELECT MAX(as_of_date) FROM holdings WHERE profile_id=?)`,
              [p.id, p.id]
            ),
          ]);
          const trackedAccounts = balRow.filter((r) => r.balance_cents !== null);
          return [p.id, {
            profileId: p.id,
            balance: trackedAccounts.length > 0 ? trackedAccounts.reduce((s, r) => s + (r.balance_cents ?? 0), 0) : null,
            income: incRow[0]?.total ?? 0,
            expenses: expRow[0]?.total ?? 0,
            sparkline: combineAccountBalances(sparkRows).map((r) => ({ date: r.date, balance: r.balance_cents / 100 })),
            hasTransactions: (txRow[0]?.n ?? 0) > 0,
            portfolioValue: portfolioRow[0]?.total ?? 0,
          }] as [number, ProfileData];
        })
      );
      setData(new Map(entries));
      setLoading(false);
    })().catch(console.error);
  }, [profiles, month]);

  const allData = [...data.values()];
  const hasAnyBalance = allData.some((d) => d.balance !== null);
  const totalPortfolioValue = allData.reduce((s, d) => s + d.portfolioValue, 0);
  const totalBalance = hasAnyBalance
    ? allData.reduce((s, d) => s + (d.balance ?? 0) + (includeInvestments ? d.portfolioValue : 0), 0)
    : null;
  const totalIncome = allData.reduce((s, d) => s + d.income, 0);
  const totalExpenses = allData.reduce((s, d) => s + d.expenses, 0);
  const totalNet = totalIncome + totalExpenses;

  function handleSwitch(profile: Profile) {
    setActiveProfile(profile);
    navigate("/");
  }

  return (
    <div className="p-6 space-y-6 max-w-[1200px] mx-auto w-full">
      {/* Header + month picker */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">All Accounts</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            {profiles.length} account{profiles.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => navMonth(-1)} aria-label="Previous month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">‹</button>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
          <button onClick={() => navMonth(1)} aria-label="Next month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">›</button>
        </div>
      </div>

      {/* Aggregate banner */}
      {!loading && allData.some((d) => d.hasTransactions) && (
        <div className="border rounded-2xl p-5 bg-[hsl(var(--muted))]/40">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <p className="text-xs text-[hsl(var(--muted-foreground))] uppercase tracking-wide font-medium">
              Combined — all accounts
            </p>
            {totalPortfolioValue > 0 && (
              <button
                onClick={toggleIncludeInvestments}
                title="Toggle whether investments are included in these totals"
                className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                  includeInvestments
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent"
                    : "hover:bg-[hsl(var(--muted))]"
                }`}
              >
                + Investments
              </button>
            )}
          </div>
          <div className="flex gap-8 flex-wrap">
            {totalBalance !== null && (
              <div>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">{totalPortfolioValue > 0 && includeInvestments ? "Total Net Worth" : "Total Balance"}</p>
                <p className={`text-2xl font-bold ${totalBalance >= 0 ? "text-green-600" : "text-red-500"}`}>
                  {formatCurrency(totalBalance)}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Income</p>
              <p className="text-2xl font-bold text-green-600">{formatCurrency(totalIncome)}</p>
            </div>
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Expenses</p>
              <p className="text-2xl font-bold text-red-500">{formatCurrency(Math.abs(totalExpenses))}</p>
            </div>
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Net</p>
              <p className={`text-2xl font-bold ${totalNet >= 0 ? "text-green-600" : "text-red-500"}`}>
                {formatCurrency(totalNet)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Profile cards grid */}
      {loading ? (
        <p className="text-[hsl(var(--muted-foreground))]">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {profiles.map((profile) => {
            const d = data.get(profile.id);
            const net = (d?.income ?? 0) + (d?.expenses ?? 0);
            return (
              <button key={profile.id} onClick={() => handleSwitch(profile)}
                className="border rounded-2xl p-5 text-left hover:shadow-md transition-all duration-150
                           bg-[hsl(var(--background))] active:scale-[0.99]"
                style={{ "--hover-border": "var(--gold)" } as React.CSSProperties}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--gold)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
              >
                {/* Profile avatar + name */}
                <div className="flex items-center gap-2.5 mb-4">
                  <span className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                    style={{ backgroundColor: profile.avatar_color }}>
                    {profile.name.charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <p className="font-semibold leading-tight">{profile.name}</p>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">
                      {d?.hasTransactions ? "Click to switch →" : "No data imported yet"}
                    </p>
                  </div>
                </div>

                {!d?.hasTransactions ? (
                  <p className="text-sm text-[hsl(var(--muted-foreground))] italic py-4 text-center">
                    Import a bank statement to get started
                  </p>
                ) : (
                  <>
                    {d.balance !== null && (
                      <div className="mb-3">
                        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-0.5">
                          {d.portfolioValue > 0 && includeInvestments ? "Net Worth" : "Current Balance"}
                        </p>
                        <p className={`text-2xl font-bold ${(d.balance + (includeInvestments ? d.portfolioValue : 0)) >= 0 ? "text-green-600" : "text-red-500"}`}>
                          {formatCurrency(d.balance + (includeInvestments ? d.portfolioValue : 0))}
                        </p>
                      </div>
                    )}

                    {d.sparkline.length > 1 && (
                      <div className="h-14 mb-3 -mx-1">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={d.sparkline} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                            <defs>
                              <linearGradient id={`grad-${profile.id}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={profile.avatar_color} stopOpacity={0.3} />
                                <stop offset="95%" stopColor={profile.avatar_color} stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <Tooltip contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }}
                              formatter={(v) => [`$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Balance"]}
                              labelFormatter={(l) => String(l)} />
                            <Area type="monotone" dataKey="balance" stroke={profile.avatar_color} strokeWidth={1.5} fill={`url(#grad-${profile.id})`} dot={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-1 text-center border rounded-xl p-2 bg-[hsl(var(--muted))]/40">
                      <div>
                        <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase">In</p>
                        <p className="text-xs font-semibold text-green-600">{formatCurrency(d.income)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase">Out</p>
                        <p className="text-xs font-semibold text-red-500">{formatCurrency(Math.abs(d.expenses))}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase">Net</p>
                        <p className={`text-xs font-semibold ${net >= 0 ? "text-green-600" : "text-red-500"}`}>
                          {formatCurrency(net)}
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
