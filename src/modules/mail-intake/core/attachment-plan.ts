// Which attachments of a received mail are worth downloading at all (decisions/0075-email-intake.md).
// Pure: decided from the provider's metadata alone, before any byte is fetched. Whether a
// downloaded file is actually a supported format is decided later by its bytes
// (`@/modules/documents`'s `processIntakeUpload`), never by its name or declared type.
import type { AttachmentResult } from "./inbound-email";

/** Per attachment (user decision): a scanned letter is far below this; a 15 MB file is about
 * the largest a mail server forwards anyway. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Per mail (user decision): the first ten candidates are processed, every further one is
 * recorded as `over_limit`. */
export const MAX_ATTACHMENTS_PER_EMAIL = 10;
/** An image below this is a logo, an icon or a tracking pixel in a mail signature, never a
 * photographed page (a phone photo of a letter is hundreds of kilobytes). Decided by size
 * rather than by `Content-Disposition: inline`, because Apple Mail sends a photo taken in
 * the mail app itself as an inline image. */
export const MIN_IMAGE_BYTES = 20 * 1024;

export type AttachmentMeta = {
  id: string;
  fileName: string;
  /** `null` when the provider did not report a size. */
  sizeBytes: number | null;
  contentType: string | null;
};

export type AttachmentPlanItem =
  | { kind: "done"; result: AttachmentResult }
  | { kind: "download"; attachment: AttachmentMeta };

/**
 * One item per attachment, in the provider's order. `previous` are the results a former run
 * of the same job already stored: those attachments are not touched again, so a retry after
 * a partial success never imports anything twice and never re-counts the quota.
 */
export function planAttachments(attachments: readonly AttachmentMeta[], previous: readonly AttachmentResult[]): AttachmentPlanItem[] {
  const previousById = new Map(previous.map((result) => [result.attachmentId, result]));
  const plan: AttachmentPlanItem[] = [];
  let candidates = 0;

  for (const attachment of attachments) {
    const earlier = previousById.get(attachment.id);
    const isImage = (attachment.contentType ?? "").toLowerCase().startsWith("image/");

    if (isImage && attachment.sizeBytes !== null && attachment.sizeBytes < MIN_IMAGE_BYTES) {
      plan.push({ kind: "done", result: earlier ?? resultFor(attachment, "skipped_small") });
      continue;
    }

    candidates += 1;
    if (earlier) {
      plan.push({ kind: "done", result: earlier });
      continue;
    }
    if (candidates > MAX_ATTACHMENTS_PER_EMAIL) {
      plan.push({ kind: "done", result: resultFor(attachment, "over_limit") });
      continue;
    }
    if (attachment.sizeBytes !== null && attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
      plan.push({ kind: "done", result: resultFor(attachment, "too_large") });
      continue;
    }
    plan.push({ kind: "download", attachment });
  }

  return plan;
}

export function resultFor(attachment: AttachmentMeta, outcome: AttachmentResult["outcome"], extra: Partial<AttachmentResult> = {}): AttachmentResult {
  return { attachmentId: attachment.id, fileName: attachment.fileName, sizeBytes: attachment.sizeBytes, outcome, ...extra };
}

/** A safe display/file name for a document created from an attachment: the attachment's own
 * name when it has one, otherwise a German fallback. */
export function attachmentDocumentName(fileName: string | null | undefined): string {
  const trimmed = (fileName ?? "").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 255) : "E-Mail-Anhang";
}
