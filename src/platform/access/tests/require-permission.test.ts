// Unit test (WEBAPP_TEMPLATE_SPEC.md §10.2: no DB, no network).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: vi.fn(),
}));

const listMembershipsForUser = vi.fn();
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ workspaces: { listMembershipsForUser } }),
}));

// decisions/0070-several-workspaces-per-user.md: `resolveAccess` reads the active-workspace
// cookie. These cases never set one, so every resolution below takes the fallback path.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { getCurrentUser } from "@/platform/auth/server";
import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server/require-permission";

const ADMIN = { id: "admin1", email: "admin@example.test" };
const MEMBER = { id: "member1", email: "member@example.test" };

describe("requirePermission", () => {
  it("returns unauthenticated without ever checking membership", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    await expect(requirePermission(PERMISSIONS.membersManage)).resolves.toEqual({
      status: "error",
      errorCode: "unauthenticated",
    });
    expect(listMembershipsForUser).not.toHaveBeenCalled();
  });

  it("returns no_workspace for a signed-in user without a membership", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    listMembershipsForUser.mockResolvedValue([]);

    await expect(requirePermission(PERMISSIONS.membersManage)).resolves.toEqual({
      status: "error",
      errorCode: "no_workspace",
    });
  });

  it("returns forbidden when the role's bundle lacks the permission", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(MEMBER);
    listMembershipsForUser.mockResolvedValue([{
      membershipId: "m2",
      role: "member",
      workspace: { id: "w1", name: "Muster GmbH", tier: "free", createdAt: new Date(0) },
    }]);

    await expect(requirePermission(PERMISSIONS.membersManage)).resolves.toEqual({
      status: "error",
      errorCode: "forbidden",
    });
  });

  it("returns ok when the role's bundle grants the permission", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ADMIN);
    listMembershipsForUser.mockResolvedValue([{
      membershipId: "m1",
      role: "admin",
      workspace: { id: "w1", name: "Muster GmbH", tier: "free", createdAt: new Date(0) },
    }]);

    const result = await requirePermission(PERMISSIONS.membersManage);

    expect(result.status).toBe("ok");
  });
});
