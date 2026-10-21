// Unit tests for PDF assembly (WEBAPP_TEMPLATE_SPEC.md §10.2): small generated JPEG/PNG
// buffers, page count and page sizes asserted with pdf-lib itself, no I/O.
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { A4_WIDTH_POINTS, assembleImagesIntoPdf, validateUploadedPdf } from "../core/pdf-assembly";

// A tiny 40x60 red JPEG (portrait, aspect ratio 1.5) and a tiny 60x40 blue PNG (landscape,
// aspect ratio ~0.667), generated once with Pillow - real, valid, pdf-lib-parseable image
// bytes, not just magic-byte signatures (the point of this test).
const JPEG_40X60_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAA8ACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/2Q==";
const PNG_60X40_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAADwAAAAoCAIAAAAt2Q6oAAAASklEQVR4nO3OQQ3AIAAAMUDIdCIRWfOwx5ElrYLOZ5/xN+t24AvpinRFuiJdka5IV6Qr0hXpinRFuiJdka5IV6Qr0hXpinRFuvICMRcBrjkCUoIAAAAASUVORK5CYII=";

function bytesFromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

describe("assembleImagesIntoPdf", () => {
  it("creates one page per image, each A4-width wide", async () => {
    const pdfBytes = await assembleImagesIntoPdf([
      { bytes: bytesFromBase64(JPEG_40X60_B64), type: "jpeg" },
      { bytes: bytesFromBase64(PNG_60X40_B64), type: "png" },
    ]);

    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBe(2);

    const [page1, page2] = pdf.getPages();
    expect(page1!.getWidth()).toBeCloseTo(A4_WIDTH_POINTS);
    expect(page2!.getWidth()).toBeCloseTo(A4_WIDTH_POINTS);
  });

  it("derives each page's height from its image's own aspect ratio", async () => {
    // Portrait image (40x60, aspect ratio 1.5): the page should be taller than it is wide.
    const portraitPdf = await assembleImagesIntoPdf([{ bytes: bytesFromBase64(JPEG_40X60_B64), type: "jpeg" }]);
    const portraitPage = (await PDFDocument.load(portraitPdf)).getPage(0);
    expect(portraitPage.getHeight()).toBeCloseTo(A4_WIDTH_POINTS * 1.5, 0);

    // Landscape image (60x40, aspect ratio ~0.667): the page should be wider than it is tall.
    const landscapePdf = await assembleImagesIntoPdf([{ bytes: bytesFromBase64(PNG_60X40_B64), type: "png" }]);
    const landscapePage = (await PDFDocument.load(landscapePdf)).getPage(0);
    expect(landscapePage.getHeight()).toBeCloseTo(A4_WIDTH_POINTS * (40 / 60), 0);
    expect(landscapePage.getHeight()).toBeLessThan(landscapePage.getWidth());
  });

  it("produces one page for a single image", async () => {
    const pdfBytes = await assembleImagesIntoPdf([{ bytes: bytesFromBase64(PNG_60X40_B64), type: "png" }]);
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBe(1);
  });
});

describe("validateUploadedPdf", () => {
  it("accepts a valid, unencrypted PDF within the page limit", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    doc.addPage([200, 300]);
    const bytes = await doc.save();

    const result = await validateUploadedPdf(bytes, 20);
    expect(result).toEqual({ valid: true, pageCount: 2 });
  });

  it("rejects a PDF with more pages than the limit", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 5; i += 1) doc.addPage([200, 300]);
    const bytes = await doc.save();

    const result = await validateUploadedPdf(bytes, 3);
    expect(result).toEqual({ valid: false, reason: "too_many_pages" });
  });

  it("rejects an unparseable buffer", async () => {
    const result = await validateUploadedPdf(new Uint8Array([1, 2, 3, 4]), 20);
    expect(result).toEqual({ valid: false, reason: "invalid_pdf" });
  });
});
