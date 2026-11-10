import { describe, it, expect } from "vitest";
import { filterCommands } from "./CommandPalette";

const commands = [
  { label: "Overview", about: "Net worth and every account", keywords: "balances owe own" },
  { label: "Plan", about: "Cash-flow forecast", keywords: "bills paycheck safe to spend" },
  { label: "Reports", about: "Any cut of the ledger", keywords: "export table" },
  { label: "Replay tour", keywords: "help guide" },
];
const labels = (query: string) => filterCommands(commands, query).map((command) => command.label);

describe("filterCommands", () => {
  it("returns everything, in order, for an empty or blank query", () => {
    expect(labels("")).toEqual(["Overview", "Plan", "Reports", "Replay tour"]);
    expect(labels("   ")).toEqual(["Overview", "Plan", "Reports", "Replay tour"]);
  });

  it("finds a page by what it shows, not only by its name", () => {
    expect(labels("net worth")).toEqual(["Overview"]);
    expect(labels("FORECAST")).toEqual(["Plan"]);
    expect(labels("help")).toEqual(["Replay tour"]);
  });

  it("requires every word and ranks label-prefix matches first", () => {
    // "re" starts two labels and also sits inside Plan's "forecast".
    expect(labels("re")).toEqual(["Reports", "Replay tour", "Plan"]);
    expect(labels("rep tour")).toEqual(["Replay tour"]);
    expect(labels("zzz")).toEqual([]);
  });
});
