import type { CSSProperties } from "react";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * Read-only ledger row using the same .activity-row grid and per-row category wash as the
 * Transactions page, so "recent activity" elsewhere is the same object. `compact` drops
 * the selection and edit columns.
 */
export interface ActivityRowTransaction {
  id: number;
  date: string;
  description: string;
  amount_cents: number;
  category_name?: string | null;
  /** Already harmonized by the caller. */
  category_color?: string | null;
  account_name?: string | null;
}

interface ActivityRowProps {
  transaction: ActivityRowTransaction;
  onOpen?: (transaction: ActivityRowTransaction) => void;
  compact?: boolean;
}

export default function ActivityRow({ transaction: t, onOpen, compact = false }: ActivityRowProps) {
  const credit = t.amount_cents > 0;
  const style = { "--category-color": t.category_color ?? "hsl(var(--muted-foreground))" } as CSSProperties;
  const description = (
    <>
      <span className="font-medium">{t.description}</span>
      <span className="text-xs text-[hsl(var(--muted-foreground))]">{t.account_name ?? formatDate(t.date)}{t.account_name ? `, ${formatDate(t.date)}` : ""}</span>
    </>
  );
  return (
    <div className="activity-row category-wash" data-compact={compact ? "true" : undefined} style={style}>
      <span className="activity-direction" aria-hidden="true">{credit ? <ArrowDownLeftIcon size={18} /> : <ArrowUpRightIcon size={18} />}</span>
      {onOpen ? (
        <button type="button" className="activity-description" onClick={() => onOpen(t)} aria-label={`${t.description}, ${formatCurrency(t.amount_cents)}, ${formatDate(t.date)}`}>
          {description}
        </button>
      ) : (
        <div className="activity-description">{description}</div>
      )}
      <span className="activity-category truncate">{t.category_name ?? "Uncategorized"}</span>
      <span className={`activity-amount ${credit ? "text-[hsl(var(--success))]" : ""}`}>{formatCurrency(t.amount_cents)}</span>
    </div>
  );
}
