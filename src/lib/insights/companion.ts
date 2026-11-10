import type { Insight, InsightType } from "../types";

/**
 * What changed since the last visit. Insights are recomputed from the database every time, so
 * the list itself has no memory: a warning that cleared simply is not there any more, and a
 * new one looks like it was always there. This module keeps a small note of what the page
 * showed on the previous day it was opened and compares the next reading against it.
 *
 * The note lives in localStorage, outside the encrypted database, so it holds no titles,
 * merchants, amounts or balances: per insight only its type, its severity and a one-way hash
 * of its identifier; per visit the health score, the number of transactions on file and the
 * newest transaction date.
 */

type Severity = Insight["severity"];

export interface SeenInsight {
  /** One-way hash of the insight's stable key. */
  h: string;
  t: InsightType;
  s: Severity;
}

export interface VisitSnapshot {
  /** Local calendar day of the visit, YYYY-MM-DD. */
  day: string;
  /** Profile ids the reading covered ("1" or "1,2"). Readings of different scopes never compare. */
  scope: string;
  items: SeenInsight[];
  /** Health score 0..100, null when it was not measured. */
  score: number | null;
  txCount: number | null;
  newest: string | null;
}

export interface VisitMemory {
  /** The last visit on an earlier day: what today's readings are compared against. */
  baseline: VisitSnapshot | null;
  latest: VisitSnapshot | null;
}

/**
 * An insight's id with its dates removed. Most ids carry the month, quarter or balance date
 * they were computed for, so the same standing finding gets a new id every month; without
 * this every month rollover would read as "everything resolved, everything new".
 */
export function stableKey(id: string): string {
  return id.replace(/(?:^|_)20\d{2}(?:-\d{2}(?:-\d{2})?|Q[1-4])?(?=_|$)/g, "");
}

/** FNV-1a, 32 bit. Collisions only hide a change; nothing is ever read back out of the hash. */
function hashKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const seen = (i: Insight): SeenInsight => ({ h: hashKey(stableKey(i.id)), t: i.type, s: i.severity });

export function snapshotOf(
  insights: Insight[],
  meta: { day: string; scope: string; score: number | null; txCount: number | null; newest: string | null }
): VisitSnapshot {
  return { ...meta, items: insights.map(seen) };
}

/**
 * Folds a new reading into the memory. The baseline only moves when the day changes, so
 * reopening the page five minutes later still compares against the earlier day's visit
 * instead of against itself.
 */
export function rollVisit(memory: VisitMemory, now: VisitSnapshot): VisitMemory {
  if (!memory.latest) return { baseline: null, latest: now };
  if (memory.latest.day === now.day) return { baseline: memory.baseline, latest: now };
  return { baseline: memory.latest, latest: now };
}

export interface VisitDiff {
  /** Day of the visit being compared against; null on a first reading (or a changed scope). */
  since: string | null;
  /** Findings that were not there last time. */
  appeared: Insight[];
  /** There last time as an observation, an action item now. */
  escalated: Insight[];
  /** Action items from last time that are gone or have eased to an observation. */
  resolved: SeenInsight[];
  scoreDelta: number | null;
  /** Change in transactions on file; negative after deletions or merges. */
  txDelta: number | null;
}

export function diffVisit(baseline: VisitSnapshot | null, now: VisitSnapshot, insights: Insight[]): VisitDiff {
  if (!baseline || baseline.scope !== now.scope) {
    return { since: null, appeared: [], escalated: [], resolved: [], scoreDelta: null, txDelta: null };
  }
  const before = new Map(baseline.items.map((i) => [i.h, i]));
  const warningsNow = new Set(now.items.filter((i) => i.s === "warning").map((i) => i.h));
  const appeared: Insight[] = [];
  const escalated: Insight[] = [];
  for (const insight of insights) {
    const prior = before.get(seen(insight).h);
    if (!prior) appeared.push(insight);
    else if (insight.severity === "warning" && prior.s !== "warning") escalated.push(insight);
  }
  return {
    since: baseline.day,
    appeared,
    escalated,
    resolved: baseline.items.filter((i) => i.s === "warning" && !warningsNow.has(i.h)),
    scoreDelta: baseline.score !== null && now.score !== null ? now.score - baseline.score : null,
    txDelta: baseline.txCount !== null && now.txCount !== null ? now.txCount - baseline.txCount : null,
  };
}

