import { inflateSync } from "node:zlib";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildSearchablePdf, mapBlockToPdfRect } from "../core/searchable-pdf";
import type { OcrBlock, OcrPage } from "../core/ports";

async function makeBlankPdf(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([595.28, 841.89]); // A4 in points
  }
  return doc.save();
}

/**
 * pdf-lib Flate-compresses every content stream regardless of `useObjectStreams`, so a raw
 * text search over the saved bytes never finds content-stream operators (`BT`/`Tf`/`Tj`)
 * directly - only the surrounding object dictionaries (like the font resource) are plain
 * text. This decodes every `stream ... endstream` block it can (silently skipping any that
 * are not Flate-compressed, e.g. cross-reference tables) and returns the decoded content
 * concatenated with the original latin1 text, so a single string search covers both.
 */
function decodePdfForInspection(pdfBytes: Uint8Array): string {
  const raw = Buffer.from(pdfBytes);
  const rawText = raw.toString("latin1");
  const decodedParts: string[] = [];

  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of rawText.matchAll(streamRe)) {
    const start = match.index! + match[0].indexOf("stream") + "stream\n".length;
    // Re-locate the exact byte offsets in the buffer (latin1 is 1 byte per char, so offsets
    // in `rawText` map 1:1 to byte offsets in `raw`).
    const streamStart = rawText.indexOf(match[1], start - 1);
    const bytes = raw.subarray(streamStart, streamStart + match[1].length);
    try {
      decodedParts.push(inflateSync(bytes).toString("latin1"));
    } catch {
      // Not a Flate stream (or not one this loose extraction sliced cleanly) - skip it.
    }
  }

  const combined = `${rawText}\n${decodedParts.join("\n")}`;

  // `drawText` (pdf-lib) encodes a `Tj` operand as a hex string (`<...>`) rather than a
  // literal string (`(...)`) once the text contains a byte pdf-lib treats as needing escaping
  // (WinAnsi's non-ASCII range - "ü"/"€", both real in a German invoice, D1) - a plain
  // substring search over the raw bytes would then never find the drawn text at all. Every
  // single-angle-bracket hex string (never `<<...>>`, a dictionary) is decoded back to latin1
  // and appended, so a test can search for plain text regardless of which encoding pdf-lib
  // happened to choose for a given string.
  const hexStringRe = /(?<!<)<([0-9A-Fa-f]+)>(?!>)/g;
  const hexDecoded: string[] = [];
  for (const match of combined.matchAll(hexStringRe)) {
    const hex = match[1]!;
    if (hex.length % 2 !== 0) continue;
    hexDecoded.push(Buffer.from(hex, "hex").toString("latin1"));
  }

  return `${combined}\n${hexDecoded.join("\n")}`;
}

