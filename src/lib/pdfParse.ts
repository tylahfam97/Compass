import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
// Vite bundles the worker as a static asset and gives us its final URL - this is the
// standard way to wire up pdfjs-dist's worker in a Vite app (works in both `vite dev` and
// the production Tauri build, since the webview just loads it like any other bundled asset).
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { parseAmount, parseDate } from "./importParsing";
import { addDaysIso } from "./payCycle";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfParseResult {
  headers: string[];
  rows: string[][];
  /** True if the extracted text looks like a loan statement (e.g. "Loan Balance", "Personal
   *  Loan") rather than a bank/credit-card transaction statement - a hint that this file
   *  belongs in the Loan uploader instead, since loan statements rarely have a itemized
   *  transaction table this parser can read. */
  looksLikeLoanStatement: boolean;
  /** False for a scanned/image-only PDF (no text layer at all). */
  hasText: boolean;
  /** The statement prints an unchanged previous/new balance and has no transaction rows. */
  noActivity: boolean;
  /** Things the user should check before importing (rows that don't add up, unread lines...). */
  warnings: string[];
  /** True when the printed amounts add up to +(new - previous balance), false when they add
   *  up to the negative of it, null when the statement's balances couldn't be checked. */
  amountsIncreaseBalance: boolean | null;
  /** More than half the rows print a positive amount (single Amount column only). */
  mostlyPositive: boolean;
}

export interface PdfTextItem { x: number; y: number; width: number; height: number; str: string }

/** One page's text items in content order. `upright` is false for rotated text (e.g. a sideways
 *  margin code repeated on every page), which never belongs to a table row. */
async function extractPdfPages(file: File): Promise<(PdfTextItem & { upright: boolean })[][]> {
  const buf = await file.arrayBuffer();
  const doc = await getDocument({ data: buf }).promise;
  const pages: (PdfTextItem & { upright: boolean })[][] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items: (PdfTextItem & { upright: boolean })[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const [a, b, c, d, x, y] = item.transform;
      items.push({
        x, y, width: "width" in item ? item.width : 0, height: Math.abs(d) || Math.abs(b) || 0, str: item.str,
        upright: Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d > 0,
      });
    }
    pages.push(items);
  }
  return pages;
}

/** Groups items into reading-order lines, each sorted left-to-right. Exact mode buckets by
 *  rounded y (what the investment-statement parsers were built against). Tolerant mode joins
 *  items whose baselines sit within a fraction of the font size - statements often print the
 *  amount a point or so off the description's baseline, which exact rounding splits in two. */
function groupLines<T extends PdfTextItem>(items: T[], tolerant: boolean): T[][] {
  if (!tolerant) {
    const byY = new Map<number, T[]>();
    for (const item of items) {
      const y = Math.round(item.y);
      byY.set(y, [...(byY.get(y) ?? []), item]);
    }
    return [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.sort((a, b) => a.x - b.x));
  }
  const lines: { y: number; tol: number; parts: T[] }[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    const tol = Math.max(1.5, 0.4 * (item.height || 8));
    const line = lines[lines.length - 1];
    if (line && line.y - item.y <= Math.min(line.tol, tol)) line.parts.push(item);
    else lines.push({ y: item.y, tol, parts: [item] });
  }
  return lines.map((l) => l.parts.sort((a, b) => a.x - b.x));
}

/** Extracts every page's text items grouped into reading-order lines (exact-y grouping). Returns
 *  an empty array for scanned/image-only PDFs (no embedded text layer) - OCR is out of scope. */
async function extractPdfItemLines(file: File): Promise<PdfTextItem[][]> {
  return (await extractPdfPages(file)).flatMap((items) => groupLines(items, false));
}

const joinLine = (parts: { str: string }[]) => parts.map((p) => p.str).join(" ").replace(/\s+/g, " ").trim();

/** Every page's text as reading-order lines, one joined string per line (tolerant grouping, so
 *  a label and its slightly offset value land on one line). Used by the loan/balance label
 *  extractor. */
async function extractPdfLines(file: File): Promise<string[]> {
  return (await extractPdfPages(file))
    .flatMap((items) => groupLines(items.filter((i) => i.upright), true))
    .map(joinLine)
    .filter((l) => l.length > 0);
}

