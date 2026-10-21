// Unit test for the session access step (WEBAPP_TEMPLATE_SPEC.md §10.2: no DB, no
// network). `@/platform/auth/server` is mocked by its public entrypoint, the same
// pattern `src/modules/workspaces/tests/actions.test.ts` uses for `requireUser`.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: vi.fn(),
}));

import { getCurrentUser } from "@/platform/auth/server";
import { requireSessionAccess, SessionAccessError } from "@/platform/api-pipeline/server/require-session-access";

describe("requireSessionAccess", () => {
  it("returns the current user when a session exists", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1", email: "a@example.test" });

    await expect(requireSessionAccess()).resolves.toEqual({ id: "u1", email: "a@example.test" });
  });

  it("throws SessionAccessError when there is no session", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    await expect(requireSessionAccess()).rejects.toBeInstanceOf(SessionAccessError);
  });
});
