import { describe, expect, it, vi } from "vitest";

import { sampleTabular } from "@/modules/intake";

import { createMistralIntakeClassifier } from "../server/mistral-intake-classifier";

function chatResponse(content: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }),
    { status },
  );
}

describe("createMistralIntakeClassifier", () => {
  it("sends temperature 0 and response_format json_object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({ documentKind: "letter", confidence: 0.5, reason: "x", platform: null, columnMapping: null, amountSign: null }));
    const classifier = createMistralIntakeClassifier({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await classifier.classify({ kind: "text", text: "Sehr geehrte Damen und Herren" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("mistral-small-latest");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[1].content).toMatch(/^<<<INPUT-[0-9a-f]+ START>>>/);
    expect(body.messages[1].content).toContain("Sehr geehrte Damen und Herren");
  });

  it("includes the tabular sample's header and rows in the user prompt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({ documentKind: "bank_statement", confidence: 0.8, reason: "x", platform: null, columnMapping: null, amountSign: null }));
    const classifier = createMistralIntakeClassifier({ apiKey: "k", model: "mistral-small-latest", fetchImpl });
    const sample = sampleTabular("Datum,Betrag\n01.01.2026,10,00\n");

    await classifier.classify({ kind: "tabular", sample });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[1].content).toContain("Datum");
    expect(body.messages[1].content).toContain("Betrag");
  });

  it("parses a valid classification and drops a hallucinated column name", async () => {
    const sample = sampleTabular("Buchungsdatum,Betrag\n01.01.2026,10.00\n");
    const fetchImpl = vi.fn().mockResolvedValue(
      chatResponse({
        documentKind: "bank_statement",
        confidence: 0.9,
        reason: "Kontoauszug erkannt.",
        platform: null,
        columnMapping: { bookingDate: "Buchungsdatum", reference: "Erfundene Spalte" },
        amountSign: null,
      }),
    );
    const classifier = createMistralIntakeClassifier({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await classifier.classify({ kind: "tabular", sample });

    expect(result.documentKind).toBe("bank_statement");
    expect(result.columnMapping).toEqual({ bookingDate: "Buchungsdatum" });
  });

  it("degrades to 'other' when the model's content is not valid JSON at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("not json at all"));
    const classifier = createMistralIntakeClassifier({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    const result = await classifier.classify({ kind: "text", text: "text" });
    expect(result).toEqual({
      documentKind: "other",
      confidence: 0,
      reason: "Die Antwort des Modells konnte nicht ausgewertet werden.",
      platform: null,
      columnMapping: null,
      amountSign: null,
    });
  });

  it("propagates a classified error from the underlying fetch (e.g. rate limiting)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const classifier = createMistralIntakeClassifier({ apiKey: "k", model: "mistral-small-latest", fetchImpl });

    await expect(classifier.classify({ kind: "text", text: "text" })).rejects.toMatchObject({ code: "ai_rate_limited", transient: true });
  });
});
