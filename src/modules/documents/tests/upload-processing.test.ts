// Unit tests for the upload orchestration function (WEBAPP_TEMPLATE_SPEC.md §10.2): magic
// bytes, PDF validation, and image assembly combined, no I/O.
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { processUploadParts } from "../core/upload-processing";

const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function png(): Uint8Array {
  return new Uint8Array(Buffer.from(PNG_1X1_B64, "base64"));
}

async function validPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 300]);
  return doc.save();
}

describe("processUploadParts", () => {
  it("rejects an empty request with no_file", async () => {
    const result = await processUploadParts([]);
    expect(result).toEqual({ ok: false, errorCode: "no_file" });
  });

  it("rejects more parts than the page limit with too_many_pages", async () => {
    const parts = Array.from({ length: 4 }, () => png());
    const result = await processUploadParts(parts, 3);
    expect(result).toEqual({ ok: false, errorCode: "too_many_pages" });
  });

  it("rejects a part that sniffs as none of PDF/JPEG/PNG with unsupported_file_type", async () => {
    const result = await processUploadParts([png(), new Uint8Array([0x00, 0x01, 0x02, 0x03])], 20);
    expect(result).toEqual({ ok: false, errorCode: "unsupported_file_type" });
  });

  it("accepts a single valid PDF as-is", async () => {
    const pdfBytes = await validPdf(2);
    const result = await processUploadParts([pdfBytes], 20);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pageCount).toBe(2);
      expect(result.data.pdfBytes).toBe(pdfBytes);
    }
  });

  it("rejects a single PDF that exceeds the page limit", async () => {
    const pdfBytes = await validPdf(5);
    const result = await processUploadParts([pdfBytes], 3);
    expect(result).toEqual({ ok: false, errorCode: "too_many_pages" });
  });

  it("rejects an unparseable single PDF with invalid_pdf", async () => {
    const result = await processUploadParts([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00])], 20);
    expect(result).toEqual({ ok: false, errorCode: "invalid_pdf" });
  });

  it("assembles 1..20 images into one PDF", async () => {
    const result = await processUploadParts([png(), png(), png()], 20);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pageCount).toBe(3);
      const pdf = await PDFDocument.load(result.data.pdfBytes);
      expect(pdf.getPageCount()).toBe(3);
    }
  });

  it("rejects a PDF mixed with images (neither a single PDF nor all images)", async () => {
    const pdfBytes = await validPdf(1);
    const result = await processUploadParts([pdfBytes, png()], 20);
    expect(result).toEqual({ ok: false, errorCode: "unsupported_file_type" });
  });
});
