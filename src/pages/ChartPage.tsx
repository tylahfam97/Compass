import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowCounterClockwiseIcon, PauseIcon, PlayIcon, XIcon } from "@phosphor-icons/react";
import { buildMoneyFlow, type FlowTxn, type MoneyFlow } from "@/lib/flows";
import { getMoneyFlowInputs } from "@/lib/flowData";
import { formatCurrency, formatCurrencyWhole, formatDate, formatMonthLong } from "@/lib/utils";
import { staggerContainer, riseIn } from "@/lib/motionPresets";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useIsDark } from "@/hooks/useIsDark";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import { useProfileStore } from "@/stores/profileStore";
import { handleLoadFailure } from "@/stores/toastStore";
import { harmonizeColor } from "@/lib/chartTheme";
import MoneyFlowMap, { type FlowSelection } from "@/components/MoneyFlowMap";
import MonthPicker from "@/components/MonthPicker";
import StatRow from "@/components/StatRow";
import SectionHeading from "@/components/SectionHeading";
import EmptyState from "@/components/EmptyState";
import ActivityRow from "@/components/ActivityRow";
import TransactionDetailModal from "@/components/TransactionDetailModal";
import CountUp from "@/components/CountUp";
import { Skeleton } from "@/components/Skeleton";

const INSPECTOR_PAGE = 40;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateFor(month: string, day: number): string {
  return `${month}-${String(day + 1).padStart(2, "0")}`;
}

