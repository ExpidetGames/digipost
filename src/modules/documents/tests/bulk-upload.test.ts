// G2 (decisions/0030-bulk-upload.md): classification rules and the queue "reducer",
// unit-tested independently of the component (`tests/upload-form.test.tsx` covers rendering).
import { describe, expect, it } from "vitest";

import {
  applyGroupResult,
  buildBulkUploadRows,
  classifyUploadGroups,
  countSettledRows,
  isImageFile,
  markGroupUploading,
  shouldShowImageSplitSwitch,
} from "../core/bulk-upload";

function pdf(name: string): File {
  return new File(["%PDF-1.7"], name, { type: "application/pdf" });
}

function jpeg(name: string): File {
  return new File(["jpeg-bytes"], name, { type: "image/jpeg" });
}

function csv(name: string): File {
  return new File(["a,b,c"], name, { type: "text/csv" });
}

describe("isImageFile", () => {
  it("recognizes a declared image/jpeg or image/png MIME type", () => {
    expect(isImageFile(jpeg("scan.jpg"))).toBe(true);
    expect(isImageFile(new File(["p"], "scan.png", { type: "image/png" }))).toBe(true);
  });

  it("falls back to the file extension when the MIME type is missing", () => {
    expect(isImageFile(new File(["p"], "scan.JPEG"))).toBe(true);
    expect(isImageFile(new File(["p"], "scan.png"))).toBe(true);
  });

  it("is not fooled by an unrelated declared image/* MIME type", () => {
    expect(isImageFile(new File(["p"], "scan.heic", { type: "image/heic" }))).toBe(false);
  });

  it("rejects a PDF or a structured file", () => {
    expect(isImageFile(pdf("brief.pdf"))).toBe(false);
    expect(isImageFile(csv("umsaetze.csv"))).toBe(false);
  });
});

describe("classifyUploadGroups", () => {
  it("rule 1: several PDFs are always one document each", () => {
    const groups = classifyUploadGroups([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], false);
    expect(groups).toEqual([[expect.objectContaining({ name: "a.pdf" })], [expect.objectContaining({ name: "b.pdf" })], [expect.objectContaining({ name: "c.pdf" })]]);
  });

  it("rule 1: several structured files are always one document each", () => {
    const groups = classifyUploadGroups([csv("a.csv"), csv("b.tsv")], false);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.length === 1)).toBe(true);
  });

  it("rule 2: several images stay pages of one document by default (switch off)", () => {
    const groups = classifyUploadGroups([jpeg("p1.jpg"), jpeg("p2.jpg"), jpeg("p3.jpg")], false);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("rule 2: the switch makes every image its own document", () => {
    const groups = classifyUploadGroups([jpeg("p1.jpg"), jpeg("p2.jpg"), jpeg("p3.jpg")], true);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.length === 1)).toBe(true);
  });

  it("rule 3: a mixed selection gives every PDF/structured file its own document, images grouped (switch off)", () => {
    const groups = classifyUploadGroups([pdf("invoice.pdf"), jpeg("p1.jpg"), csv("statement.csv"), jpeg("p2.jpg")], false);
    expect(groups).toHaveLength(3);
    expect(groups.filter((group) => group.length === 1)).toHaveLength(2);
    expect(groups.find((group) => group.length === 2)).toEqual([expect.objectContaining({ name: "p1.jpg" }), expect.objectContaining({ name: "p2.jpg" })]);
  });

  it("rule 3: a mixed selection with the switch on gives every file its own document", () => {
    const groups = classifyUploadGroups([pdf("invoice.pdf"), jpeg("p1.jpg"), jpeg("p2.jpg")], true);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.length === 1)).toBe(true);
  });

  it("an empty selection produces no groups", () => {
    expect(classifyUploadGroups([], false)).toEqual([]);
  });
});

