import { describe, expect, it } from "vitest";

import { fileHash, semanticInvoiceKey } from "../core/duplicate";

describe("fileHash", () => {
  it("is deterministic for the same bytes", () => {
    const bytes = new TextEncoder().encode("hello world");
    expect(fileHash(bytes)).toBe(fileHash(bytes.slice()));
  });

  it("differs for different bytes", () => {
    expect(fileHash(new TextEncoder().encode("a"))).not.toBe(fileHash(new TextEncoder().encode("b")));
  });

  it("returns a 64-character hex sha256 digest", () => {
    expect(fileHash(new Uint8Array(0))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("semanticInvoiceKey", () => {
  it("is the same for the same invoice number/sender/amount regardless of case/whitespace", () => {
    const a = semanticInvoiceKey({ invoiceNumber: "RE-2026-1001", senderNormalized: "telekom deutschland gmbh", amountCents: 9900 });
    const b = semanticInvoiceKey({ invoiceNumber: " re-2026-1001 ", senderNormalized: "TELEKOM DEUTSCHLAND GMBH", amountCents: 9900 });
    expect(a).toBe(b);
  });

  it("differs when the amount differs", () => {
    const a = semanticInvoiceKey({ invoiceNumber: "RE-1", senderNormalized: "acme", amountCents: 1000 });
    const b = semanticInvoiceKey({ invoiceNumber: "RE-1", senderNormalized: "acme", amountCents: 1001 });
    expect(a).not.toBe(b);
  });

  it("differs when the sender differs", () => {
    const a = semanticInvoiceKey({ invoiceNumber: "RE-1", senderNormalized: "acme", amountCents: 1000 });
    const b = semanticInvoiceKey({ invoiceNumber: "RE-1", senderNormalized: "other", amountCents: 1000 });
    expect(a).not.toBe(b);
  });
});
