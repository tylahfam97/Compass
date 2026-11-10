import { beforeEach, describe, expect, it } from "vitest";
import type { Insight } from "../types";
import { buildBriefing, diffVisit, recordVisit, rollVisit, sinceLabel, snapshotOf, stableKey, BRIEF_MAX_FINDINGS, BRIEF_MAX_RESOLVED } from "./companion";
import { clearProfileLocalState } from "../profileReset";

const insight = (id: string, severity: Insight["severity"] = "warning", type: Insight["type"] = "budget_pace"): Insight =>
  ({ id, type, severity, title: `Title ${id}`, description: "", dismissKey: id });

const snap = (day: string, insights: Insight[], extra: Partial<{ scope: string; score: number | null; txCount: number | null; newest: string | null }> = {}) =>
  snapshotOf(insights, { day, scope: "1", score: 70, txCount: 100, newest: day, ...extra });

describe("stableKey", () => {
  it("drops the month, day, quarter and year an id was computed for", () => {
    expect(stableKey("budget_pace_12_2026-11")).toBe("budget_pace_12");
    expect(stableKey("low_balance_2026-11-08")).toBe("low_balance");
    expect(stableKey("card_paid_in_full_3_2026Q4")).toBe("card_paid_in_full_3");
    expect(stableKey("annual_netflix_2026")).toBe("annual_netflix");
    expect(stableKey("dup_netflix_2026-11-02_1599")).toBe("dup_netflix_1599");
  });
  it("keeps numbers that are not dates", () => {
    expect(stableKey("large_120263")).toBe("large_120263");
    expect(stableKey("loan_payoff_projection_7")).toBe("loan_payoff_projection_7");
  });
});

describe("rollVisit", () => {
  it("has no baseline on a first visit", () => {
    const now = snap("2026-11-10", []);
    expect(rollVisit({ baseline: null, latest: null }, now)).toEqual({ baseline: null, latest: now });
  });
  it("keeps comparing against the earlier day when the page is reopened the same day", () => {
    const friday = snap("2026-11-06", [insight("a")]);
    const first = rollVisit({ baseline: null, latest: friday }, snap("2026-11-10", [insight("a"), insight("b")]));
    expect(first.baseline).toBe(friday);
    const again = rollVisit(first, snap("2026-11-10", [insight("b")]));
    expect(again.baseline).toBe(friday);
    expect(again.latest?.items).toHaveLength(1);
  });
  it("moves the baseline once the day changes", () => {
    const monday = snap("2026-11-09", []);
    const rolled = rollVisit({ baseline: snap("2026-11-06", []), latest: monday }, snap("2026-11-10", []));
    expect(rolled.baseline).toBe(monday);
  });
});

describe("diffVisit", () => {
  it("reports nothing on a first reading", () => {
    const now = [insight("a")];
    expect(diffVisit(null, snap("2026-11-10", now), now)).toEqual({ since: null, appeared: [], escalated: [], resolved: [], scoreDelta: null, txDelta: null });
  });

  it("separates new, escalated and resolved findings", () => {
    const before = snap("2026-11-06", [insight("stays"), insight("clears"), insight("grows", "info"), insight("eases")]);
    const now = [insight("stays"), insight("grows", "warning"), insight("eases", "info"), insight("fresh"), insight("win", "success", "no_spend_days")];
    const diff = diffVisit(before, snap("2026-11-10", now, { score: 74, txCount: 138 }), now);
    expect(diff.since).toBe("2026-11-06");
    expect(diff.appeared.map((i) => i.id)).toEqual(["fresh", "win"]);
    expect(diff.escalated.map((i) => i.id)).toEqual(["grows"]);
    // "clears" is gone and "eases" is still listed but no longer an action item.
    expect(diff.resolved).toHaveLength(2);
    expect(diff.scoreDelta).toBe(4);
    expect(diff.txDelta).toBe(38);
  });

  it("does not call a standing finding new when the month rolls over", () => {
    const before = snap("2026-10-30", [insight("budget_pace_4_2026-10"), insight("top_merchants_2026-10", "info", "top_merchants")]);
    const now = [insight("budget_pace_4_2026-11"), insight("top_merchants_2026-11", "info", "top_merchants")];
    const diff = diffVisit(before, snap("2026-11-02", now), now);
    expect(diff.appeared).toEqual([]);
    expect(diff.resolved).toEqual([]);
  });

  it("keeps an unmeasured score or count unknown instead of treating it as zero", () => {
    const before = snap("2026-11-06", [], { score: null, txCount: null });
    const diff = diffVisit(before, snap("2026-11-10", [], { score: 70, txCount: 100 }), []);
    expect(diff.scoreDelta).toBeNull();
    expect(diff.txDelta).toBeNull();
  });

  it("never compares readings of different scopes", () => {
    const before = snap("2026-11-06", [insight("a")], { scope: "1,2" });
    const diff = diffVisit(before, snap("2026-11-10", [], { scope: "1" }), []);
    expect(diff.since).toBeNull();
    expect(diff.resolved).toEqual([]);
  });

  it("remembers no titles, merchants or amounts", () => {
    const stored = JSON.stringify(snap("2026-11-10", [{ ...insight("dup_corner cafe_2026-11-02_1599"), title: "Corner Cafe charged $15.99 twice", impactCents: 1599 }]));
    expect(stored).not.toMatch(/corner|cafe|1599|15\.99/i);
  });
});

