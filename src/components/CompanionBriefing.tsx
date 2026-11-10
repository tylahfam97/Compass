import { useId, useState } from "react";
import { ArrowUpIcon, CaretRightIcon, CheckIcon, GaugeIcon, InfoIcon, TrayArrowDownIcon } from "@phosphor-icons/react";
import type { Insight } from "@/lib/types";
import type { BriefLine, Briefing } from "@/lib/insights/companion";
import { insightActionLabel } from "@/lib/insightActions";
import { ACTION_BUTTON_CLS } from "@/components/InsightCard";

/**
 * The top of Insights: what changed since the last day this page was opened, the one thing
 * to do next, and what the reading is based on. Wording and comparison live in
 * lib/insights/companion.ts; this only lays the lines out and takes the user to a finding.
 */
export interface BriefingCoverage {
  txCount: number;
  accounts: number;
  first: string | null;
  newest: string | null;
}

interface CompanionBriefingProps {
  briefing: Briefing;
  today: Date;
  coverage: BriefingCoverage;
  /** Day of the visit being compared against, when there is one. */
  since: string | null;
  /** The top-ranked action item, if any. */
  next: Insight | null;
  onShow: (insightId: string) => void;
  onApply: (insight: Insight) => void;
}

const LINE_ICONS: Partial<Record<BriefLine["kind"], React.ElementType>> = {
  escalated: ArrowUpIcon,
  resolved: CheckIcon,
  score: GaugeIcon,
  data: TrayArrowDownIcon,
  note: InfoIcon,
};

/** Where a finding sits in Review. Says in words what the marker's colour says. */
const GROUP_TAG: Record<Insight["severity"], string> = { warning: "Action item", info: "Observation", success: "Win" };

const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long" });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
/** "Nov 6, 2026" with non-breaking spaces, so a date never wraps away from its year. */
const fullDate = (iso: string) => dateFormat.format(new Date(`${iso}T12:00:00`)).replace(/ /g, "\u00a0");

function daysLeftLabel(today: Date): string {
  const left = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();
  const month = monthFormat.format(today);
  return left === 0 ? `last day of ${month}` : `${left} ${left === 1 ? "day" : "days"} left in ${month}`;
}

export default function CompanionBriefing({ briefing, today, coverage, since, next, onShow, onApply }: CompanionBriefingProps) {
  const headingId = useId();
  // Findings the user has already followed to their row: the marker goes quiet.
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const nextLabel = next ? insightActionLabel(next) : null;
  // The headline counts findings; the score and the data on file are context beside them.
  const isContext = (line: BriefLine) => line.kind === "score" || line.kind === "data";
  const findings = briefing.lines.filter((line) => !isContext(line));
  const context = briefing.lines.filter(isContext);

  return (
    <section className="companion" aria-labelledby={headingId}>
      <div className="companion-head">
        <h2 id={headingId} className="text-[17px] font-semibold leading-tight">{briefing.headline}</h2>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{dayFormat.format(today)} · {daysLeftLabel(today)}</p>
      </div>

      <div className="companion-body">
        <ul className="companion-log">
          {findings.map((line, index) => {
            const Icon = LINE_ICONS[line.kind];
            const id = line.insightId;
            return (
              <li key={`${line.kind}-${id ?? index}`} data-tone={line.tone}>
                {Icon
                  ? <Icon size={14} weight="bold" className="companion-mark" aria-hidden="true" />
                  : <span className="companion-dot" data-followed={id && followed.has(id) ? "" : undefined} style={{ animationDelay: `${index * 90}ms` }} aria-hidden="true" />}
                {id ? (
                  <button
                    type="button"
                    className="companion-line"
                    onClick={() => { setFollowed((prev) => new Set(prev).add(id)); onShow(id); }}
                  >
                    <span>{line.kind === "new" && <span className="sr-only">New: </span>}{line.text}</span>
                    {line.tone !== "neutral" && <span className="companion-tag">{GROUP_TAG[line.tone]}</span>}
                    <CaretRightIcon size={12} weight="bold" className="companion-caret" aria-hidden="true" />
                    <span className="sr-only">Show in Review</span>
                  </button>
                ) : (
                  <p className={line.kind === "note" ? "text-[hsl(var(--muted-foreground))]" : undefined}>{line.text}</p>
                )}
              </li>
            );
          })}
        </ul>

        <div className="companion-aside">
          <div className="companion-next">
            {next ? (
              <>
                {/* Review ranks action items by the money at stake; housekeeping rows lead when
                    every other figure depends on them. Say which it is. */}
                <p><span className="text-[hsl(var(--muted-foreground))]">{(next.impactCents ?? 0) !== 0 ? "Most at stake: " : "First to fix: "}</span><span className="font-medium">{next.title}</span></p>
                <div className="companion-next-actions">
                  {nextLabel && next.action && <button type="button" className={ACTION_BUTTON_CLS} onClick={() => onApply(next)}>{nextLabel}</button>}
                  <button type="button" className="text-xs text-[hsl(var(--gold-ink))] hover:underline" onClick={() => onShow(next.id)}>See it in Review</button>
                </div>
              </>
            ) : (
              <p className="text-[hsl(var(--muted-foreground))]">No action items right now.</p>
            )}
          </div>

          {context.length > 0 && (
            <ul className="companion-meta">
              {context.map((line) => {
                const Icon = LINE_ICONS[line.kind] ?? InfoIcon;
                return (
                  <li key={line.kind} data-tone={line.tone}>
                    <Icon size={13} weight="bold" className="companion-mark" aria-hidden="true" />
                    <p>{line.text}</p>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="companion-coverage">
            Based on {coverage.txCount.toLocaleString("en-US")} {coverage.txCount === 1 ? "transaction" : "transactions"} across {coverage.accounts} {coverage.accounts === 1 ? "account" : "accounts"}
            {coverage.first && coverage.newest ? `, ${fullDate(coverage.first)} to ${fullDate(coverage.newest)}` : ""}.
            {since ? ` Compared with your visit on ${fullDate(since)}.` : ""}
          </p>
        </div>
      </div>
    </section>
  );
}