// A horizontal gap (in PDF points) between two text items wider than this is treated as a
// column boundary rather than a normal inter-word space within the same cell - reconstructs
// spreadsheet-like rows from a PDF's text layer for table-shaped statements (investment
// holdings, etc.) where there's no real column structure to read directly, unlike CSV/XLSX.
const CELL_GAP_THRESHOLD = 8;

/** Extracts every page's text as reading-order rows of cells (string[][]), grouping items on
 *  the same line into cells by horizontal gap - a gap wider than `CELL_GAP_THRESHOLD` starts a
 *  new cell, closer items are joined with a space into the same cell. This is a heuristic, not
 *  true column detection (a PDF has no real column structure), so results should always be
 *  treated the same way a CSV/XLSX import already is: reviewed and correctable before saving,
 *  never trusted outright. */
export async function extractPdfRows(file: File): Promise<string[][]> {
  const itemLines = await extractPdfItemLines(file);
  return itemLines
    .map((parts) => {
      const cells: string[] = [];
      let current = "";
      let prevEnd: number | null = null;
      for (const item of parts) {
        const gap = prevEnd === null ? 0 : item.x - prevEnd;
        if (prevEnd !== null && gap > CELL_GAP_THRESHOLD) {
          cells.push(current.trim());
          current = item.str;
        } else {
          current += current ? ` ${item.str}` : item.str;
        }
        prevEnd = item.x + item.width;
      }
      if (current.trim()) cells.push(current.trim());
      return cells;
    })
    .filter((row) => row.length > 0);
}

// ─── Transaction statements ────────────────────────────────────────────────────

interface Token { s: string; x0: number; x1: number }

/** Splits a line's items into whitespace tokens with approximate x extents (proportional to the
 *  character offset inside the item), then glues a detached sign or "$" ("- $", "+$", "$") onto
 *  the number after it and a trailing "CR"/"DR" onto the number before it. */
function tokenize(parts: PdfTextItem[]): Token[] {
  const raw: Token[] = [];
  for (const p of parts) {
    const len = p.str.length || 1;
    for (const m of p.str.matchAll(/\S+/g)) {
      const i = m.index ?? 0;
      raw.push({ s: m[0], x0: p.x + (p.width * i) / len, x1: p.x + (p.width * (i + m[0].length)) / len });
    }
  }
  const out: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const prev = out[out.length - 1];
    if (prev && /^[-+−]?\$?$/.test(prev.s) && prev.s && t.x0 - prev.x1 <= CELL_GAP_THRESHOLD && MONEY_RE.test(t.s) && !/^[-+−(]/.test(t.s)) {
      out[out.length - 1] = { s: prev.s + t.s, x0: prev.x0, x1: t.x1 };
    } else if (prev && /^(CR|DR)$/i.test(t.s) && MONEY_RE.test(prev.s)) {
      out[out.length - 1] = { s: `${prev.s} ${t.s}`, x0: prev.x0, x1: t.x1 };
    } else {
      out.push(t);
    }
  }
  return out;
}

const MONEY_RE = /^[-+−]?\$?\(?[-−]?\$?\d{1,3}(?:,?\d{3})*\.\d{2}\)?-?(?: (?:CR|DR))?$/i;
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// A date at the start of the remaining text: 07/15/2026, 07/15/26, 07/15, Jul 15, 2026, Jul 15.
const DATE_AT_START_RE = /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?)(?=\s|$)/;
const FULL_DATE = String.raw`(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|to|through|thru)\s*`;

/** Normalizes a statement amount to a plain signed number string ("-12.34"). "CR" marks the
 *  opposite of the statement's plain amounts, so it becomes negative here; the import wizard's
 *  sign setting then decides which way the statement's plain amounts go. */
function normalizeMoney(token: string): string {
  const cr = /\bCR$/i.test(token);
  const v = parseAmount(token.replace(/−/g, "-").replace(/\s*(CR|DR)$/i, ""));
  return (cr ? -Math.abs(v) : v).toFixed(2);
}

/** Recognizes a date token sequence, returning its ISO date when the year is known. */
function readDate(text: string): { raw: string; month: number; day: number; year: number | null } | null {
  const m = text.match(DATE_AT_START_RE);
  if (!m) return null;
  const raw = m[1];
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    const month = +slash[1], day = +slash[2];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (!slash[3]) return { raw, month, day, year: null };
    const iso = parseDate(raw);
    return iso ? { raw, month, day, year: +iso.slice(0, 4) } : null;
  }
  const named = raw.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  const month = named ? MONTH_NAMES.indexOf(named[1].slice(0, 3).toLowerCase()) + 1 : 0;
  if (!named || month === 0 || !/^[A-Za-z]{3}$|^(?:january|february|march|april|june|july|august|september|october|november|december|sept)$/i.test(named[1])) return null;
  const day = +named[2];
  if (day < 1 || day > 31) return null;
  return { raw, month, day, year: named[3] ? +named[3] : null };
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The statement period, from a labeled range ("Billing Period: 08/05/26-09/03/26"), a closing
 *  date, or any date range. Used to give year-less transaction dates their year. */
