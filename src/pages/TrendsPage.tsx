import { useState, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";

interface MonthRow {
  month: string;
  income: number;
  expenses: number;
}

interface CatMonthRow {
  month: string;
  category: string;
  color: string;
  total: number;
}

interface StackedRow {
  month: string;
  [cat: string]: string | number;
}

const RANGE_OPTIONS = [3, 6, 12];

export default function TrendsPage() {
  const [range, setRange] = useState(6);
  const [monthly, setMonthly] = useState<MonthRow[]>([]);
  const [stacked, setStacked] = useState<StackedRow[]>([]);
  const [catColors, setCatColors] = useState<Record<string, string>>({});
  const [catNames, setCatNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const db = await getDb();

      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (range - 1));
      const start = d.toISOString().split("T")[0];

      const [incExpRows, catRows] = await Promise.all([
        db.select<{ month: string; income: number; expenses: number }[]>(
          `SELECT strftime('%Y-%m', date) as month,
                  SUM(CASE WHEN amount_cents>0 THEN amount_cents ELSE 0 END) as income,
                  SUM(CASE WHEN amount_cents<0 THEN ABS(amount_cents) ELSE 0 END) as expenses
           FROM transactions WHERE date>=? GROUP BY month ORDER BY month`,
          [start]
        ),
        db.select<CatMonthRow[]>(
          `SELECT strftime('%Y-%m', t.date) as month,
                  c.name as category, c.color,
                  SUM(ABS(t.amount_cents)) as total
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.date>=? AND t.amount_cents<0
           GROUP BY month, t.category_id ORDER BY month`,
          [start]
        ),
      ]);

      if (cancelled) return;

      setMonthly(incExpRows);

      // Bucket into top-6 categories + "Other" to keep charts readable
      const TOP_N = 6;
      const catTotals: Record<string, number> = {};
      catRows.forEach((r) => { catTotals[r.category] = (catTotals[r.category] ?? 0) + r.total; });
      const topCats = Object.entries(catTotals)
        .sort(([, a], [, b]) => b - a)
        .slice(0, TOP_N)
        .map(([name]) => name);
      const topSet = new Set(topCats);
      const hasOther = catRows.some((r) => !topSet.has(r.category));

      const colorMap: Record<string, string> = {};
      catRows.forEach((r) => { if (topSet.has(r.category)) colorMap[r.category] = r.color; });
      if (hasOther) colorMap["Other"] = "#9ca3af";
      setCatColors(colorMap);
      setCatNames([...topCats, ...(hasOther ? ["Other"] : [])]);

      const byMonth: Record<string, StackedRow> = {};
      catRows.forEach((r) => {
        if (!byMonth[r.month]) byMonth[r.month] = { month: r.month };
        const key = topSet.has(r.category) ? r.category : "Other";
        byMonth[r.month][key] = ((byMonth[r.month][key] as number) ?? 0) + r.total;
      });
      setStacked(Object.values(byMonth).sort((a, b) => String(a.month).localeCompare(String(b.month))));
      setLoading(false);
    }
    load().catch(console.error);
    return () => { cancelled = true; };
  }, [range]);

  const hasData = monthly.length > 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Spending Trends</h1>
        <div className="flex gap-2">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                range === r
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "border hover:bg-[hsl(var(--muted))]"
              }`}
            >
              {r}mo
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-[hsl(var(--muted-foreground))]">Loading…</p>}

      {!loading && !hasData && (
        <p className="text-[hsl(var(--muted-foreground))] text-center mt-16">
          No data yet. Import a bank statement to see trends.
        </p>
      )}

      {!loading && hasData && (
        <>
          {/* Income vs Expenses */}
          <div className="border rounded-xl p-5">
            <h2 className="font-semibold mb-4">Income vs Expenses</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthly} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis
                  tickFormatter={(v) => `$${Math.round(v / 100)}`}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--background))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(v) => formatCurrency(v as number)}
                />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
                <Bar dataKey="income" name="Income" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Stacked by category */}
          {stacked.length > 0 && catNames.length > 0 && (
            <div className="border rounded-xl p-5">
              <h2 className="font-semibold mb-4">Spending by Category</h2>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={stacked} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis
                    tickFormatter={(v) => `$${Math.round(v / 100)}`}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--background))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                    formatter={(v) => formatCurrency(v as number)}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: "11px", paddingTop: "8px", lineHeight: "20px" }}
                  />
                  {catNames.map((cat) => (
                    <Bar
                      key={cat}
                      dataKey={cat}
                      stackId="cats"
                      fill={catColors[cat] ?? "#9ca3af"}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  );
}

