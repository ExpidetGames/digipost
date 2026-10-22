// Pure logic, no DB, no mocks (WEBAPP_TEMPLATE_SPEC.md §10.2).
import { describe, expect, it } from "vitest";

import { PERMISSIONS, permissionsForRole, roleHasPermission } from "@/platform/access";

describe("permissionsForRole", () => {
  it("grants admin every permission", () => {
    const admin = permissionsForRole("admin");
    for (const permission of Object.values(PERMISSIONS)) {
      expect(admin).toContain(permission);
    }
  });

  it("grants member only the document permissions", () => {
    expect(permissionsForRole("member")).toEqual([PERMISSIONS.documentsRead, PERMISSIONS.documentsWrite]);
  });
});

describe("roleHasPermission", () => {
  it("returns true for a permission the role's bundle grants", () => {
    expect(roleHasPermission("admin", PERMISSIONS.membersManage)).toBe(true);
    expect(roleHasPermission("member", PERMISSIONS.documentsRead)).toBe(true);
  });

  it("returns false for a permission outside the role's bundle", () => {
    expect(roleHasPermission("member", PERMISSIONS.membersManage)).toBe(false);
    expect(roleHasPermission("member", PERMISSIONS.billingManage)).toBe(false);
    expect(roleHasPermission("member", PERMISSIONS.companyProfileManage)).toBe(false);
    // decisions/0075-email-intake.md: a member sees the address but never changes who may send to it.
    expect(roleHasPermission("member", PERMISSIONS.mailIntakeManage)).toBe(false);
    expect(roleHasPermission("admin", PERMISSIONS.mailIntakeManage)).toBe(true);
  });
});
