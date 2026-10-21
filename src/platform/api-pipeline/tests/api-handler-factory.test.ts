// Exercises `core/handler-factory.ts` by its owner-internal path rather than the
// public barrel (WEBAPP_TEMPLATE_SPEC.md §10.2: no DB, no network).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiHandler, createApiHandlerFromContract, defineApiEndpointContract } from "@/platform/api-pipeline/core/handler-factory";

describe("createApiHandler", () => {
  it("returns invalid request when parser returns null", async () => {
    const handler = createApiHandler({
      parse: { run: () => null },
      execute: { run: vi.fn() },
      respond: { run: vi.fn() },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ errorCode: "invalid_request" });
  });

  it("maps known execution errors", async () => {
    const handler = createApiHandler({
      parse: { run: () => ({ id: "abc" }) },
      execute: {
        run: () => {
          throw new Error("boom");
        },
        mapError: () => ({ errorCode: "known_error", status: 409 }),
      },
      respond: { run: vi.fn() },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ errorCode: "known_error" });
  });

  it("returns unknown error when no mapper matches", async () => {
    const handler = createApiHandler({
      parse: { run: () => ({ id: "abc" }) },
      execute: {
        run: () => {
          throw new Error("boom");
        },
      },
      respond: { run: vi.fn() },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ errorCode: "unknown" });
  });

  it("binds invalid and unknown errors from contract", async () => {
    const contract = defineApiEndpointContract<"invalid_request" | "unknown">({
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const handler = createApiHandlerFromContract(contract, {
      parse: { run: () => null },
      execute: { run: vi.fn() },
      respond: { run: vi.fn() },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ errorCode: "invalid_request" });
  });

  it("maps parse errors with parse mapper", async () => {
    const handler = createApiHandler({
      parse: {
        run: () => {
          throw new Error("bad parse");
        },
        mapError: () => ({ errorCode: "known_parse_error", status: 422 }),
      },
      execute: { run: vi.fn() },
      respond: { run: vi.fn() },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ errorCode: "known_parse_error" });
  });

  it("maps access errors with access mapper", async () => {
    const handler = createApiHandler({
      access: {
        run: () => {
          throw new Error("no access");
        },
        mapError: () => ({ errorCode: "auth_required", status: 401 }),
      },
      parse: { run: () => ({ id: "abc" }) },
      execute: { run: vi.fn() },
      respond: { run: vi.fn() },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ errorCode: "auth_required" });
  });

  it("maps respond errors with respond mapper", async () => {
    const handler = createApiHandler({
      parse: { run: () => ({ id: "abc" }) },
      execute: { run: () => ({ ok: true }) },
      respond: {
        run: () => {
          throw new Error("response failed");
        },
        mapError: () => ({ errorCode: "response_failed", status: 502 }),
      },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ errorCode: "response_failed" });
  });

  it("falls back to unknown when mapper throws", async () => {
    const handler = createApiHandler({
      parse: {
        run: () => {
          throw new Error("boom");
        },
        mapError: () => {
          throw new Error("mapper broke");
        },
      },
      execute: { run: vi.fn() },
      respond: { run: vi.fn() },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ errorCode: "unknown" });
  });

  it("uses a custom body and headers when the error response sets them", async () => {
    const handler = createApiHandler({
      parse: { run: () => null },
      execute: { run: vi.fn() },
      respond: { run: vi.fn() },
      invalidRequestError: {
        errorCode: "invalid_request",
        status: 400,
        body: { error: "BAD_REQUEST" },
        headers: { "cache-control": "no-store" },
      },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const response = await handler(new Request("http://localhost:3000"), undefined);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "BAD_REQUEST" });
  });

  it("sets a unique x-request-id header on every error response", async () => {
    const handler = createApiHandler({
      parse: { run: () => null },
      execute: { run: vi.fn() },
      respond: { run: vi.fn() },
      invalidRequestError: { errorCode: "invalid_request", status: 400 },
      unknownError: { errorCode: "unknown", status: 500 },
    });

    const first = await handler(new Request("http://localhost:3000"), undefined);
    const second = await handler(new Request("http://localhost:3000"), undefined);

    const firstId = first.headers.get("x-request-id");
    const secondId = second.headers.get("x-request-id");
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
  });

  describe("server-side logging of unhandled errors", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("logs the raw error, tagged with the request id, when no mapper matches", async () => {
      const raw = new Error("boom, and nothing catches it");
      const handler = createApiHandler({
        parse: { run: () => ({ id: "abc" }) },
        execute: {
          run: () => {
            throw raw;
          },
        },
        respond: { run: vi.fn() },
        invalidRequestError: { errorCode: "invalid_request", status: 400 },
        unknownError: { errorCode: "unknown", status: 500 },
      });

      const response = await handler(new Request("http://localhost:3000"), undefined);
      const requestId = response.headers.get("x-request-id");

      expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(String(requestId)), raw);
    });

    it("does not log anything when a mapper claims the error", async () => {
      const handler = createApiHandler({
        parse: { run: () => ({ id: "abc" }) },
        execute: {
          run: () => {
            throw new Error("boom");
          },
          mapError: () => ({ errorCode: "known_error", status: 409 }),
        },
        respond: { run: vi.fn() },
        invalidRequestError: { errorCode: "invalid_request", status: 400 },
        unknownError: { errorCode: "unknown", status: 500 },
      });

      await handler(new Request("http://localhost:3000"), undefined);

      expect(console.error).not.toHaveBeenCalled();
    });

    it("does not log a routine invalid-request result (parser returning null is not an unhandled error)", async () => {
      const handler = createApiHandler({
        parse: { run: () => null },
        execute: { run: vi.fn() },
        respond: { run: vi.fn() },
        invalidRequestError: { errorCode: "invalid_request", status: 400 },
        unknownError: { errorCode: "unknown", status: 500 },
      });

      await handler(new Request("http://localhost:3000"), undefined);

      expect(console.error).not.toHaveBeenCalled();
    });
  });
});
