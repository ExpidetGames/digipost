// Content-level duplicate detection helpers (decisions/0020-universal-intake.md: "a
// fingerprint of the source lets the next file from the same source pass without another
// model call" is about the SOURCE layout; these two are about a specific FILE or invoice
// being a duplicate of one already imported). Pure, no I/O - F1b wires these into the actual
// upload/import flow and its own persistence.
import { createHash } from "node:crypto";

/** sha256 hex digest of the raw file bytes - an exact-duplicate-upload check (the same PDF,
 * CSV, or XML file uploaded twice). */
export function fileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type SemanticInvoiceKeyInput = {
  invoiceNumber: string;
  /** The sender's name, already normalized by the caller (e.g.
   * `src/modules/contacts`'s `normalizeName` once C2 wires the two modules together - this
   * module does not depend on `src/modules/contacts` itself, only on receiving an
   * already-normalized string). */
  senderNormalized: string;
  amountCents: number;
};

/**
 * A content-level duplicate key for an invoice: the same invoice number, from the same
 * (normalized) sender, for the same amount, is almost certainly the same invoice even when
 * it arrives as a different file (a re-scanned paper copy, a re-sent PDF with different
 * metadata). Deliberately excludes the file's own bytes/hash - that is what `fileHash`
 * already covers for the "identical file" case; this key catches "different file, same
 * invoice" instead.
 */
export function semanticInvoiceKey(input: SemanticInvoiceKeyInput): string {
  return createHash("sha256")
    .update([input.invoiceNumber.trim().toLowerCase(), input.senderNormalized.trim().toLowerCase(), String(input.amountCents)].join("|"))
    .digest("hex");
}