function findStatementPeriod(text: string): { start: string; end: string } | null {
  const tryRange = (re: RegExp) => {
    const m = text.match(re);
    if (!m) return null;
    const start = parseDate(m[1]), end = parseDate(m[2]);
    return start && end && start <= end ? { start, end } : null;
  };
  const labeled = tryRange(new RegExp(String.raw`(?:period|billing|statement|cycle|closing)[^\n]{0,60}?${FULL_DATE}${RANGE_SEP}${FULL_DATE}`, "i"));
  if (labeled) return labeled;
  const closing = text.match(new RegExp(String.raw`(?:closing|statement|ending)\s+date[^\n]{0,15}?${FULL_DATE}`, "i"));
  const end = closing ? parseDate(closing[1]) : "";
  if (end) return { start: addDaysIso(end, -35), end };
  return tryRange(new RegExp(`${FULL_DATE}${RANGE_SEP}${FULL_DATE}`, "i"));
}

/** Picks the year that puts a month/day inside (or nearest to) the statement period - a January
 *  charge on a December-to-January statement belongs to the later year. */
function resolveYear(month: number, day: number, period: { start: string; end: string }): string | null {
  const endYear = +period.end.slice(0, 4);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const y of [endYear, endYear - 1, endYear + 1]) {
    const iso = parseDate(isoOf(y, month, day));
    if (!iso) continue;
    const distance = iso < period.start ? Date.parse(period.start) - Date.parse(iso) : iso > period.end ? Date.parse(iso) - Date.parse(period.end) : 0;
    if (distance < bestDistance) { bestDistance = distance; best = iso; }
  }
  return best;
}

type MoneyKind = "Amount" | "Debit" | "Credit" | "Balance";
function moneyKind(text: string): MoneyKind | null {
  const t = text.toLowerCase();
  if (/balance/.test(t)) return "Balance";
  if (/withdraw|debit|charge|purchase|subtraction/.test(t)) return "Debit";
  if (/deposit|credit|payment|addition|refund/.test(t)) return "Credit";
  if (/amount/.test(t)) return "Amount";
  return null;
}

/** A transaction table's column header line, e.g. "Date Description Amount" or "Date | Details |
 *  Withdrawals | Deposits | Balance". Words are grouped into cells by gap, as `extractPdfRows`
 *  does, and each money cell keeps its x extent for assigning row amounts to columns. */
function readHeader(tokens: Token[]): { kind: MoneyKind; x0: number; x1: number }[] | null {
  if (tokens.length === 0 || tokens.length > 14) return null;
  const cells: Token[] = [];
  for (const t of tokens) {
    const prev = cells[cells.length - 1];
    if (prev && t.x0 - prev.x1 <= CELL_GAP_THRESHOLD) cells[cells.length - 1] = { s: `${prev.s} ${t.s}`, x0: prev.x0, x1: t.x1 };
    else cells.push({ ...t });
  }
  if (cells.some((c) => MONEY_RE.test(c.s) || DATE_AT_START_RE.test(c.s))) return null;
  if (!cells.some((c) => /\b(description|details|transactions?|merchant|payee)\b/i.test(c.s))) return null;
  const money = cells.flatMap((c) => {
    const kind = moneyKind(c.s);
    return kind && !/\b(date|description)\b/i.test(c.s) ? [{ kind, x0: c.x0, x1: c.x1 }] : [];
  });
  const kinds = money.map((m) => m.kind);
  return money.length > 0 && new Set(kinds).size === kinds.length ? money : null;
}

const SKIP_CONTINUATION_RE = /^(total|subtotal|page\b|continued|balance|previous|new balance|account|statement|fees charged|interest charge|summary|daily|annual percentage|important)/i;
// Dated lines that are balances, not transactions: "Beginning balance", a daily-balance table.
const BALANCE_LINE_RE = /^(beginning|ending|opening|closing|previous|new|daily|starting)\b.*\bbalance\b/i;

