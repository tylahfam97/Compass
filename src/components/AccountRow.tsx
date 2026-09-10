import { useId, type ReactNode } from "react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { series } from "@/lib/chartTheme";
import TrendChip from "@/components/TrendChip";

/**
 * One row for a bank, credit or loan account on the Dashboard, replacing three copies of a
 * bordered tile. The main button opens the account; hide/show and any extra action are
 * sibling buttons, so nothing interactive nests inside anything interactive.
 */
interface AccountRowProps {
  name: string;
  kind: "bank" | "credit" | "loan";
  balanceCents: number;
  balanceDate?: string | null;
  meta?: string;
  trendCents?: number | null;
  series?: { date: string; balance_cents: number }[];
  hidden?: boolean;
  onOpen: () => void;
  onToggleHidden?: (next: boolean) => void;
  extraAction?: { label: string; onClick: () => void; icon: ReactNode };
  className?: string;
}

const DOT: Record<AccountRowProps["kind"], string> = {
  bank: "hsl(var(--sea))",
  credit: "hsl(var(--warning))",
  loan: "hsl(var(--error))",
};

export default function AccountRow({ name, kind, balanceCents, balanceDate, meta, trendCents, series: points, hidden = false, onOpen, onToggleHidden, extraAction, className }: AccountRowProps) {
  const gradientId = useId().replace(/:/g, "");
  const metaParts = [balanceDate ? `Recorded ${formatDate(balanceDate)}` : null, meta].filter(Boolean).join(", ");
  const showSpark = !hidden && points && points.length >= 2;
  const trendWord = trendCents == null ? "" : trendCents >= 0 ? "up" : "down";

  return (
    <div className={cn("account-row", className)} data-hidden={hidden ? "true" : undefined}>
      <button type="button" className="account-row-main" aria-label={`${name} details`} onClick={onOpen}>
        <span className="w-1.5 h-1.5 rounded-full justify-self-center" style={{ backgroundColor: DOT[kind], opacity: 0.7 }} aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-sm font-medium truncate">{name}{hidden && <span className="ml-2 text-xs font-normal text-[hsl(var(--muted-foreground))]">Hidden</span>}</span>
          {metaParts && <span className="block text-xs text-[hsl(var(--muted-foreground))] truncate">{metaParts}</span>}
        </span>
        <span className="text-right">
          <span className={cn("block text-lg font-medium tabular-nums leading-tight", balanceCents < 0 && "text-[hsl(var(--error))]")}>{formatCurrency(balanceCents)}</span>
          {typeof trendCents === "number" && !hidden && (
            <span className="block mt-0.5"><TrendChip deltaCents={trendCents} compareLabel="over the period" invert={kind !== "bank"} /></span>
          )}
        </span>
      </button>
      <div data-spark className="h-8 w-24 justify-self-end">
        {showSpark && (
          <div role="img" aria-label={`${name} balance trend, ${trendWord} ${formatCurrency(Math.abs(trendCents ?? 0))}`} className="h-full w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={series.balance} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={series.balance} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="balance_cents" stroke={series.balance} strokeWidth={1.5} fill={`url(#${gradientId})`} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 justify-self-end">
        {onToggleHidden && (
          <button type="button" className="workspace-icon" aria-label={hidden ? `Show ${name}` : `Hide ${name} from dashboard`} onClick={() => onToggleHidden(!hidden)}>
            {hidden ? <EyeIcon size={14} /> : <EyeSlashIcon size={14} />}
          </button>
        )}
        {extraAction && !hidden && (
          <button type="button" className="workspace-icon" aria-label={extraAction.label} title={extraAction.label} onClick={extraAction.onClick}>
            {extraAction.icon}
          </button>
        )}
      </div>
    </div>
  );
}
