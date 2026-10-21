// Unit tests for createSystemUseCases (WEBAPP_TEMPLATE_SPEC.md §10.2): a typed fake
// repository, no DB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSystemUseCases } from "@/persistence/use-cases/system-use-cases";

describe("createSystemUseCases", () => {
  it("reports ok: true when the repository ping succeeds", async () => {
    const useCases = createSystemUseCases({ repos: { system: { ping: vi.fn().mockResolvedValue(undefined) } } });

    await expect(useCases.health()).resolves.toEqual({ ok: true });
  });

  describe("when the repository ping fails", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reports ok: false instead of throwing", async () => {
      const useCases = createSystemUseCases({ repos: { system: { ping: vi.fn().mockRejectedValue(new Error("down")) } } });

      await expect(useCases.health()).resolves.toEqual({ ok: false });
    });
  });
});
