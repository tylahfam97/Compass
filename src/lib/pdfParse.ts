import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
// Vite bundles the worker as a static asset and gives us its final URL - this is the
// standard way to wire up pdfjs-dist's worker in a Vite app (works in both `vite dev` and
// the production Tauri build, since the webview just loads it like any other bundled asset).
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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

/** Extracts every page's text as reading-order lines, grouping text items by y-coordinate and
 *  ordering left-to-right by x-coordinate within each line. Shared by both the transaction-row
 *  parser and the loan-statement label extractor below. Returns an empty array for
 *  scanned/image-only PDFs (no embedded text layer) - OCR is out of scope. */
async function extractPdfLines(file: File): Promise<string[]> {
  const buf = await file.arrayBuffer();
  const doc = await getDocument({ data: buf }).promise;
  const lines: string[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const byY = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const y = Math.round(item.transform[5]);
      const bucket = byY.get(y) ?? [];
      bucket.push({ x: item.transform[4], str: item.str });
      byY.set(y, bucket);
    }

    const pageLines = [...byY.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF y grows upward - sort top of page first
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 0);
    lines.push(...pageLines);
  }
  return lines;
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

export interface LoanStatementFields {
  balance: string | null;
  interestRatePct: string | null;
  minimumPayment: string | null;
  statementDate: string | null;
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

/**
 * Best-effort extraction of the handful of fields a loan statement upload needs: current
 * balance, interest rate, minimum payment, and statement date. Loan statement layouts vary
 * enormously by lender, so this is deliberately loose label-matching, not a strict parser -
 * the caller (loan uploader UI) always shows these as editable, pre-filled fields rather than
 * importing them silently, since 100% reliable extraction across arbitrary lenders isn't
 * realistic. Interest rate/minimum payment are informational only and never used in any
 * calculation elsewhere in the app.
 */
export async function parseLoanStatementPdf(file: File): Promise<LoanStatementFields> {
  const lines = await extractPdfLines(file);

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

  return { balance, interestRatePct, minimumPayment, statementDate };
}
