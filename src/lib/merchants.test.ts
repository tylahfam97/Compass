import { describe, it, expect } from "vitest";
import { merchantKey } from "./merchants";

describe("merchantKey", () => {
  it("strips processor prefixes, order codes and trailing purchase noise", () => {
    expect(merchantKey("IC* INSTACART*161 06/15 PURCHASE INSTACART.COM CA")).toBe("INSTACART");
    expect(merchantKey("PP*APPLE.COM/BILL 06/13 PURCHASE 402-935-7733 CA")).toBe("APPLE.COM/BILL");
    expect(merchantKey("AMAZON MKTPL*1A52U9IQ3 05/22 PURCHASE Amzn.com/bill WA")).toBe("AMAZON MKTPL");
    expect(merchantKey("SQ *BLUE BOTTLE COFFEE")).toBe("BLUE BOTTLE COFFEE");
  });

  it("keeps ordinary multi-word payees intact", () => {
    expect(merchantKey("UBER EATS")).toBe("UBER EATS");
    expect(merchantKey("Home Depot #1234")).toBe("HOME DEPOT");
    expect(merchantKey("Shell Gas Station 40012")).toBe("SHELL GAS STATION");
  });

  it("is idempotent and case-insensitive", () => {
    const once = merchantKey("Neighborhood   Coffee");
    expect(once).toBe("NEIGHBORHOOD COFFEE");
    expect(merchantKey(once)).toBe(once);
    expect(merchantKey("neighborhood coffee")).toBe(once);
  });

  it("returns an empty key for empty or punctuation-only input", () => {
    expect(merchantKey("")).toBe("");
    expect(merchantKey("***")).toBe("");
  });
});
