import { describe, expect, it, vi } from "vitest";

import { createMistralDocumentAnalyzer } from "../server/mistral-analyzer";

function chatResponse(content: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }),
    { status },
  );
}

describe("createMistralDocumentAnalyzer", () => {
  it("sends temperature 0 and response_format json_object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({}));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await analyzer.analyze({ text: "Rechnung ueber 50 EUR", fileName: "brief.pdf", ownCompany: null });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("mistral-small-latest");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("Rechnung ueber 50 EUR");
  });

  it("delimits the untrusted document text with clear, per-request random-nonce markers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({}));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await analyzer.analyze({ text: "irrelevant", fileName: "brief.pdf", ownCompany: null });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[1].content).toMatch(/^<<<DOCUMENT_TEXT-[0-9a-f]+ START>>>/);
    expect(body.messages[1].content).toMatch(/<<<DOCUMENT_TEXT-[0-9a-f]+ END>>>$/);
  });

  it("parses a valid analysis JSON payload and validates it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      chatResponse({ title: "Rechnung Telekom", sender: "Telekom Deutschland GmbH", documentDate: "2026-03-15", summary: "Eine Rechnung." }),
    );
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await analyzer.analyze({ text: "text", fileName: "rechnung-telekom.pdf", ownCompany: null });

    expect(result).toEqual({
      title: "Rechnung Telekom",
      sender: "Telekom Deutschland GmbH",
      documentDate: "2026-03-15",
      summary: "Eine Rechnung.",
      parties: [],
      invoice: null,
    });
  });

  it("degrades gracefully when the model's content is not valid JSON at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("not json at all"));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await analyzer.analyze({ text: "text", fileName: "brief.pdf", ownCompany: null });
    expect(result).toEqual({ title: null, sender: null, documentDate: null, summary: null, parties: [], invoice: null });
  });

  it("propagates a classified error from the underlying fetch (e.g. rate limiting)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await expect(analyzer.analyze({ text: "text", fileName: "brief.pdf", ownCompany: null })).rejects.toMatchObject({
      code: "ai_rate_limited",
      transient: true,
    });
  });
});

// Wave 1 of decisions/0036-guided-extraction.md (H-contract.md section 2), NOT yet called by
// `processDocument` - same request/parse machinery as `analyze` above, only the system prompt
// and validator differ per `CounterpartyPlan` mode.
describe("createMistralDocumentAnalyzer.analyzeGuided", () => {
  const derivedPlan = { mode: "derived", ourRole: "sender", counterpartyRole: "recipient", relationType: "customer" } as const;
  const openPlan = { mode: "open" } as const;

  it("sends temperature 0 and response_format json_object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({}));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await analyzer.analyzeGuided({ text: "Rechnung ueber 50 EUR", fileName: "brief.pdf", ownCompany: null, kind: "outgoing_invoice", plan: derivedPlan });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("mistral-small-latest");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("uses the derived system prompt (stating the role as a fact) for a derived-mode plan", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({}));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await analyzer.analyzeGuided({ text: "text", fileName: "brief.pdf", ownCompany: null, kind: "outgoing_invoice", plan: derivedPlan });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toContain("Dies ist eine Ausgangsrechnung des Unternehmens des Nutzers.");
    expect(body.messages[0].content).toContain('"counterparty":');
  });

  it("uses the open system prompt (at most 2 business partners) for an open-mode plan", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({}));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await analyzer.analyzeGuided({ text: "text", fileName: "brief.pdf", ownCompany: null, kind: "letter", plan: openPlan });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toContain("höchstens 2");
    expect(body.messages[0].content).not.toContain("alle auf dem Dokument genannten");
  });

  it("parses a well-formed derived-mode answer into a counterparty with no role field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      chatResponse({
        title: "Rechnung Muster Kunde",
        sender: "Muster Werkstatt GmbH",
        documentDate: "2026-03-15",
        summary: "Eine Rechnung.",
        counterparty: { name: "Muster Kunde GmbH", vatId: "DE999888777" },
        invoice: { totalAmount: "50,00 EUR" },
      }),
    );
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await analyzer.analyzeGuided({ text: "text", fileName: "brief.pdf", ownCompany: null, kind: "outgoing_invoice", plan: derivedPlan });

    expect(result.counterparty).toEqual(expect.objectContaining({ name: "Muster Kunde GmbH", vatId: "DE999888777" }));
    expect(result.counterparty).not.toHaveProperty("role");
    expect(result.parties).toEqual([]);
    expect(result.invoice).toEqual(expect.objectContaining({ totalAmountCents: 5000 }));
  });

  it("degrades gracefully when optional fields are missing from an otherwise well-formed answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({}));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await analyzer.analyzeGuided({ text: "text", fileName: "brief.pdf", ownCompany: null, kind: "outgoing_invoice", plan: derivedPlan });

    expect(result).toEqual({
      title: null,
      sender: null,
      documentDate: null,
      summary: null,
      counterparty: null,
      parties: [],
      invoice: null,
      reminderDirection: null,
    });
  });

  it("degrades gracefully when the model's content is not valid JSON at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("not json at all"));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await analyzer.analyzeGuided({ text: "text", fileName: "brief.pdf", ownCompany: null, kind: "letter", plan: openPlan });
    expect(result.counterparty).toBeNull();
    expect(result.parties).toEqual([]);
  });

  it("truncates an open-mode answer with 3 parties to MAX_GUIDED_PARTIES (2)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      chatResponse({
        parties: [
          { role: "sender", name: "Firma A" },
          { role: "mentioned", name: "Firma B" },
          { role: "mentioned", name: "Firma C" },
        ],
      }),
    );
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await analyzer.analyzeGuided({ text: "text", fileName: "brief.pdf", ownCompany: null, kind: "letter", plan: openPlan });
    expect(result.parties).toHaveLength(2);
    expect(result.parties.map((p) => p.name)).toEqual(["Firma A", "Firma B"]);
  });

  it("propagates a classified error from the underlying fetch (e.g. rate limiting)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const analyzer = createMistralDocumentAnalyzer({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await expect(
      analyzer.analyzeGuided({ text: "text", fileName: "brief.pdf", ownCompany: null, kind: "letter", plan: openPlan }),
    ).rejects.toMatchObject({ code: "ai_rate_limited", transient: true });
  });
});