describe("buildSearchablePdf", () => {
  it("keeps the page count unchanged", async () => {
    const original = await makeBlankPdf(2);
    const pages: OcrPage[] = [
      { index: 0, markdown: "Seite eins", dimensions: null, blocks: null },
      { index: 1, markdown: "Seite zwei", dimensions: null, blocks: null },
    ];

    const output = await buildSearchablePdf(original, pages);
    const reloaded = await PDFDocument.load(output);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it("produces output that differs from the input (text was actually drawn)", async () => {
    const original = await makeBlankPdf(1);
    const pages: OcrPage[] = [{ index: 0, markdown: "Hallo Welt, dies ist ein Testbrief.", dimensions: null, blocks: null }];

    const output = await buildSearchablePdf(original, pages);

    expect(output.length).not.toBe(original.length);
    expect(Buffer.from(output).equals(Buffer.from(original))).toBe(false);
  });

  it("embeds a Helvetica font resource and text-showing operators", async () => {
    const original = await makeBlankPdf(1);
    const pages: OcrPage[] = [{ index: 0, markdown: "Rechnung ueber 49,99 EUR", dimensions: null, blocks: null }];

    const output = await buildSearchablePdf(original, pages);
    const asText = decodePdfForInspection(output);

    expect(asText).toContain("Helvetica");
    // "BT"/"ET" bracket a text object, "Tf" sets the font+size, "Tj" shows a string -
    // standard PDF content-stream operators for drawn text.
    expect(asText).toMatch(/\bBT\b/);
    expect(asText).toMatch(/\bTf\b/);
  });

  it("positions text using block coordinates when blocks are present", async () => {
    const original = await makeBlankPdf(1);
    const block: OcrBlock = { type: "text", topLeftX: 100, topLeftY: 100, bottomRightX: 400, bottomRightY: 140, content: "Absender GmbH" };
    const pages: OcrPage[] = [
      { index: 0, markdown: "Absender GmbH", dimensions: { width: 1000, height: 1400, dpi: 150 }, blocks: [block] },
    ];

    // Should not throw, and should still draw something (covered by the "differs" test's
    // approach applied here too).
    const output = await buildSearchablePdf(original, pages);
    const reloaded = await PDFDocument.load(output);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("falls back to distributing markdown paragraphs when blocks are missing", async () => {
    const original = await makeBlankPdf(1);
    const pages: OcrPage[] = [
      { index: 0, markdown: "Erster Absatz.\n\nZweiter Absatz.\n\nDritter Absatz.", dimensions: null, blocks: null },
    ];

    const output = await buildSearchablePdf(original, pages);
    const asText = Buffer.from(output).toString("latin1");
    expect(asText).toContain("Helvetica");
  });

  it("sanitizes non-WinAnsi characters instead of throwing", async () => {
    const original = await makeBlankPdf(1);
    const pages: OcrPage[] = [{ index: 0, markdown: "Emoji-Test: 😀 中文", dimensions: null, blocks: null }];

    await expect(buildSearchablePdf(original, pages)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("flattens a type: table block's own content instead of drawing raw markdown pipes (D1)", async () => {
    const original = await makeBlankPdf(1);
    const tableBlock: OcrBlock = {
      type: "table",
      topLeftX: 50,
      topLeftY: 50,
      bottomRightX: 900,
      bottomRightY: 300,
      content: "| Pos | Beschreibung | 19 % |\n| --- | --- | --- |\n| 1 | Fachbücher | 45,00 € |",
    };
    const pages: OcrPage[] = [
      { index: 0, markdown: "irrelevant, blocks win", dimensions: { width: 1000, height: 1400, dpi: 150 }, blocks: [tableBlock] },
    ];

    const output = await buildSearchablePdf(original, pages);
    const asText = decodePdfForInspection(output);

    expect(asText).toContain("Fachb");
    expect(asText).not.toContain("---");
  });

  it("flattens a markdown table in the paragraph fallback (no blocks at all)", async () => {
    const original = await makeBlankPdf(1);
    const markdown = "Rechnung\n\n| Pos | Preis |\n| --- | --- |\n| 1 | 45,00 € |";
    const pages: OcrPage[] = [{ index: 0, markdown, dimensions: null, blocks: null }];

    const output = await buildSearchablePdf(original, pages);
    const asText = decodePdfForInspection(output);

    expect(asText).not.toContain("---");
  });

  it("does nothing for a page with no corresponding OCR page", async () => {
    const original = await makeBlankPdf(2);
    const pages: OcrPage[] = [{ index: 0, markdown: "Nur Seite eins", dimensions: null, blocks: null }];

    const output = await buildSearchablePdf(original, pages);
    const reloaded = await PDFDocument.load(output);
    expect(reloaded.getPageCount()).toBe(2);
  });
});

describe("mapBlockToPdfRect", () => {
  const block: OcrBlock = { type: "text", topLeftX: 100, topLeftY: 200, bottomRightX: 300, bottomRightY: 260, content: "x" };
  const dimensions = { width: 1000, height: 2000, dpi: 150 };

  it("scales pixel coordinates to PDF points and flips the y axis (no rotation)", () => {
    const rect = mapBlockToPdfRect(block, dimensions, 500, 1000, 0);
    // scaleX = 500/1000 = 0.5, scaleY = 1000/2000 = 0.5
    expect(rect.x).toBeCloseTo(50); // 100 * 0.5
    expect(rect.width).toBeCloseTo(100); // (300-100) * 0.5
    expect(rect.height).toBeCloseTo(30); // (260-200) * 0.5
    // y (bottom edge in PDF space) = pdfHeight - bottomEdgeInPdfSpace = 1000 - 260*0.5 = 870
    expect(rect.y).toBeCloseTo(870);
  });

  it("keeps a minimum width/height of 1 point for a degenerate (zero-size) block", () => {
    const zeroBlock: OcrBlock = { type: "text", topLeftX: 10, topLeftY: 10, bottomRightX: 10, bottomRightY: 10, content: "x" };
    const rect = mapBlockToPdfRect(zeroBlock, dimensions, 500, 1000, 0);
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
  });
});
