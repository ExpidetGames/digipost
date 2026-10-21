// Server-side PDF assembly (decisions/0015-documents-and-quotas.md): pure functions over
// byte buffers, no I/O, no database, no storage - fully testable with small generated
// JPEG/PNG buffers (WEBAPP_TEMPLATE_SPEC.md §10.2). `pdf-lib` is a general-purpose library,
// not an architecturally sensitive vendor SDK (STRUCTURE.md's `vendor-sdk` rule leaves it
// unrestricted), so no port/injection is needed to keep this testable.
import { PDFDocument } from "pdf-lib";

/** A4 width in PDF points (72 dpi: 210mm / 25.4 * 72). Each image becomes one page at this
 * width, with its height derived from the image's own aspect ratio - a scanned letter photo
 * almost never has A4's exact aspect ratio, so the page is not forced to A4 height too. */
export const A4_WIDTH_POINTS = 595.28;

export type UploadImage = { bytes: Uint8Array; type: "jpeg" | "png" };

/** One page per image, at `A4_WIDTH_POINTS` wide with height following the image's own
 * aspect ratio, the image drawn to fill the page exactly. */
export async function assembleImagesIntoPdf(images: readonly UploadImage[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (const image of images) {
    const embedded = image.type === "jpeg" ? await pdf.embedJpg(image.bytes) : await pdf.embedPng(image.bytes);
    const width = A4_WIDTH_POINTS;
    const height = width * (embedded.height / embedded.width);
    const page = pdf.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }

  return pdf.save();
}

export type PdfValidationResult =
  | { valid: true; pageCount: number }
  | { valid: false; reason: "invalid_pdf" | "too_many_pages" };

/** Loads `bytes` with `pdf-lib` to confirm it is a parseable, unencrypted PDF (pdf-lib
 * throws for an encrypted document unless told to ignore it, which this deliberately does
 * not do - "reject encrypted/unparseable PDFs", architecture brief) and within `maxPages`. */
export async function validateUploadedPdf(bytes: Uint8Array, maxPages: number): Promise<PdfValidationResult> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch {
    return { valid: false, reason: "invalid_pdf" };
  }

  const pageCount = pdf.getPageCount();
  if (pageCount === 0) return { valid: false, reason: "invalid_pdf" };
  if (pageCount > maxPages) return { valid: false, reason: "too_many_pages" };
  return { valid: true, pageCount };
}