describe("shouldShowImageSplitSwitch", () => {
  it("is false with fewer than 2 images", () => {
    expect(shouldShowImageSplitSwitch([pdf("a.pdf")])).toBe(false);
    expect(shouldShowImageSplitSwitch([jpeg("p1.jpg")])).toBe(false);
    expect(shouldShowImageSplitSwitch([jpeg("p1.jpg"), pdf("a.pdf")])).toBe(false);
  });

  it("is true with 2 or more images, mixed in with other files or not", () => {
    expect(shouldShowImageSplitSwitch([jpeg("p1.jpg"), jpeg("p2.jpg")])).toBe(true);
    expect(shouldShowImageSplitSwitch([pdf("a.pdf"), jpeg("p1.jpg"), jpeg("p2.jpg")])).toBe(true);
  });
});

describe("bulk upload queue", () => {
  it("buildBulkUploadRows creates one waiting row per file, tagged with its group index", () => {
    const groups = classifyUploadGroups([pdf("a.pdf"), jpeg("p1.jpg"), jpeg("p2.jpg")], false);
    const rows = buildBulkUploadRows(groups);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === "waiting")).toBe(true);
    expect(rows.filter((row) => row.groupIndex === 1)).toHaveLength(2);
  });

  it("processes groups in order: marking one group uploading leaves the others untouched", () => {
    const groups = classifyUploadGroups([pdf("a.pdf"), pdf("b.pdf")], false);
    const rows = markGroupUploading(buildBulkUploadRows(groups), 0);
    expect(rows[0]!.status).toBe("uploading");
    expect(rows[1]!.status).toBe("waiting");
  });

  it("a success marks only that group's rows done", () => {
    const groups = classifyUploadGroups([pdf("a.pdf"), pdf("b.pdf")], false);
    let rows = buildBulkUploadRows(groups);
    const applied = applyGroupResult(rows, 0, { status: "success" });
    rows = applied.rows;
    expect(applied.stopped).toBe(false);
    expect(rows[0]!.status).toBe("done");
    expect(rows[1]!.status).toBe("waiting");
  });

  it("a per-file error (e.g. duplicate) marks that row and lets the queue continue", () => {
    const groups = classifyUploadGroups([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], false);
    let rows = buildBulkUploadRows(groups);
    const applied = applyGroupResult(rows, 1, { status: "error", errorCode: "duplicate_document", existingDocumentId: "doc-1" });
    rows = applied.rows;
    expect(applied.stopped).toBe(false);
    expect(rows[1]!.status).toBe("error");
    expect(rows[1]!.errorCode).toBe("duplicate_document");
    expect(rows[1]!.existingDocumentId).toBe("doc-1");
    // The other rows are untouched, still waiting for their own turn.
    expect(rows[0]!.status).toBe("waiting");
    expect(rows[2]!.status).toBe("waiting");
  });

  it("a quota error stops the queue: the failing group errors, every still-waiting row is skipped", () => {
    const groups = classifyUploadGroups([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], false);
    let rows = buildBulkUploadRows(groups);
    rows = applyGroupResult(rows, 0, { status: "success" }).rows;
    const applied = applyGroupResult(rows, 1, { status: "error", errorCode: "quota_total_exceeded" });
    rows = applied.rows;
    expect(applied.stopped).toBe(true);
    expect(rows[0]!.status).toBe("done");
    expect(rows[1]!.status).toBe("error");
    expect(rows[1]!.errorCode).toBe("quota_total_exceeded");
    expect(rows[2]!.status).toBe("skipped");
  });

  it("countSettledRows counts done/error/skipped but not waiting/uploading", () => {
    const groups = classifyUploadGroups([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")], false);
    let rows = buildBulkUploadRows(groups);
    rows = applyGroupResult(rows, 0, { status: "success" }).rows;
    rows = applyGroupResult(rows, 1, { status: "error", errorCode: "unsupported_file_type" }).rows;
    rows = markGroupUploading(rows, 2);
    expect(countSettledRows(rows)).toBe(2);
  });
});
