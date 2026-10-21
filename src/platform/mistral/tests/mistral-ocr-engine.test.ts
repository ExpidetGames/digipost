import { describe, expect, it, vi } from "vitest";

import { createMistralOcrEngine } from "../server/mistral-ocr-engine";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("createMistralOcrEngine", () => {
  it("sends the PDF as a base64 data URL with include_blocks true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pages: [] }));
    const engine = createMistralOcrEngine({ apiKey: "k", model: "mistral-ocr-latest", fetchImpl });

    await engine.recognize({ pdfBytes: new Uint8Array([37, 80, 68, 70]), fileName: "brief.pdf" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/ocr");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("mistral-ocr-latest");
    expect(body.include_blocks).toBe(true);
    expect(body.document.type).toBe("document_url");
    expect(body.document.document_url).toMatch(/^data:application\/pdf;base64,/);
  });

  it("maps a response with blocks present into camelCase OcrResult", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        pages: [
          {
            index: 0,
            markdown: "Hallo Welt",
            dimensions: { dpi: 200, width: 1000, height: 1400 },
            blocks: [
              { type: "text", top_left_x: 10, top_left_y: 20, bottom_right_x: 500, bottom_right_y: 60, content: "Hallo Welt" },
            ],
          },
        ],
        model: "mistral-ocr-latest",
      }),
    );
    const engine = createMistralOcrEngine({ apiKey: "k", model: "mistral-ocr-latest", fetchImpl });

    const result = await engine.recognize({ pdfBytes: new Uint8Array([1]), fileName: "brief.pdf" });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toEqual({
      index: 0,
      markdown: "Hallo Welt",
      dimensions: { width: 1000, height: 1400, dpi: 200 },
      blocks: [{ type: "text", topLeftX: 10, topLeftY: 20, bottomRightX: 500, bottomRightY: 60, content: "Hallo Welt" }],
    });
  });

  it("falls back to null blocks/dimensions when the response omits them (blocks: null)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ pages: [{ index: 0, markdown: "Nur Text", dimensions: null, blocks: null }] }),
    );
    const engine = createMistralOcrEngine({ apiKey: "k", model: "mistral-ocr-latest", fetchImpl });

    const result = await engine.recognize({ pdfBytes: new Uint8Array([1]), fileName: "brief.pdf" });

    expect(result.pages[0]?.blocks).toBeNull();
    expect(result.pages[0]?.dimensions).toBeNull();
    expect(result.pages[0]?.markdown).toBe("Nur Text");
  });

  it("falls back gracefully when the response omits dimensions/blocks entirely (missing keys)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pages: [{ index: 0, markdown: "Text" }] }));
    const engine = createMistralOcrEngine({ apiKey: "k", model: "mistral-ocr-latest", fetchImpl });

    const result = await engine.recognize({ pdfBytes: new Uint8Array([1]), fileName: "brief.pdf" });

    expect(result.pages[0]?.blocks).toBeNull();
    expect(result.pages[0]?.dimensions).toBeNull();
  });

  it("throws ai_invalid_response for a response that does not match the lenient schema at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pages: "not-an-array" }));
    const engine = createMistralOcrEngine({ apiKey: "k", model: "mistral-ocr-latest", fetchImpl });

    await expect(engine.recognize({ pdfBytes: new Uint8Array([1]), fileName: "brief.pdf" })).rejects.toMatchObject({
      code: "ai_invalid_response",
    });
  });

  it("propagates auth failures from the underlying fetch classification", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const engine = createMistralOcrEngine({ apiKey: "bad", model: "mistral-ocr-latest", fetchImpl });

    await expect(engine.recognize({ pdfBytes: new Uint8Array([1]), fileName: "brief.pdf" })).rejects.toMatchObject({
      code: "ai_auth_failed",
      transient: false,
    });
  });
});
