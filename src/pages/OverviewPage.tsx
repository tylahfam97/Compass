import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { getDb } from "@/lib/db";
import { formatCurrency, combineAccountBalances, separateAccountBalances, accountChartColor } from "@/lib/utils";
import { computeNetWorth, type NetWorthSnapshot } from "@/lib/netWorth";
import { useProfileStore } from "@/stores/profileStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import PinModal from "@/components/PinModal";
import ManageAccountsPanel from "@/components/ManageAccountsPanel";
import { Skeleton } from "@/components/Skeleton";
import type { Profile } from "@/lib/types";

interface ProfileData {
  profileId: number;
  balance: number | null;
  income: number;
  expenses: number;
  /** Combined checking balance trend - one line, matching Dashboard/Trends. */
  checkingSparkline: { date: string; balance: number }[];
  /** Each credit card kept as its own series (never blended) - drawn as one thin line per card. */
  creditSparkline: { date: string; byAccount: Record<number, number> }[];
  creditAccounts: { id: number; name: string }[];
  hasTransactions: boolean;
  portfolioValue: number;
}

function viewModeKey(profileId: number) {
  return `compass_overview_view_${profileId}`;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

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

export default function OverviewPage() {
  const navigate = useNavigate();
  const { profiles, setActiveProfile, activeProfile, unlockedIds, unlockProfile } = useProfileStore();
  const profileId = activeProfile?.id ?? profiles[0]?.id ?? 1;
  const [month, setMonth] = useAutoMonth();
  const [data, setData] = useState<Map<number, ProfileData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [netWorth, setNetWorth] = useState<NetWorthSnapshot | null>(null);

  const [viewMode, setViewMode] = useState<"profile" | "global">(() => {
    const saved = localStorage.getItem(viewModeKey(profileId));
    return saved === "global" ? "global" : "profile";
  });
  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(viewModeKey(profileId));
    setViewMode(saved === "global" ? "global" : "profile");
  }, [profileId]);

  const unlockedProfileIds = useMemo(
    () => profiles.filter((p) => !p.pin_hash || p.id === profileId || unlockedIds.has(p.id)).map((p) => p.id),
    [profiles, profileId, unlockedIds]
  );

  const handleSwitchToGlobal = () => {
    const locked = profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id));
    if (locked.length > 0) { setPinQueue(locked); setPinQueueIdx(0); }
    else { localStorage.setItem(viewModeKey(profileId), "global"); setViewMode("global"); }
  };
  const handleSwitchToProfile = () => { localStorage.setItem(viewModeKey(profileId), "profile"); setViewMode("profile"); };
  const advancePinQueue = (unlockedId?: number) => {
    if (unlockedId !== undefined) unlockProfile(unlockedId);
    const next = pinQueueIdx + 1;
    if (next >= pinQueue.length) {
      setPinQueue([]); setPinQueueIdx(0);
      localStorage.setItem(viewModeKey(profileId), "global"); setViewMode("global");
    } else { setPinQueueIdx(next); }
  };

  const isGlobalActive = viewMode === "global";
  const pinTarget = pinQueue.length > 0 && pinQueueIdx < pinQueue.length ? pinQueue[pinQueueIdx] : null;

  const visibleProfiles = useMemo(
    () => isGlobalActive ? profiles.filter((p) => unlockedProfileIds.includes(p.id)) : profiles.filter((p) => p.id === profileId),
    [isGlobalActive, profiles, unlockedProfileIds, profileId]
  );

  const lockedExcluded = isGlobalActive
    ? profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id))
    : [];

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  useEffect(() => {
    if (visibleProfiles.length === 0) { setData(new Map()); setLoading(false); return; }
    setLoading(true);
    (async () => {
      const db = await getDb();
      const [start, end] = monthBounds(month);
      const entries = await Promise.all(
        visibleProfiles.map(async (p) => {
          const [balRow, incRow, expRow, txRow, sparkRows, portfolioRow] = await Promise.all([
            db.select<{ account_id: number; account_type: string; name: string; balance_cents: number | null }[]>(
              `SELECT a.id as account_id, a.account_type, a.name,
                 (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
                  ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
               FROM accounts a WHERE a.profile_id=? AND a.account_type IN ('checking','credit')`,
              [p.id]
            ),
            db.select<{ total: number }[]>(
              `SELECT COALESCE(SUM(t.amount_cents),0) as total FROM transactions t JOIN accounts a ON a.id=t.account_id
               WHERE t.profile_id=? AND t.date>=? AND t.date<? AND t.amount_cents>0
                 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type!='credit'`,
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
            db.select<{ date: string; account_id: number; account_type: string; balance_cents: number }[]>(
              `SELECT t.date, t.account_id, a.account_type, t.balance_cents FROM transactions t
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
          const creditAccounts = balRow.filter((r) => r.account_type === "credit").map((r) => ({ id: r.account_id, name: r.name }));
          return [p.id, {
            profileId: p.id,
            balance: trackedAccounts.length > 0 ? trackedAccounts.reduce((s, r) => s + (r.balance_cents ?? 0), 0) : null,
            income: incRow[0]?.total ?? 0,
            expenses: expRow[0]?.total ?? 0,
            checkingSparkline: combineAccountBalances(sparkRows.filter((r) => r.account_type === "checking"))
              .map((r) => ({ date: r.date, balance: r.balance_cents / 100 })),
            creditSparkline: separateAccountBalances(sparkRows.filter((r) => r.account_type === "credit")),
            creditAccounts,
            hasTransactions: (txRow[0]?.n ?? 0) > 0,
            portfolioValue: portfolioRow[0]?.total ?? 0,
          }] as [number, ProfileData];
        })
      );
      setData(new Map(entries));
      setLoading(false);
    })().catch(console.error);
  }, [visibleProfiles, month]);

  useEffect(() => {
    const ids = isGlobalActive ? unlockedProfileIds : [profileId];
    if (ids.length === 0) { setNetWorth(null); return; }
    computeNetWorth(ids).then(setNetWorth).catch(() => setNetWorth(null));
  }, [isGlobalActive, unlockedProfileIds, profileId]);

  const allData = [...data.values()];
  const totalIncome = allData.reduce((s, d) => s + d.income, 0);
  const totalExpenses = allData.reduce((s, d) => s + d.expenses, 0);
  const totalNet = totalIncome + totalExpenses;

  function handleSwitch(profile: Profile) {
    setActiveProfile(profile);
    navigate("/");
  }

  return (
    <div className="p-6 space-y-6 max-w-[1200px] mx-auto w-full">
      {pinTarget && (
        <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />
      )}

      {/* Header + scope toggle + month picker */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            {isGlobalActive
              ? `${visibleProfiles.length} of ${profiles.length} profile${profiles.length !== 1 ? "s" : ""}`
              : "This profile only"}
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold select-none" style={{ color: !isGlobalActive ? "#3b82f6" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
              Profile
            </span>
            <ScopeToggle isGlobal={isGlobalActive} onToggle={() => isGlobalActive ? handleSwitchToProfile() : handleSwitchToGlobal()} />
            <span className="text-sm font-semibold select-none" style={{ color: isGlobalActive ? "#C08A1C" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
              Global
            </span>
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
      </div>

      <ManageAccountsPanel profileId={profileId} special />

      {/* Locked-profile warning */}
      {lockedExcluded.length > 0 && (
        <div className="rounded-2xl px-5 py-4 flex flex-col gap-3"
          style={{ border: "1px solid rgba(245,158,11,0.35)", backgroundColor: "rgba(245,158,11,0.07)" }}>
          <p className="text-sm font-semibold" style={{ color: "#b45309" }}>
            {lockedExcluded.length === 1 ? "1 profile is PIN-locked" : `${lockedExcluded.length} profiles are PIN-locked`}
            {" "}— excluded from combined totals below.
          </p>
          <div className="flex flex-wrap gap-2">
            {lockedExcluded.map((p) => (
              <button key={p.id} onClick={() => { setPinQueue([p]); setPinQueueIdx(0); }}
                className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                style={{ border: "1px solid rgba(245,158,11,0.5)", color: "#92400e", backgroundColor: "transparent" }}
                onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "rgba(245,158,11,0.12)")}
                onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              >
                Unlock {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Net worth + income/expenses banner */}
      {!loading && netWorth !== null && (
        <div className="border rounded-2xl p-5 bg-[hsl(var(--muted))]/40">
          <p className="text-xs text-[hsl(var(--muted-foreground))] uppercase tracking-wide font-medium mb-3">
            {isGlobalActive ? "Combined — unlocked profiles" : "This profile"}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Liquid</p>
              <p className="text-xl font-bold">{formatCurrency(netWorth.liquidCents)}</p>
            </div>
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Investments</p>
              <p className="text-xl font-bold">{formatCurrency(netWorth.investmentCents)}</p>
            </div>
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Debt</p>
              <p className={`text-xl font-bold ${netWorth.debtCents < 0 ? "text-red-500" : ""}`}>
                {formatCurrency(netWorth.debtCents)}
              </p>
            </div>
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Net Worth</p>
              <p className={`text-xl font-bold ${netWorth.netWorthCents >= 0 ? "text-green-600" : "text-red-500"}`}>
                {formatCurrency(netWorth.netWorthCents)}
              </p>
            </div>
          </div>
          <div className="flex gap-8 flex-wrap pt-3 border-t">
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Income</p>
              <p className="text-lg font-bold text-green-600">{formatCurrency(totalIncome)}</p>
            </div>
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Expenses</p>
              <p className="text-lg font-bold text-red-500">{formatCurrency(Math.abs(totalExpenses))}</p>
            </div>
            <div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Net</p>
              <p className={`text-lg font-bold ${totalNet >= 0 ? "text-green-600" : "text-red-500"}`}>
                {formatCurrency(totalNet)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Profile cards grid */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {visibleProfiles.map((profile) => {
            const d = data.get(profile.id);
            const net = (d?.income ?? 0) + (d?.expenses ?? 0);
            return (
              <button key={profile.id} onClick={() => handleSwitch(profile)}
                className="border rounded-2xl p-5 text-left hover:shadow-md transition-all duration-150
                           bg-[hsl(var(--background))] active:scale-[0.99] chart-clickable"
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
                          {d.portfolioValue > 0 ? "Net Worth" : "Current Balance"}
                        </p>
                        <p className={`text-2xl font-bold ${(d.balance + d.portfolioValue) >= 0 ? "text-green-600" : "text-red-500"}`}>
                          {formatCurrency(d.balance + d.portfolioValue)}
                        </p>
                      </div>
                    )}

                    {(d.checkingSparkline.length > 1 || (d.creditAccounts.length > 0 && d.creditSparkline.length > 1)) && (
                      <div className="mb-3 -mx-1">
                        {d.checkingSparkline.length > 1 && (
                          <div className="h-14">
                            <ResponsiveContainer width="100%" height="100%">
                              <AreaChart data={d.checkingSparkline} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                                <defs>
                                  <linearGradient id={`grad-${profile.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={profile.avatar_color} stopOpacity={0.3} />
                                    <stop offset="95%" stopColor={profile.avatar_color} stopOpacity={0} />
                                  </linearGradient>
                                </defs>
                                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }}
                                  formatter={(v) => [`$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Checking"]}
                                  labelFormatter={(l) => String(l)} />
                                <Area type="monotone" dataKey="balance" stroke={profile.avatar_color} strokeWidth={1.5} fill={`url(#grad-${profile.id})`} dot={false} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                        {d.creditAccounts.length > 0 && d.creditSparkline.length > 1 && (
                          <div className="h-8 mt-0.5">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={d.creditSparkline} margin={{ top: 1, right: 2, bottom: 1, left: 2 }}>
                                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }}
                                  formatter={(v, name) => [`$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, name]}
                                  labelFormatter={(l) => String(l)} />
                                {d.creditAccounts.map((acc, i) => (
                                  <Line key={acc.id} type="monotone" isAnimationActive={false} name={acc.name}
                                    dataKey={(pt: { byAccount: Record<number, number> }) => (pt.byAccount[acc.id] ?? 0) / 100}
                                    stroke={accountChartColor(i)} strokeWidth={1.25} dot={false} />
                                ))}
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        )}
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
          {isGlobalActive && lockedExcluded.map((profile) => (
            <button key={profile.id} onClick={() => { setPinQueue([profile]); setPinQueueIdx(0); }}
              className="border border-dashed rounded-2xl p-5 text-left hover:shadow-md transition-all duration-150
                         bg-[hsl(var(--background))] active:scale-[0.99]"
            >
              <div className="flex items-center gap-2.5 mb-4">
                <span className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                  style={{ backgroundColor: profile.avatar_color }}>
                  {profile.name.charAt(0).toUpperCase()}
                </span>
                <div>
                  <p className="font-semibold leading-tight">{profile.name}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">PIN-locked</p>
                </div>
              </div>
              <p className="text-sm text-[hsl(var(--muted-foreground))] italic py-4 text-center">
                🔒 Enter PIN to include in totals
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
