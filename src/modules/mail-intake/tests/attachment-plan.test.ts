import { describe, expect, it } from "vitest";

import { attachmentDocumentName, MAX_ATTACHMENT_BYTES, planAttachments, type AttachmentMeta, type AttachmentResult } from "@/modules/mail-intake";

function meta(id: string, overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return { id, fileName: `${id}.pdf`, sizeBytes: 100_000, contentType: "application/pdf", ...overrides };
}

describe("planAttachments", () => {
  it("downloads ordinary attachments", () => {
    const plan = planAttachments([meta("a"), meta("b")], []);
    expect(plan.map((item) => item.kind)).toEqual(["download", "download"]);
  });

  it("skips small images (signature logos) but never a small PDF", () => {
    const plan = planAttachments([meta("logo", { contentType: "image/png", sizeBytes: 3_000 }), meta("tiny-pdf", { sizeBytes: 3_000 })], []);
    expect(plan[0]).toMatchObject({ kind: "done", result: { outcome: "skipped_small" } });
    expect(plan[1]).toMatchObject({ kind: "download" });
  });

  it("marks an attachment over 15 MB as too large without downloading it", () => {
    const plan = planAttachments([meta("big", { sizeBytes: MAX_ATTACHMENT_BYTES + 1 })], []);
    expect(plan[0]).toMatchObject({ kind: "done", result: { outcome: "too_large" } });
  });

  it("processes at most ten candidates; small images do not count", () => {
    const attachments = [meta("logo", { contentType: "image/png", sizeBytes: 100 }), ...Array.from({ length: 12 }, (_, i) => meta(`a${i}`))];
    const plan = planAttachments(attachments, []);
    expect(plan.filter((item) => item.kind === "download")).toHaveLength(10);
    expect(plan.slice(11).map((item) => (item.kind === "done" ? item.result.outcome : item.kind))).toEqual(["over_limit", "over_limit"]);
  });

  it("keeps the results of a previous attempt and only downloads the rest", () => {
    const previous: AttachmentResult[] = [{ attachmentId: "a", fileName: "a.pdf", sizeBytes: 1, outcome: "imported", documentId: "d1" }];
    const plan = planAttachments([meta("a"), meta("b")], previous);
    expect(plan[0]).toEqual({ kind: "done", result: previous[0] });
    expect(plan[1]).toMatchObject({ kind: "download", attachment: { id: "b" } });
  });
});

describe("attachmentDocumentName", () => {
  it("falls back to a German name", () => {
    expect(attachmentDocumentName("  ")).toBe("E-Mail-Anhang");
    expect(attachmentDocumentName("rechnung.pdf")).toBe("rechnung.pdf");
  });
});
