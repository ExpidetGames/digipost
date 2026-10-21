// Joins OCR markdown across pages into the plain(ish) text stored in `documents.ocr_text`
// (full-text search + the detail view's "Erkannter Text" panel, decisions/0016-processing-pipeline-and-ai.md).
// Pure, no I/O.
import type { OcrPage } from "./ports";

// A line that is entirely a markdown table row: starts and ends with `|` (Mistral emits
// well-formed GFM tables, always with leading/trailing pipes). Matched against a single,
// already-trimmed line, never across a whole multi-line string.
const TABLE_ROW_PATTERN = /^\|(.*)\|$/;
// A table's own header/body separator row (`| --- | :---: |`): only pipes, dashes, colons,
// and whitespace, with at least one dash so an all-blank/empty row is not mistaken for one.
const TABLE_SEPARATOR_PATTERN = /^[|:\s-]+$/;

/**
 * A Mistral OCR placeholder link for an extracted asset (`![img-0.jpeg](img-0.jpeg)` for an
 * image, `[tbl-3.html](tbl-3.html)` for a table's own HTML rendering) - always self-referential:
 * the visible link text and the link target are the exact same string, because the
 * "placeholder" is just a pointer to the asset's own file name, never real prose. A real
 * markdown link or image with distinct alt text/caption never matches this and is left
 * untouched - only the placeholder shape itself is stripped (this function used to strip
 * every image AND every table row outright, which threw away real invoice line items; see
 * `flattenMarkdownTables` below for what replaced the table half of that).
 */
const ASSET_PLACEHOLDER_PATTERN = /!?\[([^\]\n]+)]\(([^)\n]+)\)/g;

function stripAssetPlaceholders(markdown: string): string {
  return markdown.replace(ASSET_PLACEHOLDER_PATTERN, (full, text: string, url: string) => (text === url ? "" : full));
}

function isTableSeparatorRow(line: string): boolean {
  return TABLE_SEPARATOR_PATTERN.test(line) && line.includes("-");
}

/** `| Pos | Menge | 19 % |` -> `Pos | Menge | 19 %` - strips the outer pipes, trims every
 * cell, and drops empty cells (a leading/trailing pipe or a genuinely empty column) so the
 * joined line reads as plain text rather than carrying markdown table punctuation around
 * nothing. */
function flattenTableRow(line: string): string {
  const match = TABLE_ROW_PATTERN.exec(line);
  const inner = match ? match[1]! : line;
  const cells = inner
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  return cells.join(" | ");
}

/**
 * Converts every markdown table into one plain-text line per row, cells joined by " | ",
 * separator rows (`---|---`) dropped entirely, empty cells collapsed. This is what keeps a
 * real invoice's line items, quantities, unit prices, tax rates and totals - the whole
 * point of OCR-ing an invoice - searchable in `documents.ocr_text` and visible in the
 * detail view's "Erkannter Text" panel, instead of being discarded outright (the previous
 * behavior: `.replace(/^\|.*\|$/gm, "")` deleted every table row unconditionally). Exported
 * so `searchable-pdf.ts` can apply the exact same flattening to a `type: "table"` OCR
 * block's own content and to the whole-page markdown fallback, keeping the invisible PDF
 * text layer consistent with `ocr_text` rather than the two disagreeing about whether a
 * table's content exists at all.
 */
export function flattenMarkdownTables(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!TABLE_ROW_PATTERN.test(trimmed)) return line;
      if (isTableSeparatorRow(trimmed)) return null;
      return flattenTableRow(trimmed);
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

function stripMarkdownNoise(markdown: string): string {
  return flattenMarkdownTables(stripAssetPlaceholders(markdown))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Joins every page's markdown with a blank line between pages: asset placeholder links
 * stripped, real table content flattened to plain text (see `flattenMarkdownTables`), never
 * table rows or images with real content. */
export function joinOcrText(pages: OcrPage[]): string {
  return pages
    .map((page) => stripMarkdownNoise(page.markdown))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Truncates OCR text to a sane size before it is sent to the analyzer prompt (requirement
 * 5 of decisions/0016-processing-pipeline-and-ai.md): a long multi-page letter does not need
 * its full text analyzed, and keeping the prompt small keeps cost and latency down.
 *
 * A normal one-page invoice comfortably fits under the 6000-character default even with its
 * line-item table now included in full: a real German invoice (Mistral OCR, verified against
 * the live API) produced 1701 characters of markdown total, well under a third of the limit.
 * For a long multi-page document, this still cuts the text off mid-content and appends
 * "[...gekürzt...]" - if that document's line-item table or total sits near the end (a long
 * contract with a fee schedule on its last page, say), the analyzer never sees it and the
 * extracted title/summary are based on the truncated prefix only. This is the accepted
 * trade-off from decisions/0016 requirement 5 (prompt size/cost/latency over completeness for
 * the analysis call only) - `documents.ocr_text` itself is never truncated, only what is sent
 * to the analyzer prompt, so full-text search and the "Erkannter Text" panel are unaffected
 * regardless of document length.
 */
export function truncateForAnalysis(text: string, maxLength = 6000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[...gekürzt...]` : text;
}
