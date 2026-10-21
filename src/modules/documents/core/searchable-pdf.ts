// Builds the "searchable PDF" (decisions/0016-processing-pipeline-and-ai.md, architecture
// brief): the original PDF's pages, unchanged, plus an invisible (opacity 0) OCR text layer
// positioned from Mistral's block coordinates where available, or distributed down the page
// from the markdown's own paragraphs otherwise. Pure aside from `pdf-lib`'s own CPU work: no
// network, no storage access - the caller (the processing use case) loads the original bytes
// and stores the result.
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

import { flattenMarkdownTables } from "./ocr-text";
import { sanitizeWinAnsi } from "./winansi";
import type { OcrBlock, OcrPage, OcrPageDimensions } from "./ports";

type PdfRect = { x: number; y: number; width: number; height: number };

const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 18;
const LINE_HEIGHT_RATIO = 1.15;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Maps a block's pixel bounding box (top-left origin, `dimensions`' pixel space - Mistral
 * OCR's own coordinate system) to a PDF-point rectangle (bottom-left origin - the PDF
 * coordinate system), scaling by the ratio between the OCR page's pixel size and the PDF
 * page's own point size, and flipping the y axis. A 90/270-degree page rotation swaps which
 * PDF dimension the OCR's pixel width/height each correspond to - `/Rotate 180` needs no
 * special handling (the crop box does not change orientation), so it is left to the plain
 * mapping below.
 */
export function mapBlockToPdfRect(block: OcrBlock, dimensions: OcrPageDimensions, pdfWidth: number, pdfHeight: number, rotationDegrees = 0): PdfRect {
  const rotated = ((rotationDegrees % 360) + 360) % 360;
  const effectivePdfWidth = rotated === 90 || rotated === 270 ? pdfHeight : pdfWidth;
  const effectivePdfHeight = rotated === 90 || rotated === 270 ? pdfWidth : pdfHeight;

  const scaleX = effectivePdfWidth / dimensions.width;
  const scaleY = effectivePdfHeight / dimensions.height;

  const left = block.topLeftX * scaleX;
  const top = block.topLeftY * scaleY;
  const right = block.bottomRightX * scaleX;
  const bottom = block.bottomRightY * scaleY;

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  // Flip: pixel-space y grows downward from the top; PDF-space y grows upward from the
  // bottom, so a box's PDF-space y (its bottom edge) is the page height minus the box's
  // pixel-space bottom edge.
  const y = effectivePdfHeight - bottom;

  if (rotated === 90 || rotated === 270) {
    // The mapping above was computed in the page's visually-rendered (post-rotation)
    // orientation; translate back into the PDF's own unrotated coordinate space so
    // `drawText` (which draws in that unrotated space, pdf-lib applies `/Rotate` itself at
    // render time) places text where the rotated page actually shows it.
    return rotated === 90
      ? { x: y, y: effectivePdfWidth - left - width, width: height, height: width }
      : { x: effectivePdfHeight - y - height, y: left, width: height, height: width };
  }

  return { x: left, y, width, height };
}

