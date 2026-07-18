import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
// Vite bundles the worker as a static asset and gives us its final URL - this is the
// standard way to wire up pdfjs-dist's worker in a Vite app (works in both `vite dev` and
// the production Tauri build, since the webview just loads it like any other bundled asset).
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import Papa from "papaparse";
import * as XLSX from "xlsx";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfParseResult {
  headers: string[];
  rows: string[][];
  /** True if the extracted text looks like a loan statement (e.g. "Loan Balance", "Personal
   *  Loan") rather than a bank/credit-card transaction statement - a hint that this file
   *  belongs in the Loan uploader instead, since loan statements rarely have a itemized
   *  transaction table this parser can read. */
  looksLikeLoanStatement: boolean;
}

// A leading date at the start of a transaction line - covers "07/15/2026", "07/15", and
// "Jul 15, 2026" style statement formats.
const LEADING_DATE_RE = /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
// A trailing dollar amount - optionally $-prefixed, comma-grouped, and negative via a leading
// "-", trailing "-", or wrapped in parentheses (common statement conventions for debits).
const TRAILING_AMOUNT_RE = /(\(\$?[\d,]+\.\d{2}\)|-?\$?[\d,]+\.\d{2}-?)$/;

function normalizeAmount(token: string): string {
  let t = token.trim();
  let negative = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    negative = true;
    t = t.slice(1);
  }
  if (t.endsWith("-")) {
    negative = true;
    t = t.slice(0, -1);
  }
  t = t.replace(/^\$/, "").replace(/,/g, "");
  return negative ? `-${t}` : t;
}

/** Extracts every page's text items grouped into reading-order lines by y-coordinate, each
 *  line's items sorted left-to-right by x-coordinate - the shared traversal behind both
 *  `extractPdfLines` (joins each line into one string) and `extractPdfRows` (groups each line
 *  into column-ish cells). Returns an empty array for scanned/image-only PDFs (no embedded
 *  text layer) - OCR is out of scope. */
async function extractPdfItemLines(file: File): Promise<{ x: number; width: number; str: string }[][]> {
  const buf = await file.arrayBuffer();
  const doc = await getDocument({ data: buf }).promise;
  const itemLines: { x: number; width: number; str: string }[][] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const byY = new Map<number, { x: number; width: number; str: string }[]>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const y = Math.round(item.transform[5]);
      const bucket = byY.get(y) ?? [];
      bucket.push({ x: item.transform[4], width: "width" in item ? item.width : 0, str: item.str });
      byY.set(y, bucket);
    }

    const pageLines = [...byY.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF y grows upward - sort top of page first
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x));
    itemLines.push(...pageLines);
  }
  return itemLines;
}

/** Extracts every page's text as reading-order lines, one joined string per line. Shared by
 *  the transaction-row parser and the loan-statement label extractor. */
async function extractPdfLines(file: File): Promise<string[]> {
  const itemLines = await extractPdfItemLines(file);
  return itemLines
    .map((parts) => parts.map((p) => p.str).join(" ").replace(/\s+/g, " ").trim())
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

/**
 * Extracts (date, description, amount) rows from a text-based PDF bank/credit-card statement.
 * Each line is matched against a leading date and a trailing dollar amount - everything in
 * between becomes the description. This is a heuristic, not true column detection, so it only
 * recovers those three fields (no running-balance/type column, unlike some CSV/XLS exports).
 *
 * Scanned/photographed statements (image-only PDFs, no embedded text layer) will yield zero
 * rows since there is no text to extract - OCR is out of scope.
 */
export async function parsePdfStatement(file: File): Promise<PdfParseResult> {
  const lines = await extractPdfLines(file);
  const rows: string[][] = [];

  for (const text of lines) {
    const dateMatch = text.match(LEADING_DATE_RE);
    if (!dateMatch) continue;
    const rest = text.slice(dateMatch[0].length).trim();
    const amountMatch = rest.match(TRAILING_AMOUNT_RE);
    if (!amountMatch) continue;
    const description = rest.slice(0, rest.length - amountMatch[0].length).trim();
    if (!description) continue;
    rows.push([dateMatch[0], description, normalizeAmount(amountMatch[0])]);
  }

  const fullText = lines.join("\n");
  const looksLikeLoanStatement = /loan\s+balance|personal\s+loan|payment\s+due(?!\s*date)|scheduled\s+(?:monthly\s+)?payment/i.test(fullText);

  return { headers: ["Date", "Description", "Amount"], rows, looksLikeLoanStatement };
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
 * balance, interest rate, minimum payment, statement date, and lender/institution. Loan
 * statement layouts vary enormously by lender, so this is deliberately loose label-matching,
 * not a strict parser - the caller (loan uploader UI) always shows these as editable,
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
