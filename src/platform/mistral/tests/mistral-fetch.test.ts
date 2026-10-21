import { describe, expect, it, vi } from "vitest";

import { MistralRequestError } from "@/platform/mistral";

import { mistralFetch } from "../server/mistral-fetch";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("mistralFetch", () => {
  it("sends a POST with the bearer token and JSON body to the given path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

    await mistralFetch("/v1/ocr", { model: "mistral-ocr-latest" }, { apiKey: "secret-key", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/ocr");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(init.body as string)).toEqual({ model: "mistral-ocr-latest" });
  });

  it("returns the parsed JSON body on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ pages: [] }));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).resolves.toEqual({ pages: [] });
  });

  it("classifies 401 as a permanent ai_auth_failed error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "bad", fetchImpl })).rejects.toMatchObject({
      code: "ai_auth_failed",
      transient: false,
    });
  });

  it("classifies 403 as a permanent ai_auth_failed error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).rejects.toMatchObject({
      code: "ai_auth_failed",
      transient: false,
    });
  });

  it("classifies 429 as a transient ai_rate_limited error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).rejects.toMatchObject({
      code: "ai_rate_limited",
      transient: true,
    });
  });

  it("classifies a 5xx response as a transient ai_unavailable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 502));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).rejects.toMatchObject({
      code: "ai_unavailable",
      transient: true,
    });
  });

  it("classifies a timeout as a transient ai_timeout error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).rejects.toMatchObject({
      code: "ai_timeout",
      transient: true,
    });
  });

  it("classifies a network failure as transient ai_unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).rejects.toMatchObject({
      code: "ai_unavailable",
      transient: true,
    });
  });

  it("classifies a non-JSON success body as ai_invalid_response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).rejects.toMatchObject({
      code: "ai_invalid_response",
      transient: false,
    });
  });

  it("thrown errors are MistralRequestError instances", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    await expect(mistralFetch("/v1/ocr", {}, { apiKey: "k", fetchImpl })).rejects.toBeInstanceOf(MistralRequestError);
  });
});
