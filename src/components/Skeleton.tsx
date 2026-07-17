/** A single pulsing placeholder block - the building block for page-level skeleton loaders. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-[hsl(var(--muted))] ${className}`} />;
}

/** Skeleton for a budget/goal-style card: accent bar + title row + progress bar + amounts row. */
export function CardRowSkeleton() {
  return (
    <div className="border rounded-2xl p-5 space-y-3">
      <div className="flex items-center gap-2.5">
        <Skeleton className="w-2.5 h-2.5 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-16 rounded-full" />
      </div>
      <Skeleton className="h-2.5 w-full rounded-full" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3.5 w-20" />
      </div>
    </div>
  );
}

/** Skeleton for a table-row-shaped placeholder (Transactions/Investments tables). */
export function TableRowSkeleton({ cols = 4 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className={`h-3.5 ${i === 0 ? "w-24" : "flex-1"}`} />
      ))}
    </div>
  );
}

/** A vertical stack of card skeletons, for Budgets/Goals-style list pages. */
export function CardListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => <CardRowSkeleton key={i} />)}
    </div>
  );
}

/** A bordered table-shaped skeleton, for Transactions/Investments-style table pages. */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="border rounded-xl overflow-hidden">
      {Array.from({ length: rows }).map((_, i) => <TableRowSkeleton key={i} cols={cols} />)}
    </div>
  );
}
