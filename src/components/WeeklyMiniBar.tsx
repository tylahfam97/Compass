interface WeeklyMiniBarProps {
  /** 7 values indexed Mon(0)…Sun(6), in cents */
  dailyAmounts: number[];
  /** Daily target in cents (limit for budgets, target/7 for goals) */
  dailyTarget: number;
  /** If true, going OVER is bad (budget). If false, going over is good (income goal). */
  overIsBad?: boolean;
  className?: string;
}

const DOW_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

/** Returns 0=Mon … 6=Sun index for today */
function todayDow(): number {
  return (new Date().getDay() + 6) % 7;
}

export default function WeeklyMiniBar({
  dailyAmounts,
  dailyTarget,
  overIsBad = true,
  className = "",
}: WeeklyMiniBarProps) {
  const today = todayDow();
  const max = Math.max(dailyTarget * 1.5, ...dailyAmounts, 1);

  return (
    <div className={`flex gap-1 items-end h-10 ${className}`}>
      {dailyAmounts.map((amount, i) => {
        const isFuture = i > today;
        const heightPct = isFuture ? 0 : Math.min(100, (amount / max) * 100);
        const isOver = amount > dailyTarget;
        const isToday = i === today;

        let barColor = "bg-[hsl(var(--muted-foreground))]/20";
        if (!isFuture && amount > 0) {
          if (overIsBad) {
            barColor = isOver ? "bg-red-400" : "bg-emerald-500";
          } else {
            barColor = amount >= dailyTarget ? "bg-emerald-500" : "bg-amber-400";
          }
        }

        return (
          <div key={i} className="flex flex-col items-center gap-0.5 flex-1">
            <div className="w-full flex flex-col justify-end h-8">
              <div
                className={`w-full rounded-sm transition-all ${barColor} ${
                  isToday ? "ring-1 ring-offset-1 ring-[hsl(var(--foreground))]/30" : ""
                }`}
                style={{ height: isFuture ? "2px" : `${Math.max(2, heightPct)}%` }}
              />
            </div>
            <span
              className={`text-[9px] leading-none font-medium ${
                isToday
                  ? "text-[hsl(var(--foreground))]"
                  : "text-[hsl(var(--muted-foreground))]"
              }`}
            >
              {DOW_LABELS[i]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