// The row shape PDF imports had before 1.3.7 (printed date token, rest of line, last amount),
// kept only so a statement imported by an earlier version is recognized as already imported.
const LEGACY_DATE_RE = /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
const LEGACY_AMOUNT_RE = /(\(\$?[\d,]+\.\d{2}\)|-?\$?[\d,]+\.\d{2}-?)$/;
function legacyRow(text: string): string[] | null {
  const d = text.match(LEGACY_DATE_RE);
  if (!d) return null;
  const rest = text.slice(d[0].length).trim();
  const a = rest.match(LEGACY_AMOUNT_RE);
  if (!a) return null;
  const description = rest.slice(0, rest.length - a[0].length).trim();
  if (!description) return null;
  let t = a[0], negative = false;
  if (t.startsWith("(") && t.endsWith(")")) { negative = true; t = t.slice(1, -1); }
  if (t.startsWith("-")) { negative = true; t = t.slice(1); }
  if (t.endsWith("-")) { negative = true; t = t.slice(0, -1); }
  t = t.replace(/^\$/, "").replace(/,/g, "");
  return [d[0], description, negative ? `-${t}` : t];
}

/** Output row -> the row an earlier Compass version produced for the same statement line. */
export const legacyPdfRows = new WeakMap<string[], string[]>();

/**
 * Turns a statement's text lines into transaction rows. Pure (no PDF access) so it is testable
 * with synthetic coordinates. Per page:
 *  - A column header line ("Date ... Description ... Amount"/"Debit"/"Credit"/"Balance") maps
 *    money columns by x position; without one, a row's last amount is its Amount (or, with
 *    two, Amount then Balance).
 *  - A row starts with a date; a second leading date (posting date) is dropped. Year-less dates
 *    take their year from the statement period.
 *  - A date line with no amount is completed by an amounts-only line right after it, and short
 *    lines under a row's description are appended to it (wrapped merchant names).
 * Anything that can't be read cleanly is counted in `warnings` instead of being guessed at, and
 * the rows are checked against the statement's previous/new balance when it prints them.
 */
