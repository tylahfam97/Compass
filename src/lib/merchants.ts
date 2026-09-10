/**
 * Merchant identity from a bank description. Statements decorate the same payee differently on
 * every line ("SQ *BLUE BOTTLE 05/21 PURCHASE…", "BLUE BOTTLE COFFEE #12"), so anything that
 * groups transactions by merchant (frequent purchases, duplicate charges, annual renewals)
 * groups on this key rather than on the raw text. Only a key, never shown to the user: the
 * original description is what gets displayed.
 *
 * Related to `normalizeDescription` in db.ts, which categorization rules match against; that
 * one is deliberately left alone so rule matching does not change.
 */
export function merchantKey(description: string): string {
  let s = description.toUpperCase().trim();
  // Payment-processor prefixes: "SQ *", "TST*", "PP*", "IC* ", "DD *DOORDASH".
  s = s.replace(/^[A-Z]{2,4}\s?\*\s*/, "");
  // Trailing "05/21 PURCHASE 402-935-7733 CA" style noise.
  s = s.replace(/\s+\d{2}\/\d{2}\s+.*$/, "");
  // Order and reference codes: "*1A52U9IQ3", "*161".
  s = s.replace(/\*[A-Z0-9]+/g, "");
  // Store numbers: "#1234", "# 88".
  s = s.replace(/#\s*\d+/g, "");
  // Trailing bare numbers: "SHELL 40012".
  s = s.replace(/\s+\d{3,}$/, "");
  // Anything else that is not a letter, digit or the punctuation payees actually use.
  s = s.replace(/[^A-Z0-9&'./ -]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}
