// Unit tests for the Server Actions (WEBAPP_TEMPLATE_SPEC.md §10.2: `vi.mock` on the exact
// module paths `actions.ts` imports, no DB, no network). Mirrors
// `src/modules/projects/tests/actions.test.ts`'s former pattern for the `projects` example
// module.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/server", () => ({
  requireUser: vi.fn(),
}));

const setActiveWorkspaceCookie = vi.fn();
const clearActiveWorkspaceCookie = vi.fn();
vi.mock("@/platform/access/server", () => ({
  requirePermission: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  setActiveWorkspaceCookie: (id: string) => setActiveWorkspaceCookie(id),
  clearActiveWorkspaceCookie: () => clearActiveWorkspaceCookie(),
}));

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

const objectStorageListObjects = vi.fn();
const objectStorageDeleteObjects = vi.fn();
vi.mock("@/platform/object-storage/server", () => ({
  getObjectStorage: () => ({ listObjects: objectStorageListObjects, deleteObjects: objectStorageDeleteObjects }),
}));

// Only `createSmtpMailer` is mocked (to capture the sent message); `renderEmail` runs for
// real, so the assertion below on the rendered HTML actually proves the invite link made
// it into the mail, not just that some mock output was returned.
const sendMail = vi.fn();
vi.mock("@/platform/mailer/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/mailer/server")>();
  return { ...actual, createSmtpMailer: () => ({ send: sendMail }) };
});

vi.mock("@/platform/env/server", () => ({
  serverEnv: () => ({ APP_URL: "https://app.example.test" }),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

const workspacesUseCases = {
  createForUser: vi.fn(),
  invite: vi.fn(),
  revokeInvitation: vi.fn(),
  removeMember: vi.fn(),
  acceptInvitation: vi.fn(),
  updateCompanyProfile: vi.fn(),
  leaveWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  listMembershipsForUser: vi.fn(),
  getMembershipInWorkspace: vi.fn(),
};
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ workspaces: workspacesUseCases }),
}));

import { requireUser } from "@/platform/auth/server";
import { getWorkspaceAccess, requirePermission } from "@/platform/access/server";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { WORKSPACE_ERROR } from "@/persistence/use-cases/workspaces-use-cases";

import {
  acceptInvitationAction,
  createWorkspaceAction,
  deleteWorkspaceAction,
  inviteMemberAction,
  leaveWorkspaceAction,
  removeMemberAction,
  revokeInvitationAction,
  switchWorkspaceAction,
  updateCompanyProfileAction,
} from "../actions";

// C2 (decisions/0021-extraction-direction-and-invoice-fields.md): every `createWorkspaceAction`
// call needs the same required address fields `createWorkspaceInputSchema` now enforces.
const VALID_ADDRESS = { addressLine1: "Musterstraße 1", postalCode: "10115", city: "Berlin" };

const USER = { id: "u1", email: "admin@example.test" };
const ACCESS = {
  status: "ok" as const,
  access: {
    user: USER,
    membershipId: "m1",
    role: "admin" as const,
    workspace: { id: "w1", name: "Muster GmbH", tier: "free" },
    permissions: ["members.manage"] as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // decisions/0070-several-workspaces-per-user.md: the default for the leave/delete landing
  // logic is "this was my only workspace", the pre-phase behavior every existing case below
  // asserts.
  workspacesUseCases.listMembershipsForUser.mockResolvedValue([]);
});

describe("createWorkspaceAction", () => {
  it("requires a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.createForUser.mockResolvedValue({ workspace: { id: "w1", name: "Muster GmbH" }, role: "admin" });

    await createWorkspaceAction({ name: "Muster GmbH", ...VALID_ADDRESS });

    expect(requireUser).toHaveBeenCalled();
  });

  it("rejects invalid input without calling the use case", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);

    const result = await createWorkspaceAction({ name: "" });

    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(workspacesUseCases.createForUser).not.toHaveBeenCalled();
  });

  it("returns success, stores the company profile, and revalidates on success", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.createForUser.mockResolvedValue({ workspace: { id: "w1", name: "Muster GmbH" }, role: "admin" });
    workspacesUseCases.updateCompanyProfile.mockResolvedValue({});

    const result = await createWorkspaceAction({ name: "Muster GmbH", ...VALID_ADDRESS, vatId: "DE123456789" });

    expect(result).toEqual({ status: "success", data: { id: "w1", name: "Muster GmbH" } });
    // decisions/0070-several-workspaces-per-user.md: the workspace just created becomes the
    // active one, whether it is the caller's first or their third.
    expect(setActiveWorkspaceCookie).toHaveBeenCalledWith("w1");
    expect(workspacesUseCases.updateCompanyProfile).toHaveBeenCalledWith({
      workspaceId: "w1",
      addressLine1: "Musterstraße 1",
      addressLine2: undefined,
      postalCode: "10115",
      city: "Berlin",
      country: undefined,
      vatId: "DE123456789",
      // decisions/0034-extended-company-profile.md: onboarding's only extended-profile field.
      aliases: [],
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePathMock).toHaveBeenCalledWith("/onboarding");
  });

  it("maps already_in_workspace from a thrown UseCaseError", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.createForUser.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.alreadyInWorkspace));

    const result = await createWorkspaceAction({ name: "Muster GmbH", ...VALID_ADDRESS });

    expect(result).toEqual({ status: "error", errorCode: "already_in_workspace" });
  });

  it("maps an unrecognized error to unknown", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.createForUser.mockRejectedValue(new Error("boom"));

    const result = await createWorkspaceAction({ name: "Muster GmbH", ...VALID_ADDRESS });

    expect(result).toEqual({ status: "error", errorCode: "unknown" });
  });
});

