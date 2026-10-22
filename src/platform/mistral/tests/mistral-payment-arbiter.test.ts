import { describe, expect, it, vi } from "vitest";

import type { MatchableDocument, MatchableTransaction } from "@/modules/payments";

import { createMistralPaymentArbiter } from "../server/mistral-payment-arbiter";

function chatResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status });
}

function tx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "tx-1",
    bookingDate: "2026-09-15",
    amountCents: -10_000,
    currency: "EUR",
    counterpartyName: "Musterwerk GmbH",
    counterpartyIban: "DE12345678901234567890",
    remittanceText: "RE-2026-00001",
    endToEndId: null,
    accountId: "acct-1",
    ...overrides,
  };
}

function doc(overrides: Partial<MatchableDocument> = {}): MatchableDocument {
  return {
    id: "doc-1",
    direction: "incoming",
    invoiceNumber: "RE-2026-00001",
    totalAmountCents: 10_000,
    currency: "EUR",
    documentDate: "2026-09-01",
    dueDate: null,
    paymentIban: null,
    contactId: "contact-1",
    contactIban: null,
    contactName: "Musterwerk GmbH",
    openAmountCents: 10_000,
    ...overrides,
  };
}

describe("createMistralPaymentArbiter", () => {
  it("names its model and prompt fingerprint in its version, so a change of either asks cached questions again (decisions/0077)", () => {
    const small = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl: vi.fn() });
    const medium = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-medium-latest", fetchImpl: vi.fn() });
    expect(small.version).toMatch(/^mistral:mistral-small-latest:[0-9a-f]{16}$/);
    expect(small.version).toBe(createMistralPaymentArbiter({ apiKey: "other", model: "mistral-small-latest", fetchImpl: vi.fn() }).version);
    expect(medium.version).not.toBe(small.version);
  });

  it("sends temperature 0 and response_format json_object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({ bestDocumentId: "doc-1", confidence: 0.9, reason: "Passt." }));
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await arbiter.rank({ transaction: tx(), candidates: [doc()] });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("includes the candidates and the untrusted-data delimiters in the user prompt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({ bestDocumentId: "doc-1", confidence: 0.9, reason: "Passt." }));
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await arbiter.rank({ transaction: tx(), candidates: [doc()] });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toMatch(/^<<<INPUT-[0-9a-f]+ START>>>/);
    expect(userMessage).toMatch(/<<<INPUT-[0-9a-f]+ END>>>$/);
    expect(userMessage).toContain("doc-1");
    expect(userMessage).toContain("RE-2026-00001");
  });

  it("parses a valid ranking result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({ bestDocumentId: "doc-1", confidence: 0.85, reason: "Betrag und Rechnungsnummer passen." }));
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await arbiter.rank({ transaction: tx(), candidates: [doc()] });

    expect(result).toEqual({ bestDocumentId: "doc-1", confidence: 0.85, reason: "Betrag und Rechnungsnummer passen." });
  });

  it("degrades to a no-suggestion answer when the model's content is not valid JSON at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("not json at all"));
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await arbiter.rank({ transaction: tx(), candidates: [doc()] });
    expect(result.bestDocumentId).toBeNull();
  });

  it("degrades to a no-suggestion answer when a field has the wrong type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({ bestDocumentId: 12345, confidence: "high", reason: null }));
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await arbiter.rank({ transaction: tx(), candidates: [doc()] });
    expect(result).toEqual({ bestDocumentId: null, confidence: 0, reason: "" });
  });

  it("propagates a classified error from the underlying fetch (e.g. rate limiting)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await expect(arbiter.rank({ transaction: tx(), candidates: [doc()] })).rejects.toMatchObject({ code: "ai_rate_limited", transient: true });
  });

  it("returns a no-suggestion answer without calling fetch when there are no candidates", async () => {
    const fetchImpl = vi.fn();
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await arbiter.rank({ transaction: tx(), candidates: [] });
    expect(result.bestDocumentId).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when called with more than the max number of candidates", async () => {
    const fetchImpl = vi.fn();
    const arbiter = createMistralPaymentArbiter({ apiKey: "k", model: "mistral-small-latest", fetchImpl });
    const candidates = Array.from({ length: 21 }, (_, i) => doc({ id: `doc-${i}` }));

    await expect(arbiter.rank({ transaction: tx(), candidates })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