describe("sinceLabel", () => {
  it("names the day the way a person would", () => {
    expect(sinceLabel("2026-11-09", "2026-11-10")).toBe("yesterday");
    expect(sinceLabel("2026-11-06", "2026-11-10")).toBe("Friday");
    expect(sinceLabel("2026-10-20", "2026-11-10")).toBe("Oct 20");
    expect(sinceLabel("2025-12-20", "2026-01-10")).toBe("Dec 20, 2025");
  });
});

describe("buildBriefing", () => {
  const now = { todayIso: "2026-11-10", score: 74, newest: "2026-11-08" };

  it("says plainly that a first reading has nothing to compare", () => {
    const brief = buildBriefing(diffVisit(null, snap("2026-11-10", []), []), now);
    expect(brief.headline).toBe("First reading");
    expect(brief.lines).toHaveLength(1);
    expect(brief.lines[0].kind).toBe("note");
  });

  it("leads with what needs action, then what cleared, then the score and the data", () => {
    const before = snap("2026-11-06", [insight("clears", "warning", "duplicate_charge"), insight("grows", "info")]);
    const current = [insight("grows", "warning"), insight("fresh"), insight("win", "success", "no_spend_days")];
    const brief = buildBriefing(diffVisit(before, snap("2026-11-10", current, { score: 74, txCount: 138 }), current), now);
    expect(brief.headline).toBe("4 changes since Friday");
    expect(brief.lines.map((l) => l.kind)).toEqual(["escalated", "new", "new", "resolved", "score", "data"]);
    expect(brief.lines[0]).toMatchObject({ tone: "warning", insightId: "grows", text: "Now needs action: Title grows" });
    expect(brief.lines[3].text).toBe("No longer flagged: possible duplicate charge");
    expect(brief.lines[4].text).toBe("Health score 74, up 4 since Friday.");
    expect(brief.lines[5].text).toBe("38 more transactions on file than last time, newest Nov 8.");
  });

  it("explains a steady reading by the absence of new data", () => {
    const same = [insight("a")];
    const brief = buildBriefing(diffVisit(snap("2026-11-09", same), snap("2026-11-10", same), same), now);
    expect(brief.headline).toBe("Steady since yesterday");
    expect(brief.lines).toHaveLength(1);
    expect(brief.lines[0].text).toMatch(/No new transactions are on file/);
  });

  it("does not blame missing data when the count is unknown or moved", () => {
    const same = [insight("a")];
    const brief = buildBriefing(diffVisit(snap("2026-11-09", same, { txCount: 90 }), snap("2026-11-10", same), same), now);
    expect(brief.headline).toBe("Steady since yesterday");
    expect(brief.lines[0].text).toMatch(/same findings as last time/);
    expect(brief.lines[1].text).toBe("10 more transactions on file than last time, newest Nov 8.");
  });

  it("caps the findings it lists and counts the rest", () => {
    const current = Array.from({ length: BRIEF_MAX_FINDINGS + 3 }, (_, i) => insight(`n${i}`));
    const brief = buildBriefing(diffVisit(snap("2026-11-09", []), snap("2026-11-10", current), current), now);
    expect(brief.headline).toBe("8 changes since yesterday");
    expect(brief.lines.filter((l) => l.kind === "new")).toHaveLength(BRIEF_MAX_FINDINGS);
    expect(brief.lines[BRIEF_MAX_FINDINGS].text).toBe("3 more new in Review below.");
  });

  it("gives each cleared item its own line so the headline count matches, then counts the rest", () => {
    const before = Array.from({ length: BRIEF_MAX_RESOLVED + 2 }, (_, i) => insight(`gone${i}`, "warning", "duplicate_charge"));
    const brief = buildBriefing(diffVisit(snap("2026-11-09", before), snap("2026-11-10", []), []), now);
    expect(brief.headline).toBe("5 changes since yesterday");
    expect(brief.lines.filter((l) => l.kind === "resolved")).toHaveLength(BRIEF_MAX_RESOLVED);
    expect(brief.lines[BRIEF_MAX_RESOLVED].text).toBe("2 more no longer flagged.");
  });

  it("reports fewer transactions honestly after deletions", () => {
    const brief = buildBriefing(diffVisit(snap("2026-11-09", [], { txCount: 120 }), snap("2026-11-10", []), []), now);
    expect(brief.lines[brief.lines.length - 1].text).toBe("20 fewer transactions on file than last time.");
  });
});

describe("recordVisit", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    Object.assign(globalThis, { localStorage: storage, sessionStorage: storage });
  });

  it("persists across visits, per view, and survives a same-day revisit", () => {
    expect(recordVisit(1, "profile", snap("2026-11-06", [insight("a")]))).toBeNull();
    expect(recordVisit(1, "profile", snap("2026-11-10", [insight("b")]))?.day).toBe("2026-11-06");
    expect(recordVisit(1, "profile", snap("2026-11-10", []))?.day).toBe("2026-11-06");
    expect(recordVisit(1, "global", snap("2026-11-10", [], { scope: "1,2" }))).toBeNull();
    expect(recordVisit(2, "profile", snap("2026-11-10", [], { scope: "2" }))).toBeNull();
  });

  it("starts over after the profile's data is erased", () => {
    recordVisit(1, "profile", snap("2026-11-06", [insight("a")]));
    clearProfileLocalState(1);
    expect(recordVisit(1, "profile", snap("2026-11-10", []))).toBeNull();
  });

  it("ignores a corrupted note instead of failing the page", () => {
    store.set("compass_insight_visits_1", "{\"profile\":{\"latest\":{\"day\":5}}}");
    expect(recordVisit(1, "profile", snap("2026-11-10", []))).toBeNull();
    store.set("compass_insight_visits_1", "not json");
    expect(recordVisit(1, "profile", snap("2026-11-11", []))).toBeNull();
  });
});