function wrapToWidth(text: string, font: PDFFont, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(attempt, fontSize) > maxWidth) {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
      current = word;
    } else {
      current = attempt;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function drawInvisibleText(page: PDFPage, font: PDFFont, content: string, rect: PdfRect): void {
  const sanitized = sanitizeWinAnsi(content).trim();
  if (!sanitized) return;

  const fontSize = clamp(rect.height * 0.6, MIN_FONT_SIZE, MAX_FONT_SIZE);
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const maxLines = Math.max(1, Math.floor(rect.height / lineHeight));
  const lines = wrapToWidth(sanitized, font, fontSize, Math.max(1, rect.width), maxLines);

  lines.forEach((line, i) => {
    const y = rect.y + rect.height - (i + 1) * lineHeight;
    // Invisible: opacity 0 keeps the text out of the rendered page (drawn, not just hidden
    // via color match) while still emitting real text-showing operators, so PDF viewers'
    // own text layer (selection/search) still finds it - the app's own full-text search
    // uses `documents.ocr_text` (a separate Postgres column), never this layer.
    page.drawText(line, { x: rect.x, y, size: fontSize, font, opacity: 0 });
  });
}

function drawParagraphsFallback(page: PDFPage, font: PDFFont, markdown: string, pdfWidth: number, pdfHeight: number): void {
  // Same table flattening `ocr-text.ts`'s `joinOcrText` applies to `documents.ocr_text`
  // (D1, decisions/0016-processing-pipeline-and-ai.md): without it, a markdown table caught by
  // this fallback (no `blocks` at all) would draw its raw `| a | b |` syntax as one giant
  // invisible "paragraph" instead of readable per-row text - keeping this consistent with
  // `ocr_text` rather than the two disagreeing about what a table's content even is.
  const paragraphs = flattenMarkdownTables(markdown)
    .split(/\n{2,}/)
    // A multi-row table collapses to one "paragraph" here (its rows are joined by a single
    // `\n`, not a blank line) - `sanitizeWinAnsi` below has no WinAnsi mapping for a raw
    // newline and would otherwise turn it into a literal "?" in the drawn text, so it is
    // normalized to a space first, same as `drawInvisibleText` already does implicitly for
    // any other whitespace via `wrapToWidth`'s own `\s+` word-splitting.
    .map((p) => p.trim().replace(/\n/g, " "))
    .filter(Boolean);
  if (paragraphs.length === 0) return;

  const marginX = pdfWidth * 0.08;
  const marginY = pdfHeight * 0.05;
  const usableWidth = pdfWidth - marginX * 2;
  const usableHeight = pdfHeight - marginY * 2;
  const rowHeight = usableHeight / paragraphs.length;

  paragraphs.forEach((paragraph, i) => {
    const rect: PdfRect = {
      x: marginX,
      y: pdfHeight - marginY - (i + 1) * rowHeight,
      width: usableWidth,
      height: rowHeight,
    };
    drawInvisibleText(page, font, paragraph, rect);
  });
}

/**
 * `pageCount` of the returned PDF always equals `pageCount` of `originalPdfBytes` - only an
 * invisible text layer is added, page content/images are untouched.
 */
export async function buildSearchablePdf(originalPdfBytes: Uint8Array, ocrPages: OcrPage[]): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  pages.forEach((page, i) => {
    const ocrPage = ocrPages.find((p) => p.index === i) ?? ocrPages[i];
    if (!ocrPage) return;

    const { width: pdfWidth, height: pdfHeight } = page.getSize();
    const rotation = page.getRotation().angle;

    if (ocrPage.blocks && ocrPage.blocks.length > 0 && ocrPage.dimensions) {
      for (const block of ocrPage.blocks) {
        const rect = mapBlockToPdfRect(block, ocrPage.dimensions, pdfWidth, pdfHeight, rotation);
        // A `type: "table"` block's own `content` is markdown table syntax, same as a page's
        // whole markdown would carry (D1) - flatten it the same way so the invisible text
        // layer reads as plain text rather than raw `| a | b |` punctuation. A multi-row
        // table flattens to several `\n`-joined lines drawn as one block, so newlines are
        // normalized to spaces the same way `drawParagraphsFallback` does (see its own
        // comment) - `sanitizeWinAnsi` has no WinAnsi mapping for a raw newline.
        const content = block.type === "table" ? flattenMarkdownTables(block.content).replace(/\n/g, " ") : block.content;
        drawInvisibleText(page, font, content, rect);
      }
    } else {
      drawParagraphsFallback(page, font, ocrPage.markdown, pdfWidth, pdfHeight);
    }
  });

  // `useObjectStreams: false`: keeps every PDF object (including the embedded font
  // dictionary) as a classic, individually-addressable object rather than bundled into a
  // compressed object stream - a broadly compatible choice for a document meant to be
  // opened by an arbitrary PDF viewer, and makes the font resource/text operators this
  // module's own tests assert on straightforwardly inspectable.
  return pdfDoc.save({ useObjectStreams: false });
}