describe("updateCompanyProfileAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await updateCompanyProfileAction({});

    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("forwards a forbidden result from requirePermission", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });

    const result = await updateCompanyProfileAction(VALID_ADDRESS);

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(workspacesUseCases.updateCompanyProfile).not.toHaveBeenCalled();
  });

  it("updates the profile and revalidates on success", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.updateCompanyProfile.mockResolvedValue({});

    const result = await updateCompanyProfileAction(VALID_ADDRESS);

    expect(result).toEqual({ status: "success", data: undefined });
    expect(workspacesUseCases.updateCompanyProfile).toHaveBeenCalledWith({
      workspaceId: "w1",
      addressLine1: "Musterstraße 1",
      addressLine2: undefined,
      postalCode: "10115",
      city: "Berlin",
      country: undefined,
      vatId: undefined,
      // decisions/0034-extended-company-profile.md: the settings form's full extended profile.
      aliases: [],
      ibans: [],
      domains: [],
      taxNumber: undefined,
      registerCourt: undefined,
      registerNumber: undefined,
      profileText: undefined,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/settings/company");
  });

  it("maps a not_found UseCaseError from a concurrently deleted workspace", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.updateCompanyProfile.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.notFound));

    const result = await updateCompanyProfileAction(VALID_ADDRESS);

    expect(result).toEqual({ status: "error", errorCode: "not_found" });
  });

  // decisions/0034-extended-company-profile.md (H1): the three new stable error codes.
  it.each([
    ["alias_too_generic", WORKSPACE_ERROR.aliasTooGeneric],
    ["invalid_iban", WORKSPACE_ERROR.invalidIban],
    ["invalid_domain", WORKSPACE_ERROR.invalidDomain],
  ] as const)("maps %s from a thrown UseCaseError", async (expectedCode, useCaseCode) => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.updateCompanyProfile.mockRejectedValue(new UseCaseError(useCaseCode));

    const result = await updateCompanyProfileAction(VALID_ADDRESS);

    expect(result).toEqual({ status: "error", errorCode: expectedCode });
  });
});

describe("inviteMemberAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await inviteMemberAction({ email: "not-an-email" });

    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("forwards a forbidden result from requirePermission", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });

    const result = await inviteMemberAction({ email: "new@example.test" });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(workspacesUseCases.invite).not.toHaveBeenCalled();
  });

  it("invites, sends the invitation e-mail with the invite link, and revalidates", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    const expiresAt = new Date("2026-01-08T00:00:00.000Z");
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    workspacesUseCases.invite.mockResolvedValue({
      invitationId: "inv1",
      token: "plain-token",
      email: "new@example.test",
      expiresAt,
      createdAt,
    });

    const result = await inviteMemberAction({ email: "new@example.test" });

    expect(result).toEqual({
      status: "success",
      data: { id: "inv1", email: "new@example.test", expiresAt: expiresAt.toISOString(), createdAt: createdAt.toISOString() },
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "new@example.test", subject: expect.stringContaining("Digipost") }),
    );
    const sentMessage = sendMail.mock.calls[0]?.[0];
    expect(sentMessage.html).toContain("https://app.example.test/invite/plain-token");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/team");
  });

  it("still returns success when sending the invitation e-mail fails", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.invite.mockResolvedValue({
      invitationId: "inv1",
      token: "plain-token",
      email: "new@example.test",
      expiresAt: new Date(),
      createdAt: new Date(),
    });
    sendMail.mockRejectedValueOnce(new Error("smtp down"));

    const result = await inviteMemberAction({ email: "new@example.test" });

    expect(result.status).toBe("success");
  });

  it("maps invitation_cap_reached from a thrown UseCaseError", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.invite.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.invitationCapReached));

    const result = await inviteMemberAction({ email: "new@example.test" });

    expect(result).toEqual({ status: "error", errorCode: "invitation_cap_reached" });
  });
});