export default function ChartPage() {
  const [month, setMonth] = useAutoMonth("chart");
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;
  const isDark = useIsDark();
  const reduced = useAppReducedMotion();
  const mode = isDark ? "dark" : "light";

  const [flow, setFlow] = useState<MoneyFlow | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<FlowSelection | null>(null);
  const [day, setDay] = useState(0);
  const [burstKey, setBurstKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [detail, setDetail] = useState<FlowTxn | null>(null);

  const today = todayIso();
  const monthState = month < today.slice(0, 7) ? "past" : month > today.slice(0, 7) ? "future" : "current";

  const load = useCallback(async () => {
    setLoading(true);
    const inputs = await getMoneyFlowInputs(profileId, month);
    const built = buildMoneyFlow({ ...inputs, month });
    setFlow(built);
    setSelected(null);
    setShowAll(false);
    setPlaying(false);
    // Land on today for the current month, the last day otherwise, so the currents read full.
    const lastDay = built.days - 1;
    setDay(monthState === "current" ? Math.min(lastDay, Number(today.slice(8, 10)) - 1) : lastDay);
    setLoading(false);
  }, [profileId, month, monthState, today]);

  useEffect(() => {
    load().catch(handleLoadFailure("your chart", setLoading, () => void load()));
  }, [load]);

  // Playback: one day every half second, stopping at the end and whenever the window blurs.
  useEffect(() => {
    if (!playing || reduced || !flow) return;
    if (day >= flow.days - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => { setDay((d) => d + 1); setBurstKey((k) => k + 1); }, 520);
    const stop = () => setPlaying(false);
    document.addEventListener("visibilitychange", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", stop);
      window.removeEventListener("blur", stop);
    };
  }, [playing, reduced, flow, day]);

  const chooseDay = (d: number) => {
    setPlaying(false);
    setDay(d);
    setBurstKey((k) => k + 1);
  };

  const nodeById = useMemo(() => new Map((flow?.nodes ?? []).map((n) => [n.id, n])), [flow]);

  /** Rows behind the selection, or the scrubbed day's movements when nothing is selected. */
  const inspector = useMemo(() => {
    if (!flow) return null;
    const rows = (ids: Iterable<number>) => {
      const out: FlowTxn[] = [];
      const seen = new Set<number>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const t = flow.txns.get(id);
        if (t) out.push(t);
      }
      return out.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    };
    if (selected?.type === "edge") {
      const e = flow.edges.find((edge) => edge.id === selected.id);
      if (!e) return null;
      const target = nodeById.get(e.target);
      return {
        title: `${nodeById.get(e.source)?.label ?? ""} to ${target?.label ?? ""}`,
        cents: e.cents,
        rows: rows(e.txnIds),
        categoryId: target?.kind === "category" ? target.categoryId ?? null : null,
        synthetic: e.txnIds.length === 0,
        kind: e.kind,
      };
    }
    if (selected?.type === "node") {
      const n = nodeById.get(selected.id);
      if (!n) return null;
      const ids = flow.edges.filter((e) => e.source === n.id || e.target === n.id).flatMap((e) => e.txnIds);
      return { title: n.label, cents: n.cents, rows: rows(ids), categoryId: n.kind === "category" ? n.categoryId ?? null : null, synthetic: ids.length === 0, kind: n.kind };
    }
    const iso = dateFor(month, day);
    const dayRows = [...flow.txns.values()].filter((t) => t.date === iso).sort((a, b) => a.id - b.id);
    const inCents = dayRows.filter((t) => t.amount_cents > 0 && t.account_type !== "credit").reduce((s, t) => s + t.amount_cents, 0);
    const outCents = dayRows.filter((t) => t.amount_cents < 0).reduce((s, t) => s - t.amount_cents, 0);
    return { title: formatDate(iso), cents: null, rows: dayRows, categoryId: null, synthetic: false, kind: null, inCents, outCents };
  }, [flow, selected, nodeById, month, day]);

  const syntheticNote = (kind: string | null) => {
    switch (kind) {
      case "stayed": return "Money that came into this account this month and had not left it by the end. Not a transaction, the gap between the two.";
      case "from-balance": return "This month spent more from the account than came in, so the difference came out of the balance it already held.";
      case "carried": return "Purchases on this card ran past the payments that reached it this month, so the difference stays on the card as balance.";
      case "paid-down": return "Payments to this card ran past its purchases this month, so the difference paid down the balance it carried.";
      default: return null;
    }
  };

  const heading = (
    <div className="workspace-heading chart-heading">
      <div>
        <h1>Chart</h1>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{formatMonthLong(month)}</p>
      </div>
      <MonthPicker value={month} onChange={setMonth} />
    </div>
  );

  if (loading || !flow) {
    return (
      <div className="workspace-page chart-workspace">
        {heading}
        <div className="space-y-6 mt-6">
          <Skeleton className="h-24" />
          <Skeleton className="h-[420px]" />
        </div>
      </div>
    );
  }

  if (flow.edges.length === 0) {
    return (
      <div className="workspace-page chart-workspace">
        {heading}
        <EmptyState
          title={`Nothing moved in ${formatMonthLong(month)}`}
          actions={
            <Link to="/import" className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-md text-sm font-medium hover:opacity-90 transition-opacity">
              Import a statement
            </Link>
          }
        >
          {monthState === "future"
            ? "This month has not started. Pick a month with imported activity to see where its money went."
            : "Import a bank or card statement that covers this month and its currents will appear here."}
        </EmptyState>
      </div>
    );
  }

  const { totals } = flow;
  const incomeShare = totals.incomeCents > 0 ? Math.round((totals.putAwayCents / totals.incomeCents) * 100) : null;
  const sourceCount = flow.nodes.filter((n) => n.kind === "income").length;
  const inspectorRows = inspector ? (showAll ? inspector.rows : inspector.rows.slice(0, INSPECTOR_PAGE)) : [];
  const dayIso = dateFor(month, day);

  return (
    <motion.div className="workspace-page chart-workspace" variants={staggerContainer} initial={reduced ? false : "hidden"} animate="show">
      {heading}

      {/* ── The bearing of the month: what reached somewhere that lasts, against what came in ── */}
      <motion.section variants={riseIn} className="chart-hero" aria-label="Where the month's money went">
        <StatRow
          items={[
            {
              label: "Reached savings, investments and debt",
              hero: true,
              tone: totals.putAwayCents > 0 ? "gold" : "muted",
              value: <CountUp value={totals.putAwayCents} format={(v) => formatCurrencyWhole(Math.round(v))} />,
              hint: incomeShare !== null ? `${incomeShare}% of what came in` : "No income recorded this month",
            },
            {
              label: "Came in",
              value: <CountUp value={totals.incomeCents} format={(v) => formatCurrencyWhole(Math.round(v))} />,
              hint: sourceCount > 0 ? `${sourceCount} ${sourceCount === 1 ? "source" : "sources"}` : undefined,
            },
            {
              label: "Spent",
              value: <CountUp value={totals.spentCents} format={(v) => formatCurrencyWhole(Math.round(v))} />,
              hint: totals.cardPaymentsCents > 0 ? "Card purchases counted once, not their payments" : "Bills and purchases",
            },
            totals.fromBalanceCents > 0 && totals.stayedCents === 0
              ? { label: "Drawn from balance", tone: "warning" as const, value: <CountUp value={totals.fromBalanceCents} format={(v) => formatCurrencyWhole(Math.round(v))} />, hint: "Spent beyond what came in" }
              : { label: "Stayed in checking", value: <CountUp value={totals.stayedCents} format={(v) => formatCurrencyWhole(Math.round(v))} />, hint: totals.carriedCents > 0 ? `${formatCurrencyWhole(totals.carriedCents)} carried on cards` : "Not yet spoken for" },
          ]}
        />
      </motion.section>

      {/* ── The map ── */}
      <motion.section variants={riseIn} className="chart-map" aria-label="Money flow map">
        <SectionHeading
          title="Where the money went"
          hint="Each ribbon is money that moved this month, as wide as the amount; the gold particles are the money in motion. Scrub the days to watch paydays arrive and bills leave, and click a current or a place for the transactions behind it."
        />
        {/* A four-column map needs room; on a phone it keeps its width and pans sideways, like
            a chart table, rather than collapsing into unreadable slivers. */}
        <div className="flow-scroll">
          <MoneyFlowMap flow={flow} day={day} selected={selected} onSelect={setSelected} mode={mode} reduced={reduced} burstKey={burstKey} />
        </div>
        <div className="flow-transport">
          {!reduced && (
            <button
              type="button"
              className="workspace-icon"
              title={playing ? "Pause the month" : "Play the month"}
              aria-label={playing ? "Pause the month" : "Play the month"}
              onClick={() => { if (day >= flow.days - 1) setDay(0); setPlaying((p) => !p); }}
            >
              {playing ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
            </button>
          )}
          <button type="button" className="workspace-icon" title="Back to the first of the month" aria-label="Back to the first of the month" onClick={() => chooseDay(0)}>
            <ArrowCounterClockwiseIcon size={16} />
          </button>
          <input
            type="range"
            min={0}
            max={flow.days - 1}
            step={1}
            value={day}
            aria-label="Inspect day"
            aria-valuetext={formatDate(dayIso)}
            onChange={(event) => chooseDay(Number(event.target.value))}
          />
          <time dateTime={dayIso}>{formatDate(dayIso)}</time>
        </div>
      </motion.section>

      {/* ── The transactions behind whatever is selected, or the day under the scrubber ── */}
      {inspector && (
        <motion.section variants={riseIn} className="chart-inspector" aria-label="Selected currents">
          <SectionHeading
            title={inspector.title}
            hint={
              inspector.cents !== null
                ? `${formatCurrency(inspector.cents)}${inspector.rows.length > 0 ? `, ${inspector.rows.length} ${inspector.rows.length === 1 ? "transaction" : "transactions"} in ${formatMonthLong(month)}` : ""}`
                : inspector.rows.length === 0
                  ? "Nothing posted on this day."
                  : `${inspector.rows.length} ${inspector.rows.length === 1 ? "movement" : "movements"}: ${formatCurrency(inspector.inCents ?? 0)} in, ${formatCurrency(inspector.outCents ?? 0)} out`
            }
          >
            <div className="flex items-center gap-3 shrink-0">
              {inspector.categoryId !== null && (
                <Link to="/transactions" state={{ month, category: inspector.categoryId }} className="text-xs text-[hsl(var(--gold-ink))] hover:underline">
                  View in Transactions
                </Link>
              )}
              {selected && (
                <button type="button" onClick={() => setSelected(null)} className="text-xs inline-flex items-center gap-1 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
                  <XIcon size={12} /> Clear
                </button>
              )}
            </div>
          </SectionHeading>
          {inspector.synthetic && syntheticNote(inspector.kind) && (
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-3 max-w-[64ch]">{syntheticNote(inspector.kind)}</p>
          )}
          {inspectorRows.length > 0 && (
            <div className="mt-2">
              {inspectorRows.map((t) => (
                <ActivityRow
                  key={t.id}
                  compact
                  transaction={{ ...t, category_color: t.category_color ? harmonizeColor(t.category_color, mode) : null }}
                  onOpen={() => setDetail(t)}
                />
              ))}
              {inspector.rows.length > INSPECTOR_PAGE && (
                <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-3 text-xs text-[hsl(var(--gold-ink))] hover:underline">
                  {showAll ? "Show fewer" : `Show ${inspector.rows.length - INSPECTOR_PAGE} more`}
                </button>
              )}
            </div>
          )}
        </motion.section>
      )}

      {detail && <TransactionDetailModal transaction={detail} onClose={() => setDetail(null)} />}
    </motion.div>
  );
}
