// The semantic-duplicate hint (decisions/0020-universal-intake.md's `semanticInvoiceKey`,
// decisions/0022-intake-wiring.md): same invoice number, sender (normalized), and amount, on a
// DIFFERENT file - never the same as `fileHash`'s exact-byte-duplicate check.
import { describe, expect, it } from "vitest";

import { findSemanticDuplicate, type InvoiceLikeDocument } from "../core/semantic-duplicate";

function doc(overrides: Partial<InvoiceLikeDocument> & Pick<InvoiceLikeDocument, "id">): InvoiceLikeDocument {
  return { invoiceNumber: "4711", sender: "Telekom Deutschland GmbH", totalAmountCents: 8368, ...overrides };
}

describe("findSemanticDuplicate", () => {
  it("finds a match sharing the same invoice number, sender, and amount", () => {
    const current = doc({ id: "current" });
    const others = [doc({ id: "earlier" })];
    expect(findSemanticDuplicate(current, others)).toEqual({ id: "earlier" });
  });

  it("matches the sender case/whitespace-insensitively (normalizeName)", () => {
    const current = doc({ id: "current", sender: "  telekom deutschland gmbh  " });
    const others = [doc({ id: "earlier", sender: "Telekom Deutschland GmbH" })];
    expect(findSemanticDuplicate(current, others)).toEqual({ id: "earlier" });
  });

  it("does not match a different amount", () => {
    const current = doc({ id: "current", totalAmountCents: 8368 });
    const others = [doc({ id: "other", totalAmountCents: 999 })];
    expect(findSemanticDuplicate(current, others)).toBeNull();
  });

  it("never matches itself even if it appears in the candidate list", () => {
    const current = doc({ id: "current" });
    expect(findSemanticDuplicate(current, [current])).toBeNull();
  });

  it("returns null when the current document is missing invoice number, sender, or amount", () => {
    expect(findSemanticDuplicate(doc({ id: "current", invoiceNumber: null }), [doc({ id: "other" })])).toBeNull();
    expect(findSemanticDuplicate(doc({ id: "current", sender: null }), [doc({ id: "other" })])).toBeNull();
    expect(findSemanticDuplicate(doc({ id: "current", totalAmountCents: null }), [doc({ id: "other" })])).toBeNull();
  });

  it("returns null when no candidate matches", () => {
    expect(findSemanticDuplicate(doc({ id: "current" }), [])).toBeNull();
  });
});
