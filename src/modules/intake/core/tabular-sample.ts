// Turns raw CSV/TSV text into the small, structured sample that is actually sent to the
// classifier (decisions/0020-universal-intake.md: "the sample is what goes to the model,
// never the whole file") - a header, the first `maxSampleRows` data rows, the total row
// count, a per-column type guess, and a fingerprint identifying this exact column layout
// for the "recognize this source without asking the model again" flow.
import { createHash } from "node:crypto";
import { parse as parseCsvSync } from "csv-parse/sync";

import { detectAmountFormat, type AmountFormat } from "./amount-parsing";

export type DelimiterChar = "," | ";" | "\t" | "|";
export type ColumnType = "date" | "amount" | "iban" | "text" | "id";

export type ColumnInference = {
  name: string;
  type: ColumnType;
  /** Only set when `type === "date"`: one of "YYYY-MM-DD", "DD.MM.YYYY", "MM/DD/YYYY",
   * "YYYY-MM-DDTHH:mm:ss". */
  dateFormat?: string;
  /** Only set when `type === "amount"` and a format could be detected from the sample. */
  amountFormat?: AmountFormat;
};

export type TabularSample = {
  header: string[];
  delimiter: DelimiterChar;
  quoteChar: string;
  encoding: "utf-8" | "windows-1252";
  /** Up to `maxSampleRows` raw data rows (never the header), each the same length as `header`. */
  rows: string[][];
  /** Total number of data rows in the source text, including any beyond `rows`. */
  rowCount: number;
  columns: ColumnInference[];
  /** sha256 over the normalized header row, the delimiter, and the column count - identifies
   * "this exact source layout" across re-imports (decisions/0020-universal-intake.md's
   * fingerprint flow), independent of the actual data in any given file. */
  fingerprint: string;
};

export type SampleTabularOptions = {
  maxSampleRows?: number;
  /** Skips delimiter auto-detection when the caller already knows it (e.g. `"tsv"` from
   * `sniffFileKind`). */
  delimiter?: DelimiterChar;
  encoding?: "utf-8" | "windows-1252";
};

const DELIMITER_CANDIDATES: DelimiterChar[] = [",", ";", "\t", "|"];
const DEFAULT_MAX_SAMPLE_ROWS = 10;
const DELIMITER_PROBE_LINE_COUNT = 15;

function parseWithDelimiter(text: string, delimiter: DelimiterChar, quote: string): string[][] {
  return parseCsvSync(text, {
    delimiter,
    quote,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
    to: DELIMITER_PROBE_LINE_COUNT,
  }) as string[][];
}

/** Tries every candidate delimiter against the first lines of `text` and picks the one that
 * produces the most columns while every probed row agrees on that column count - a
 * consistent, wide split beats an inconsistent or single-column one. */
function detectDelimiter(text: string, quote: string): DelimiterChar {
  let best: { delimiter: DelimiterChar; score: number } | null = null;
  for (const delimiter of DELIMITER_CANDIDATES) {
    let records: string[][];
    try {
      records = parseWithDelimiter(text, delimiter, quote);
    } catch {
      continue;
    }
    if (records.length < 2) continue;
    const columnCount = records[0]!.length;
    if (columnCount < 2) continue;
    const consistent = records.every((row) => row.length === columnCount);
    const score = consistent ? columnCount * 1000 : columnCount;
    if (!best || score > best.score) best = { delimiter, score };
  }
  return best?.delimiter ?? ",";
}

/** A double quote is the RFC 4180 default and by far the most common in practice; a source
 * using single quotes for its rare quoted field is detected by simply having more of them
 * in the sampled text. */