describe("revokeInvitationAction", () => {
  it("requires members.manage and revokes", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.revokeInvitation.mockResolvedValue(undefined);

    const result = await revokeInvitationAction({ invitationId: crypto.randomUUID() });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/team");
  });

  it("maps not_found", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.revokeInvitation.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.notFound));

    const result = await revokeInvitationAction({ invitationId: crypto.randomUUID() });

    expect(result).toEqual({ status: "error", errorCode: "not_found" });
  });
});

describe("removeMemberAction", () => {
  it("requires members.manage and removes", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.removeMember.mockResolvedValue(undefined);
    revalidatePathMock.mockClear();

    const result = await removeMemberAction({ memberId: crypto.randomUUID() });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(workspacesUseCases.removeMember).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", actorMembershipId: "m1" }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/team");
  });

  it("maps cannot_remove_self", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.removeMember.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.cannotRemoveSelf));

    const result = await removeMemberAction({ memberId: crypto.randomUUID() });

    expect(result).toEqual({ status: "error", errorCode: "cannot_remove_self" });
  });
});

describe("acceptInvitationAction", () => {
  it("requires a session and accepts", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.acceptInvitation.mockResolvedValue({ workspaceId: "w1" });

    const result = await acceptInvitationAction({ token: "a".repeat(64) });

    expect(result).toEqual({ status: "success", data: { workspaceId: "w1" } });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
    // decisions/0070-several-workspaces-per-user.md: the workspace just joined becomes the
    // active one, so the invitee lands in it rather than back in their previous workspace.
    expect(setActiveWorkspaceCookie).toHaveBeenCalledWith("w1");
  });

  it("maps invitation_email_mismatch", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.acceptInvitation.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.invitationEmailMismatch));

    const result = await acceptInvitationAction({ token: "a".repeat(64) });

    expect(result).toEqual({ status: "error", errorCode: "invitation_email_mismatch" });
  });
});