// ── Wording ──────────────────────────────────────────────────────────────────

const localDate = (iso: string) => new Date(`${iso}T12:00:00`);
const shortDate = (iso: string, withYear = false) =>
  new Intl.DateTimeFormat("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" }).format(localDate(iso));

/** "yesterday", "Friday" within a week, otherwise "Nov 3" (with the year once it differs). */
export function sinceLabel(sinceIso: string, todayIso: string): string {
  const days = Math.round((localDate(todayIso).getTime() - localDate(sinceIso).getTime()) / 86_400_000);
  if (days === 1) return "yesterday";
  if (days >= 2 && days <= 6) return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(localDate(sinceIso));
  return shortDate(sinceIso, sinceIso.slice(0, 4) !== todayIso.slice(0, 4));
}

/** What a cleared action item is called. Only the type is remembered, so this is all there is to say. */
const RESOLVED_NOUN: Partial<Record<InsightType, string>> = {
  bills_this_week: "bill shortfall",
  scheduled_missing: "missed scheduled item",
  duplicate_charge: "possible duplicate charge",
  budget_pace: "budget overrun",
  goal_off_track: "off-track goal",
  emergency_fund_runway: "low cash runway",
  overdraft_alert: "overdraft fees",
  credit_card_debt_growing: "growing card balance",
  credit_card_debt_high: "high card balance",
  loan_debt_growing: "growing loan balance",
  loan_debt_high: "high loan balance",
  card_coverage_low: "card payments trailing spending",
  interest_paid: "card interest",
  fixed_costs_high: "high fixed costs",
  savings_rate_low: "low savings rate",
  overspend_streak: "overspending streak",
  stale_data: "out-of-date account",
  uncategorized_share: "uncategorized spending",
  net_worth_declining: "net worth dip",
  payday_cushion: "tight stretch before payday",
};

const resolvedNoun = (r: SeenInsight) => RESOLVED_NOUN[r.t] ?? r.t.replace(/_/g, " ");

export type BriefTone = "warning" | "info" | "success" | "neutral";

export interface BriefLine {
  kind: "new" | "escalated" | "resolved" | "score" | "data" | "note";
  tone: BriefTone;
  text: string;
  /** Set on lines about one current insight, so the page can take the user to its row. */
  insightId?: string;
}

export interface Briefing {
  headline: string;
  lines: BriefLine[];
}

/** New findings, and cleared ones, listed one by one before the rest are summarised. */
export const BRIEF_MAX_FINDINGS = 5;
export const BRIEF_MAX_RESOLVED = 3;

/**
 * Turns a diff into the few lines the page leads with. `diff.appeared` and `diff.escalated`
 * should already exclude anything the user dismissed. Every line states something that was
 * measured; when nothing moved, the reason is given rather than filler.
 */
