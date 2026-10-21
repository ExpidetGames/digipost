// The semantic-duplicate hint (decisions/0020-universal-intake.md's "Content-level duplicate
// detection", the `semanticInvoiceKey` half; wired by decisions/0022-intake-wiring.md): the
// same invoice arriving as a DIFFERENT file (a re-scan, a re-sent PDF) - as opposed to
// `fileHash`'s "the exact same bytes uploaded twice", which `createFromUpload` already
// rejects outright. This never deletes or blocks anything: it only marks the document with a
// visible hint and a link to the other match, for a human to resolve. Pure, no I/O: the
// caller (`DocumentUseCases.getPossibleDuplicateInvoice`) supplies every OTHER document
// sharing the same invoice number (already narrowed by the `(workspace_id, invoice_number)`
// index), and this function decides which of them, if any, is the same invoice by content.
import { normalizeName } from "@/modules/contacts";
import { semanticInvoiceKey } from "@/modules/intake";

export type InvoiceLikeDocument = {
  id: string;
  invoiceNumber: string | null;
  sender: string | null;
  totalAmountCents: number | null;
};

function keyFor(doc: InvoiceLikeDocument): string | null {
  if (!doc.invoiceNumber || !doc.sender || doc.totalAmountCents === null) return null;
  return semanticInvoiceKey({ invoiceNumber: doc.invoiceNumber, senderNormalized: normalizeName(doc.sender), amountCents: doc.totalAmountCents });
}

/**
 * `null` when `current` itself does not carry enough invoice-shaped data to compute a key
 * (a non-invoice document, or one missing invoice number/sender/amount), or when none of
 * `others` shares the same `semanticInvoiceKey`. `others` is expected to already be narrowed
 * to the same `invoiceNumber` (the repository's own indexed lookup) - this function's own job
 * is only the sender/amount comparison `semanticInvoiceKey` bundles together, never a
 * workspace-wide scan.
 */
export function findSemanticDuplicate(current: InvoiceLikeDocument, others: readonly InvoiceLikeDocument[]): { id: string } | null {
  const currentKey = keyFor(current);
  if (!currentKey) return null;

  const match = others.find((other) => other.id !== current.id && keyFor(other) === currentKey);
  return match ? { id: match.id } : null;
}