describe("leaveWorkspaceAction (F5, decisions/0027-hardening-and-deletion.md)", () => {
  it("forwards a no_workspace result from getWorkspaceAccess, never calling the use case", async () => {
    vi.mocked(getWorkspaceAccess).mockResolvedValue({ status: "error", errorCode: "no_workspace" });

    const result = await leaveWorkspaceAction();

    expect(result).toEqual({ status: "error", errorCode: "no_workspace" });
    expect(workspacesUseCases.leaveWorkspace).not.toHaveBeenCalled();
  });

  it("leaves the workspace with the caller's own workspace/membership id and redirects to onboarding", async () => {
    vi.mocked(getWorkspaceAccess).mockResolvedValue(ACCESS);
    workspacesUseCases.leaveWorkspace.mockResolvedValue(undefined);

    await expect(leaveWorkspaceAction()).rejects.toThrow("REDIRECT:/onboarding");

    expect(workspacesUseCases.leaveWorkspace).toHaveBeenCalledWith({ workspaceId: "w1", membershipId: "m1" });
    expect(clearActiveWorkspaceCookie).toHaveBeenCalled();
    expect(setActiveWorkspaceCookie).not.toHaveBeenCalled();
  });

  // decisions/0070-several-workspaces-per-user.md
  it("lands on another of the caller's workspaces, made active, when one is left", async () => {
    vi.mocked(getWorkspaceAccess).mockResolvedValue(ACCESS);
    workspacesUseCases.leaveWorkspace.mockResolvedValue(undefined);
    workspacesUseCases.listMembershipsForUser.mockResolvedValue([
      { membershipId: "m9", role: "admin", workspace: { id: "w2", name: "Zweite GmbH", tier: "free" } },
    ]);

    await expect(leaveWorkspaceAction()).rejects.toThrow("REDIRECT:/dashboard");

    expect(setActiveWorkspaceCookie).toHaveBeenCalledWith("w2");
    expect(clearActiveWorkspaceCookie).not.toHaveBeenCalled();
  });

  it("maps cannot_leave_as_admin from a thrown UseCaseError, never redirecting", async () => {
    vi.mocked(getWorkspaceAccess).mockResolvedValue(ACCESS);
    workspacesUseCases.leaveWorkspace.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.cannotLeaveAsAdmin));

    const result = await leaveWorkspaceAction();

    expect(result).toEqual({ status: "error", errorCode: "cannot_leave_as_admin" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("deleteWorkspaceAction (F5, decisions/0027-hardening-and-deletion.md)", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await deleteWorkspaceAction({ confirmName: "" });

    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("requires workspace.manage", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });

    const result = await deleteWorkspaceAction({ confirmName: "Muster GmbH" });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(workspacesUseCases.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("maps confirmation_mismatch from a thrown UseCaseError, never attempting storage cleanup or redirecting", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.deleteWorkspace.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.confirmationMismatch));

    const result = await deleteWorkspaceAction({ confirmName: "Wrong Name" });

    expect(result).toEqual({ status: "error", errorCode: "confirmation_mismatch" });
    expect(objectStorageListObjects).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("deletes, cleans up storage immediately, and redirects to onboarding on success", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.deleteWorkspace.mockResolvedValue({ storagePrefix: "workspaces/w1/" });
    objectStorageListObjects.mockResolvedValue(["workspaces/w1/documents/d1/original.pdf"]);
    objectStorageDeleteObjects.mockResolvedValue({ failedKeys: [] });

    await expect(deleteWorkspaceAction({ confirmName: "Muster GmbH" })).rejects.toThrow("REDIRECT:/onboarding");

    expect(workspacesUseCases.deleteWorkspace).toHaveBeenCalledWith({ workspaceId: "w1", confirmName: "Muster GmbH" });
    expect(objectStorageListObjects).toHaveBeenCalledWith("workspaces/w1/");
    expect(objectStorageDeleteObjects).toHaveBeenCalledWith(["workspaces/w1/documents/d1/original.pdf"]);
    expect(clearActiveWorkspaceCookie).toHaveBeenCalled();
  });

  // decisions/0070-several-workspaces-per-user.md
  it("lands on another of the admin's workspaces, made active, when one is left", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.deleteWorkspace.mockResolvedValue({ storagePrefix: "workspaces/w1/" });
    objectStorageListObjects.mockResolvedValue([]);
    workspacesUseCases.listMembershipsForUser.mockResolvedValue([
      { membershipId: "m9", role: "admin", workspace: { id: "w2", name: "Zweite GmbH", tier: "free" } },
    ]);

    await expect(deleteWorkspaceAction({ confirmName: "Muster GmbH" })).rejects.toThrow("REDIRECT:/dashboard");

    expect(setActiveWorkspaceCookie).toHaveBeenCalledWith("w2");
  });

  it("still redirects to onboarding even when the immediate storage cleanup throws (the enqueued job is the durable fallback)", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.deleteWorkspace.mockResolvedValue({ storagePrefix: "workspaces/w1/" });
    objectStorageListObjects.mockRejectedValue(new Error("MinIO unreachable"));

    await expect(deleteWorkspaceAction({ confirmName: "Muster GmbH" })).rejects.toThrow("REDIRECT:/onboarding");
  });

  it("skips deleteObjects entirely when the prefix is already empty", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    workspacesUseCases.deleteWorkspace.mockResolvedValue({ storagePrefix: "workspaces/w1/" });
    objectStorageListObjects.mockResolvedValue([]);

    await expect(deleteWorkspaceAction({ confirmName: "Muster GmbH" })).rejects.toThrow("REDIRECT:/onboarding");

    expect(objectStorageDeleteObjects).not.toHaveBeenCalled();
  });
});

// decisions/0070-several-workspaces-per-user.md: the switcher's Server Action. The workspace
// id is client input, so the membership check happening BEFORE the cookie write is the point
// of every case here.
describe("switchWorkspaceAction", () => {
  const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

  it("rejects a malformed workspace id without touching the cookie", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);

    const result = await switchWorkspaceAction({ workspaceId: "not-a-uuid" });

    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(workspacesUseCases.getMembershipInWorkspace).not.toHaveBeenCalled();
    expect(setActiveWorkspaceCookie).not.toHaveBeenCalled();
  });

  it("never writes the cookie for a workspace the caller has no membership in", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.getMembershipInWorkspace.mockResolvedValue(null);

    const result = await switchWorkspaceAction({ workspaceId: OTHER_WORKSPACE_ID });

    expect(result).toEqual({ status: "error", errorCode: "not_found" });
    expect(setActiveWorkspaceCookie).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("writes the cookie and redirects once the membership is confirmed", async () => {
    vi.mocked(requireUser).mockResolvedValue(USER);
    workspacesUseCases.getMembershipInWorkspace.mockResolvedValue({
      membershipId: "m2",
      role: "member",
      workspace: { id: OTHER_WORKSPACE_ID, name: "Zweite GmbH", tier: "free" },
    });

    await expect(switchWorkspaceAction({ workspaceId: OTHER_WORKSPACE_ID })).rejects.toThrow("REDIRECT:/dashboard");

    expect(workspacesUseCases.getMembershipInWorkspace).toHaveBeenCalledWith({
      userId: USER.id,
      workspaceId: OTHER_WORKSPACE_ID,
    });
    // The id written is the one the DATABASE returned, never the raw input.
    expect(setActiveWorkspaceCookie).toHaveBeenCalledWith(OTHER_WORKSPACE_ID);
  });
});
