import { useId } from "react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { formatCurrency, formatDate } from "@/lib/utils";
import { series } from "@/lib/chartTheme";
import type { OverviewAccount, OverviewAccountKind } from "@/lib/overviewData";

/**
 * Every account in scope as one lookup table, grouped by what it is. Overview's roster
 * differs from the Dashboard's account rows on purpose: it spans profiles, it includes
 * investment accounts, and exact lookup matters more here than drill-down.
 *
 * Dot colours follow the waterline: the sea family is what you own, warning and error are
 * what you owe, so the group an account belongs to reads before the number does.
 */
interface AccountRosterProps {
  accounts: OverviewAccount[];
  /** Profile name per id. A column appears only when more than one profile is in scope. */
  profileNames: Map<number, string>;
}

const KIND_LABEL: Record<OverviewAccountKind, string> = {
  checking: "Bank",
  investment: "Investments",
  credit: "Credit cards",
  loan: "Loans",
};

const KIND_DOT: Record<OverviewAccountKind, string> = {
  checking: "hsl(var(--sea))",
  investment: "hsl(var(--sea) / 0.5)",
  credit: "hsl(var(--warning))",
  loan: "hsl(var(--error))",
};

const ORDER: OverviewAccountKind[] = ["checking", "investment", "credit", "loan"];

function Sparkline({ name, points }: { name: string; points: { date: string; balance_cents: number }[] }) {
  const gradientId = useId().replace(/:/g, "");
  if (points.length < 2) return null;
  const delta = points[points.length - 1].balance_cents - points[0].balance_cents;
  return (
    <div
      className="h-7 w-full"
      role="img"
      aria-label={`${name} balance trend, ${delta >= 0 ? "up" : "down"} ${formatCurrency(Math.abs(delta))} over the period shown`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series.balance} stopOpacity={0.32} />
              <stop offset="100%" stopColor={series.balance} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="balance_cents" stroke={series.balance} strokeWidth={1.5} fill={`url(#${gradientId})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function AccountRoster({ accounts, profileNames }: AccountRosterProps) {
  const showProfile = profileNames.size > 1;
  const groups = ORDER.map((kind) => ({ kind, rows: accounts.filter((a) => a.kind === kind) })).filter((g) => g.rows.length > 0);

  return (
    <div className="overview-roster">
      <table>
        <caption className="sr-only">Every account in scope, with its latest recorded balance</caption>
        <thead>
          <tr>
            <th scope="col">Account</th>
            {showProfile && <th scope="col">Profile</th>}
            <th scope="col" data-num>Balance</th>
            <th scope="col">Recorded</th>
            <th scope="col"><span className="sr-only">Trend</span></th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.kind}>
            <tr className="roster-group">
              <th scope="colgroup" colSpan={showProfile ? 5 : 4}>
                <span className="roster-dot" style={{ backgroundColor: KIND_DOT[group.kind] }} aria-hidden="true" />
                {KIND_LABEL[group.kind]}
              </th>
            </tr>
            {group.rows.map((a) => (
              <tr key={a.id} data-hidden={a.hidden ? "true" : undefined}>
                <th scope="row">
                  {a.name}
                  {a.hidden && <span className="roster-note">Not counted</span>}
                </th>
                {showProfile && <td className="roster-muted">{profileNames.get(a.profileId) ?? ""}</td>}
                <td data-num className={`tabular-nums ${a.balanceCents != null && a.balanceCents < 0 ? "text-[hsl(var(--error))]" : ""}`}>
                  {a.balanceCents == null ? <span className="roster-muted">No recorded balance</span> : formatCurrency(a.balanceCents)}
                </td>
                <td className="roster-muted">{a.balanceDate ? formatDate(a.balanceDate) : ""}</td>
                <td className="roster-spark">{!a.hidden && <Sparkline name={a.name} points={a.series} />}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