export function buildBriefing(
  diff: VisitDiff,
  now: { todayIso: string; score: number | null; newest: string | null }
): Briefing {
  if (diff.since === null) {
    return {
      headline: "First reading",
      lines: [{
        kind: "note", tone: "neutral",
        text: "Nothing to compare yet. The next day you open this page, it leads with what changed since today. The note it keeps for that stays on this computer.",
      }],
    };
  }
  const label = sinceLabel(diff.since, now.todayIso);
  const lines: BriefLine[] = [];

  const findings: BriefLine[] = [
    ...diff.escalated.map((i): BriefLine => ({ kind: "escalated", tone: "warning", text: `Now needs action: ${i.title}`, insightId: i.id })),
    ...diff.appeared.filter((i) => i.severity === "warning").map((i): BriefLine => ({ kind: "new", tone: "warning", text: i.title, insightId: i.id })),
    ...diff.appeared.filter((i) => i.severity !== "warning").map((i): BriefLine => ({ kind: "new", tone: i.severity, text: i.title, insightId: i.id })),
  ];
  lines.push(...findings.slice(0, BRIEF_MAX_FINDINGS));
  if (findings.length > BRIEF_MAX_FINDINGS) {
    lines.push({ kind: "note", tone: "neutral", text: `${findings.length - BRIEF_MAX_FINDINGS} more new in Review below.` });
  }
  lines.push(...diff.resolved.slice(0, BRIEF_MAX_RESOLVED).map((r): BriefLine => ({ kind: "resolved", tone: "success", text: `No longer flagged: ${resolvedNoun(r)}` })));
  if (diff.resolved.length > BRIEF_MAX_RESOLVED) {
    lines.push({ kind: "note", tone: "neutral", text: `${diff.resolved.length - BRIEF_MAX_RESOLVED} more no longer flagged.` });
  }

  const changes = findings.length + diff.resolved.length;
  if (changes === 0) {
    lines.push({
      kind: "note", tone: "neutral",
      text: diff.txDelta === 0
        ? "No new transactions are on file since then, so nothing could move. Import to refresh the picture."
        : "The same findings as last time: nothing new and nothing cleared.",
    });
  }
  if (diff.scoreDelta !== null && diff.scoreDelta !== 0 && now.score !== null) {
    const up = diff.scoreDelta > 0;
    lines.push({ kind: "score", tone: up ? "success" : "warning", text: `Health score ${now.score}, ${up ? "up" : "down"} ${Math.abs(diff.scoreDelta)} since ${label}.` });
  }
  if (diff.txDelta !== null && diff.txDelta !== 0) {
    const n = Math.abs(diff.txDelta);
    const noun = n === 1 ? "transaction" : "transactions";
    lines.push({
      kind: "data", tone: "neutral",
      text: diff.txDelta > 0
        ? `${n.toLocaleString("en-US")} more ${noun} on file than last time${now.newest ? `, newest ${shortDate(now.newest)}` : ""}.`
        : `${n.toLocaleString("en-US")} fewer ${noun} on file than last time.`,
    });
  }
  return {
    headline: changes === 0 ? `Steady since ${label}` : `${changes} ${changes === 1 ? "change" : "changes"} since ${label}`,
    lines,
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────

export type VisitView = "profile" | "global";

/** Listed in profileReset.ts: erasing a profile's data forgets its visits too. */
const storageKey = (profileId: number) => `compass_insight_visits_${profileId}`;

function isSnapshot(value: unknown): value is VisitSnapshot {
  const v = value as VisitSnapshot | null;
  return !!v && typeof v === "object" && typeof v.day === "string" && typeof v.scope === "string" && Array.isArray(v.items)
    && v.items.every((i) => !!i && typeof i.h === "string" && typeof i.t === "string" && typeof i.s === "string");
}

function loadAll(profileId: number): Partial<Record<VisitView, VisitMemory>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(profileId)) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Records this reading and returns the visit it should be compared against (null the first
 * time). Safe to call again for the same day: the baseline does not move.
 */
export function recordVisit(profileId: number, view: VisitView, now: VisitSnapshot): VisitSnapshot | null {
  const all = loadAll(profileId);
  const stored = all[view];
  const memory: VisitMemory = {
    baseline: isSnapshot(stored?.baseline) ? stored.baseline : null,
    latest: isSnapshot(stored?.latest) ? stored.latest : null,
  };
  const next = rollVisit(memory, now);
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify({ ...all, [view]: next }));
  } catch {
    // Storage unavailable: this visit simply is not remembered. Nothing else depends on it.
  }
  return next.baseline;
}