function parseStatementLines(pages: PdfTextItem[][][], today: Date): Omit<PdfParseResult, "looksLikeLoanStatement" | "hasText"> {
  const lineTexts = pages.flat().map(joinLine);
  const fullText = lineTexts.join("\n");
  const warnings: string[] = [];
  const found = findStatementPeriod(fullText);
  const todayIso = isoOf(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const period = found ?? { start: addDaysIso(todayIso, -35), end: todayIso };
  let yearGuessed = false;

  let header: { kind: MoneyKind; x0: number; x1: number }[] | null = null;
  type Row = { date: string; desc: string; money: Record<string, string>; descX: number; y: number; page: number; legacy: string[] | null };
  const rows: Row[] = [];
  let unread = 0;
  let ambiguous = 0;
  let pending: { date: string; desc: string; descX: number; y: number; page: number } | null = null;

  const assign = (money: Token[]): Record<string, string> | null => {
    const out: Record<string, string> = {};
    if (header) {
      for (const m of money) {
        const c = (m.x0 + m.x1) / 2;
        let best = header[0], bestD = Infinity;
        for (const col of header) {
          const d = Math.min(Math.abs(m.x1 - col.x1), Math.abs(c - (col.x0 + col.x1) / 2));
          if (d < bestD) { bestD = d; best = col; }
        }
        if (out[best.kind] !== undefined) return null;
        out[best.kind] = normalizeMoney(m.s);
      }
      return out;
    }
    if (money.length === 1) return { Amount: normalizeMoney(money[0].s) };
    if (money.length === 2) return { Amount: normalizeMoney(money[0].s), Balance: normalizeMoney(money[1].s) };
    return null;
  };

  pages.forEach((lines, page) => {
    for (const parts of lines) {
      let tokens = tokenize(parts);
      if (tokens.length === 0) continue;
      const lineY = parts[0].y;
      const h = readHeader(tokens);
      if (h) {
        header = h;
        pending = null;
        continue;
      }

      // Leading date(s).
      const text = tokens.map((t) => t.s).join(" ");
      const first = readDate(text);
      let date: string | null = null;
      if (first) {
        tokens = tokens.slice(first.raw.split(/\s+/).length);
        const second = readDate(tokens.map((t) => t.s).join(" "));
        if (second) tokens = tokens.slice(second.raw.split(/\s+/).length);
        if (first.year !== null) date = isoOf(first.year, first.month, first.day);
        else { date = resolveYear(first.month, first.day, period); if (!found) yearGuessed = true; }
        if (date && !parseDate(date)) date = null;
      }

      let moneyStart = tokens.length;
      while (moneyStart > 0 && MONEY_RE.test(tokens[moneyStart - 1].s)) moneyStart--;
      const money = tokens.slice(moneyStart);
      const descTokens = tokens.slice(0, moneyStart);
      const desc = descTokens.map((t) => t.s).join(" ").trim();

      if (date) {
        pending = null;
        if (!desc) { if (header) unread++; continue; }
        if (BALANCE_LINE_RE.test(desc) || !/[A-Za-z]/.test(desc)) continue;
        if (money.length === 0) {
          pending = { date, desc, descX: descTokens[0].x0, y: lineY, page };
          continue;
        }
        const assigned = assign(money);
        if (!assigned) { ambiguous++; continue; }
        rows.push({ date, desc, money: assigned, descX: descTokens[0].x0, y: lineY, page, legacy: legacyRow(joinLine(parts)) });
        continue;
      }

      // An amounts-only line completing the dated line right above it.
      if (pending && pending.page === page && !desc && money.length > 0) {
        const assigned = assign(money);
        if (assigned) rows.push({ ...pending, money: assigned, y: lineY, legacy: null });
        else ambiguous++;
        pending = null;
        continue;
      }
      if (pending) { if (header) unread++; pending = null; }

      // A wrapped description line under the previous row.
      const last = rows[rows.length - 1];
      const lineHeight = Math.max(...parts.map((p) => p.height || 8));
      if (last && last.page === page && money.length === 0 && desc && desc.length <= 60 &&
          tokens[0].x0 >= last.descX - 3 && last.y - lineY <= 2.2 * lineHeight && !SKIP_CONTINUATION_RE.test(desc)) {
        last.desc = `${last.desc} ${desc}`;
        last.y = lineY;
      }
    }
    if (pending) { if (header) unread++; pending = null; }
  });

  // Only the money columns rows actually use, in a fixed order, so a stray header-like line
  // elsewhere in the statement can't add empty columns for the wizard to pick up.
  // Debit and Credit always go together: a month with only withdrawals must still be read as
  // a split layout, or the wizard would take the lone Debit column as a positive Amount.
  const split = rows.some((r) => r.money.Debit !== undefined || r.money.Credit !== undefined);
  const used = (["Amount", "Debit", "Credit", "Balance"] as const).filter((k) =>
    (split && (k === "Debit" || k === "Credit")) || rows.some((r) => r.money[k] !== undefined));
  const columns: MoneyKind[] = used.length > 0 ? [...used] : ["Amount"];
  const outRows = rows.map((r) => {
    const out = [r.date, r.desc, ...columns.map((c) => r.money[c] ?? "")];
    if (r.legacy) legacyPdfRows.set(out, r.legacy);
    return out;
  });

  // Reconcile against the statement's own balances when it prints them.
  const balanceAfter = (labelRe: RegExp): number | null => {
    for (const line of lineTexts) {
      const m = line.match(labelRe);
      if (!m) continue;
      const v = line.slice((m.index ?? 0) + m[0].length).match(/[-−]?\s*\$?\s*\(?\d{1,3}(?:,?\d{3})*\.\d{2}\)?/);
      if (v) return parseAmount(v[0].replace(/−/g, "-"));
    }
    return null;
  };
  const previous = balanceAfter(/(?:previous|prior|opening|beginning|starting)\s+balance/i);
  const latest = balanceAfter(/(?:new|closing|ending)\s+balance/i);
  const delta = previous !== null && latest !== null ? Math.round((latest - previous) * 100) : null;
  const signed = (r: Row) => r.money.Amount !== undefined ? parseFloat(r.money.Amount)
    : Math.abs(parseFloat(r.money.Credit || "0")) - Math.abs(parseFloat(r.money.Debit || "0"));
  const sumCents = Math.round(rows.reduce((s, r) => s + signed(r), 0) * 100);
  const fmt = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

  let amountsIncreaseBalance: boolean | null = null;
  const noActivity = rows.length === 0 && delta === 0 && unread === 0 && ambiguous === 0;
  if (delta !== null && rows.length > 0) {
    if (delta !== 0 && sumCents === delta) amountsIncreaseBalance = true;
    else if (delta !== 0 && sumCents === -delta) amountsIncreaseBalance = false;
    else if (Math.abs(sumCents) !== Math.abs(delta)) {
      warnings.push(`The ${rows.length} rows found add up to ${fmt(Math.abs(sumCents))}, but the statement's balance changed by ${fmt(Math.abs(delta))} (from ${fmt(Math.round(previous! * 100))} to ${fmt(Math.round(latest! * 100))}). Some transactions may be missing or misread - compare with the statement before importing.`);
    }
  }
  if (delta === null && rows.length > 0) warnings.push("This statement doesn't print a previous and new balance, so Compass couldn't check that these rows are complete and correct - review them against the statement.");
  if (unread > 0) warnings.push(`${unread} dated ${unread === 1 ? "line" : "lines"} in the transaction table had no readable amount and ${unread === 1 ? "was" : "were"} left out.`);
  if (ambiguous > 0) warnings.push(`${ambiguous} ${ambiguous === 1 ? "row" : "rows"} had amounts that couldn't be matched to the statement's columns and ${ambiguous === 1 ? "was" : "were"} left out.`);
  if (yearGuessed) warnings.push("The statement period wasn't found, so years for dates printed without one were guessed from today's date - check the dates.");

  const amountRows = rows.filter((r) => r.money.Amount !== undefined);
  return {
    headers: ["Date", "Description", ...columns],
    rows: outRows,
    noActivity,
    warnings,
    amountsIncreaseBalance,
    mostlyPositive: amountRows.filter((r) => parseFloat(r.money.Amount) > 0).length > amountRows.length / 2,
  };
}

// Card-statement wording. A loan statement's "payment due" phrasing also appears on every card
// statement ("Minimum payment due"), so card markers veto the loan hint.
const CARD_STATEMENT_RE = /\bpurchases?\b|cash\s+advances?|credit\s+(?:card|limit|line)|card\s*(?:member|holder)|account\s+ending/i;
const LOAN_STATEMENT_RE = /loan\s+balance|personal\s+loan|payment\s+due(?!\s*date)|scheduled\s+(?:monthly\s+)?payment/i;

/**
 * Extracts transaction rows from a text-based PDF bank/credit-card statement - see
 * `parseStatementLines` for how rows, columns, dates and the balance check work. Scanned/
 * photographed statements (image-only PDFs, no embedded text layer) report `hasText: false`,
 * since there is no text to extract - OCR is out of scope.
 */
export async function parsePdfStatement(file: File): Promise<PdfParseResult> {
  return parseStatementItems(await extractPdfPages(file));
}

/** `parsePdfStatement` minus the PDF reading: one array of positioned text items per page. */
export function parseStatementItems(pageItems: (PdfTextItem & { upright?: boolean })[][], today: Date = new Date()): PdfParseResult {
  const pages = pageItems.map((items) => groupLines(items.filter((i) => i.upright !== false), true));
  const fullText = pages.flat().map(joinLine).join("\n");
  return {
    ...parseStatementLines(pages, today),
    hasText: pages.some((p) => p.length > 0),
    looksLikeLoanStatement: LOAN_STATEMENT_RE.test(fullText) && !CARD_STATEMENT_RE.test(fullText),
  };
}

/** Reads a CSV/XLSX loan-statement export into one flattened text line per row (cells joined
 *  with a space) so `findLabeledValue` can scan it exactly like a PDF's text layer - handles
 *  both a "Field, Value" row-per-field layout and a header-row-then-data-row layout (the
 *  latter via `findLabeledValue`'s existing same-line/next-line fallback). */
async function extractSpreadsheetLines(file: File): Promise<string[]> {
  const toLines = (rows: unknown[][]): string[] =>
    rows
      .map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))).join(" ").replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 0);

  if (/\.xlsx?$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false }) as unknown[][];
    return toLines(raw);
  }
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (r) => resolve(toLines(r.data as unknown[][])),
      error: (e) => reject(e),
    });
  });
}