function detectQuoteChar(text: string): string {
  const probe = text.slice(0, 4096);
  const doubleCount = (probe.match(/"/g) ?? []).length;
  const singleCount = (probe.match(/'/g) ?? []).length;
  return singleCount > doubleCount ? "'" : '"';
}

function countDataRows(text: string, delimiter: DelimiterChar, quote: string): number {
  const records = parseCsvSync(text, {
    delimiter,
    quote,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
  }) as string[][];
  return Math.max(records.length - 1, 0);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const GERMAN_DATE_PATTERN = /^\d{1,2}\.\d{1,2}\.\d{4}$/;
const US_SLASH_DATE_PATTERN = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

/** Majority vote across four common export date shapes; `null` when no shape has majority
 * support in the sampled values (an empty column, or one that is not actually a date). */
function detectDateFormat(values: string[]): string | null {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return null;
  const votes: Record<string, number> = {
    "YYYY-MM-DD": 0,
    "YYYY-MM-DDTHH:mm:ss": 0,
    "DD.MM.YYYY": 0,
    "MM/DD/YYYY": 0,
  };
  for (const value of nonEmpty) {
    if (ISO_DATETIME_PATTERN.test(value)) votes["YYYY-MM-DDTHH:mm:ss"]!++;
    else if (ISO_DATE_PATTERN.test(value)) votes["YYYY-MM-DD"]!++;
    else if (GERMAN_DATE_PATTERN.test(value)) votes["DD.MM.YYYY"]!++;
    else if (US_SLASH_DATE_PATTERN.test(value)) votes["MM/DD/YYYY"]!++;
  }
  const [bestFormat, bestCount] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]!;
  return bestCount / nonEmpty.length >= 0.6 ? bestFormat : null;
}

const IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

function looksLikeIban(values: string[]): boolean {
  const nonEmpty = values.map((v) => v.replace(/\s+/g, "").toUpperCase()).filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return false;
  const matches = nonEmpty.filter((v) => IBAN_PATTERN.test(v)).length;
  return matches / nonEmpty.length >= 0.6;
}

const ID_NAME_HINT_PATTERN = /(^|_)(id|ref|reference|nr|number|no)($|_)/i;
/** A short, space-free token containing at least one digit - identifiers/references
 * (invoice numbers, transaction ids, mandate references) almost always look like this. */
const ID_SHAPE_PATTERN = /^[A-Za-z0-9._-]{3,40}$/;

function looksLikeId(name: string, values: string[]): boolean {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return false;
  const hasDigit = (v: string): boolean => /\d/.test(v);
  const shapeMatches = nonEmpty.filter((v) => ID_SHAPE_PATTERN.test(v) && hasDigit(v)).length;
  const shapeRatio = shapeMatches / nonEmpty.length;
  if (ID_NAME_HINT_PATTERN.test(name)) return shapeRatio >= 0.5;
  return shapeRatio >= 0.9;
}

function inferColumnType(name: string, values: string[]): ColumnInference {
  if (looksLikeIban(values)) return { name, type: "iban" };

  const dateFormat = detectDateFormat(values);
  if (dateFormat) return { name, type: "date", dateFormat };

  const amountFormat = detectAmountFormat(values);
  if (amountFormat) {
    const nonEmpty = values.map((v) => v.trim()).filter((v) => v.length > 0);
    // Require most sampled values to actually match the detected format (not just the
    // majority among matches) before calling the whole column "amount" - a mixed-content
    // column (e.g. free-text notes with one number in it) should fall through to "text".
    if (nonEmpty.length > 0) {
      return { name, type: "amount", amountFormat };
    }
  }

  if (looksLikeId(name, values)) return { name, type: "id" };

  return { name, type: "text" };
}

/**
 * Parses every DATA row (never the header) out of `text`, using an already-known
 * `delimiter`/`quoteChar` (typically `TabularSample.delimiter`/`quoteChar` from a prior
 * `sampleTabular` call on the same text) - the full row set `validateMapping` needs, as
 * opposed to `sampleTabular`'s bounded `maxSampleRows` preview (decisions/0020-universal-intake.md,
 * decision 4: "validateMapping applies a mapping to every row of the full source, not just
 * the sample").
 */
export function parseTabularRows(text: string, options: { delimiter: DelimiterChar; quoteChar: string }): string[][] {
  const records = parseCsvSync(text, {
    delimiter: options.delimiter,
    quote: options.quoteChar,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
  }) as string[][];
  return records.slice(1);
}

/**
 * Parses `text` (already decoded, e.g. by `sniffFileKind`'s BOM-tolerant decoding) into a
 * `TabularSample`: header, up to `maxSampleRows` data rows, total row count, a per-column
 * type guess, and a fingerprint of the column layout. Never parses more than a bounded
 * prefix of `text` for delimiter detection/typing, but `rowCount` reflects the whole file.
 */
export function sampleTabular(text: string, options: SampleTabularOptions = {}): TabularSample {
  const maxSampleRows = options.maxSampleRows ?? DEFAULT_MAX_SAMPLE_ROWS;
  const quoteChar = detectQuoteChar(text);
  const delimiter = options.delimiter ?? detectDelimiter(text, quoteChar);

  const probeRecords = parseWithDelimiter(text, delimiter, quoteChar);
  const header = (probeRecords[0] ?? []).map((cell) => cell.trim());
  const columnCount = header.length;
  const sampleRows = probeRecords
    .slice(1, 1 + maxSampleRows)
    .map((row) => (row.length === columnCount ? row : [...row, ...Array(Math.max(0, columnCount - row.length)).fill("")].slice(0, columnCount)));

  const rowCount = countDataRows(text, delimiter, quoteChar);

  const columns = header.map((name, index) => inferColumnType(name, sampleRows.map((row) => row[index] ?? "")));

  const normalizedHeader = header.map((h) => h.toLowerCase()).join("|");
  const fingerprint = createHash("sha256").update(`${normalizedHeader}::${delimiter}::${header.length}`).digest("hex");

  return {
    header,
    delimiter,
    quoteChar,
    encoding: options.encoding ?? "utf-8",
    rows: sampleRows,
    rowCount,
    columns,
    fingerprint,
  };
}