export interface LoanStatementFields {
  balance: string | null;
  interestRatePct: string | null;
  minimumPayment: string | null;
  statementDate: string | null;
  /** Lender/servicer name, either read from a labeled line in the PDF body or, failing that,
   *  loosely guessed from the filename - always just a starting point for an editable field,
   *  never trusted outright. */
  institution: string | null;
}

/** Loose "label: value" matcher - finds the first line containing `labelRe`, then applies
 *  `valueRe` either to the remainder of that same line or, if nothing matches there, to the
 *  next line (some statement layouts put the label and value on separate lines/columns). */
function findLabeledValue(lines: string[], labelRe: RegExp, valueRe: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const afterLabel = lines[i].slice((m.index ?? 0) + m[0].length);
    const sameLine = afterLabel.match(valueRe);
    if (sameLine) return sameLine[1];
    const nextLine = lines[i + 1]?.match(valueRe);
    if (nextLine) return nextLine[1];
  }
  return null;
}

const DOLLAR_VALUE_RE = /\$?\(?(-?[\d,]+\.\d{2})\)?/;
const PERCENT_VALUE_RE = /(-?[\d.]+)\s*%/;
const DATE_VALUE_RE = /(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
// A name-like value after a "Lender:"/"Servicer:" style label - letters/spaces/&/./,/'/- only,
// trimmed to a reasonable company-name length so it doesn't accidentally swallow a whole line.
const NAME_VALUE_RE = /\s*[:\-]?\s*([A-Za-z][A-Za-z&.,'\- ]{1,39})/;

// Generic filler words that show up in loan-statement filenames but are never the lender's
// name - stripped out before guessing an institution from the filename.
const FILENAME_FILLER_WORDS = /\b(statement|monthly|loan|copy|download|final|document|doc|export|pdf)\b/gi;

/** Last-resort, low-confidence institution guess from the PDF's filename (e.g.
 *  "SoFi_Statement_July.pdf" -> "SoFi") - only used when nothing labeled was found in the
 *  PDF body itself. Deliberately conservative: returns null unless the cleaned-up filename
 *  still looks like a plausible single company name. */
function guessInstitutionFromFilename(filename: string): string | null {
  const base = filename.replace(/\.(pdf|csv|xlsx?|xls)$/i, "").replace(/[_\-]+/g, " ").replace(/\d+/g, " ");
  const cleaned = base.replace(FILENAME_FILLER_WORDS, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 30) return null;
  const words = cleaned.split(" ").slice(0, 2);
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * Best-effort extraction of the handful of fields a loan statement upload needs: current
 * balance, interest rate, minimum payment, statement date, and lender/institution. Also reused
 * by the credit-card import wizard (ImportPage.tsx) just for the balance field, since a card's
 * "New Balance" line matches the same label patterns. Loan statement layouts vary enormously by
 * lender, so this is deliberately loose label-matching, not a strict parser - the caller
 * (loan uploader UI) always shows these as editable,
 * pre-filled fields rather than importing them silently, since 100% reliable extraction
 * across arbitrary lenders isn't realistic. Interest rate/minimum payment are informational
 * only and never used in any calculation elsewhere in the app. Accepts PDF, CSV, or XLSX -
 * spreadsheet exports are flattened one row per line so the same label-matching works
 * whether a "Balance"-style label sits beside its value on one row/line or on the row/line
 * directly above a header-then-data layout.
 */
export async function parseLoanStatementFile(file: File): Promise<LoanStatementFields> {
  const lines = /\.pdf$/i.test(file.name) ? await extractPdfLines(file) : await extractSpreadsheetLines(file);

  const balance = findLabeledValue(
    lines,
    /(?:current|new|principal|outstanding|remaining|total|loan|unpaid)\s+balance/i,
    DOLLAR_VALUE_RE
  );
  const interestRatePct = findLabeledValue(
    lines,
    /(?:interest\s*rate|annual\s*percentage\s*rate|\bapr\b)/i,
    PERCENT_VALUE_RE
  );
  const minimumPayment = findLabeledValue(
    lines,
    /minimum\s+(?:payment|amount)\s*(?:due)?|payment\s+due(?!\s*date)|amount\s+due(?!\s*date)|scheduled\s+(?:monthly\s+)?payment/i,
    DOLLAR_VALUE_RE
  );
  const statementDate = findLabeledValue(
    lines,
    /(?:statement\s*date|statement\s*closing\s*date|billing\s*date|as\s*of)/i,
    DATE_VALUE_RE
  );
  const institution =
    findLabeledValue(lines, /lender|servicer|creditor|loan\s+company/i, NAME_VALUE_RE) ??
    guessInstitutionFromFilename(file.name);

  return { balance, interestRatePct, minimumPayment, statementDate, institution };
}
