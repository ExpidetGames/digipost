// Unit tests for createWorkspaceUseCases (WEBAPP_TEMPLATE_SPEC.md §10.2): typed fakes via
// dependency injection, no DB, no vi.mock. `withUnusedRepositories` completes the
// `Repositories` bundle so a use case that unexpectedly reaches into another owner area's
// repository fails loudly instead of reading `undefined`.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import { createFakeJobsRepository } from "@/persistence/tests/support/fake-jobs-repository";
import {
  createFakeWorkspaceInvitationRepository,
  createFakeWorkspaceMemberRepository,
  createFakeWorkspaceRepository,
  invitationRow,
  memberRow,
  workspaceRow,
} from "@/persistence/tests/support/fake-workspaces-repositories";
import type { UnitOfWork } from "@/persistence/repositories/contracts";
import {
  MAX_COMPANY_PROFILE_LIST_ENTRIES,
  MAX_PENDING_INVITATIONS,
  WORKSPACE_ERROR,
  createWorkspaceUseCases,
  isGenericCompanyAlias,
  isLikelyCompanyHost,
  normalizeCompanyAliases,
  normalizeCompanyDomain,
} from "@/persistence/use-cases/workspaces-use-cases";
import { JOB_KINDS } from "@/platform/jobs";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function setup(options: {
  workspaces?: Parameters<typeof createFakeWorkspaceRepository>[0];
  members?: Parameters<typeof createFakeWorkspaceMemberRepository>[0];
  users?: Parameters<typeof createFakeWorkspaceMemberRepository>[1];
  invitations?: Parameters<typeof createFakeWorkspaceInvitationRepository>[0];
  details?: Parameters<typeof createFakeWorkspaceInvitationRepository>[1];
  jobs?: Parameters<typeof createFakeJobsRepository>[0];
  now?: () => Date;
  generateToken?: () => string;
} = {}) {
  const { repo: workspace, state: workspaceState } = createFakeWorkspaceRepository(options.workspaces);
  // The member fake joins against the workspace fake's own live row array
  // (decisions/0070-several-workspaces-per-user.md: `listByUserIdWithWorkspace` is a join).
  const { repo: workspaceMember, state: memberState } = createFakeWorkspaceMemberRepository(
    options.members,
    options.users,
    workspaceState,
  );
  const { repo: workspaceInvitation, state: invitationState } = createFakeWorkspaceInvitationRepository(
    options.invitations,
    options.details,
  );
  const { repo: jobs, state: jobState } = createFakeJobsRepository(options.jobs);
  const repos = withUnusedRepositories({ workspace, workspaceMember, workspaceInvitation, jobs });
  const uow: UnitOfWork = { transaction: (work) => work(repos) };
  const useCases = createWorkspaceUseCases({
    repos,
    uow,
    now: options.now ?? (() => FIXED_NOW),
    generateToken: options.generateToken,
  });
  return { useCases, workspaceState, memberState, invitationState, jobState, repos };
}

// decisions/0034-extended-company-profile.md (H1): the pure alias/domain normalizers, tested
// directly (not only through `updateCompanyProfile`'s own behavioral tests below).
describe("normalizeCompanyDomain", () => {
  it("strips a scheme, www., path, query, and port, then lowercases", () => {
    expect(normalizeCompanyDomain("https://www.Musterfirma.de/impressum")).toBe("musterfirma.de");
    expect(normalizeCompanyDomain("MUSTERFIRMA.de:443")).toBe("musterfirma.de");
    expect(normalizeCompanyDomain("http://musterfirma.de?x=1#y")).toBe("musterfirma.de");
  });

  it("passes a bare domain through unchanged apart from lowercasing", () => {
    expect(normalizeCompanyDomain("Musterfirma.de")).toBe("musterfirma.de");
  });
});

describe("isLikelyCompanyHost", () => {
  it("accepts a plausible host", () => {
    expect(isLikelyCompanyHost("musterfirma.de")).toBe(true);
    expect(isLikelyCompanyHost("mail.musterfirma.co.uk")).toBe(true);
  });

  it("rejects a value with no dot or with spaces", () => {
    expect(isLikelyCompanyHost("musterfirma")).toBe(false);
    expect(isLikelyCompanyHost("not a domain")).toBe(false);
    expect(isLikelyCompanyHost("")).toBe(false);
  });
});

describe("normalizeCompanyAliases", () => {
  it("trims, drops blank entries, and de-duplicates case-insensitively keeping the first casing", () => {
    expect(normalizeCompanyAliases(["  Musterfirma  ", "", "  ", "musterfirma", "Muster Kurzform"])).toEqual([
      "Musterfirma",
      "Muster Kurzform",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(normalizeCompanyAliases([])).toEqual([]);
  });
});

describe("isGenericCompanyAlias", () => {
  it.each(["GbR", "GmbH", "UG", "AG", "KG", "e.K.", "OHG", "GmbH & Co. KG"])("flags the bare legal form %s as generic", (alias) => {
    expect(isGenericCompanyAlias(alias)).toBe(true);
  });

  it.each(["AB", "X", ""])("flags an alias shorter than 3 characters as generic (%s)", (alias) => {
    expect(isGenericCompanyAlias(alias)).toBe(true);
  });

  it("does not flag a real brand name", () => {
    expect(isGenericCompanyAlias("Musterfirma")).toBe(false);
    expect(isGenericCompanyAlias("Erika Maria Beispiel GbR")).toBe(false);
  });
});

describe("createWorkspaceUseCases", () => {
  describe("createForUser", () => {
    it("creates a workspace and makes the user its admin", async () => {
      const { useCases, workspaceState, memberState } = setup();

      const result = await useCases.createForUser({ userId: "u1", name: "  Muster GmbH  " });

      expect(result.workspace.name).toBe("Muster GmbH");
      expect(result.role).toBe("admin");
      expect(workspaceState).toHaveLength(1);
      expect(memberState).toEqual([expect.objectContaining({ userId: "u1", role: "admin" })]);
    });

    it("rejects an empty name with invalid_input", async () => {
      const { useCases } = setup();
      await expect(useCases.createForUser({ userId: "u1", name: "   " })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invalidInput,
      });
    });

    it("rejects a name over 120 characters with invalid_input", async () => {
      const { useCases } = setup();
      await expect(useCases.createForUser({ userId: "u1", name: "x".repeat(121) })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invalidInput,
      });
    });

    // decisions/0070-several-workspaces-per-user.md: this used to be rejected with
    // `already_in_workspace`. A user running more than one company is exactly the case the
    // feature exists for, so a second workspace is now an ordinary success.
    it("lets a user who already has a workspace create a second one, as its admin", async () => {
      const existingWorkspace = workspaceRow({ name: "Existing" });
      const existingMember = memberRow({ workspaceId: existingWorkspace.id, userId: "u1", role: "admin" });
      const { useCases, workspaceState, memberState } = setup({
        workspaces: [existingWorkspace],
        members: [existingMember],
      });

      const result = await useCases.createForUser({ userId: "u1", name: "Second Co" });

      expect(result.workspace.name).toBe("Second Co");
      expect(result.role).toBe("admin");
      expect(workspaceState).toHaveLength(2);
      expect(memberState.filter((m) => m.userId === "u1")).toHaveLength(2);
      // The two workspaces are separate rows: nothing about the first one changed.
      expect(result.workspace.id).not.toBe(existingWorkspace.id);
    });
  });

  describe("listMembershipsForUser (decisions/0070-several-workspaces-per-user.md)", () => {
    it("returns an empty list for a user with no membership", async () => {
      const { useCases } = setup();
      expect(await useCases.listMembershipsForUser("u1")).toEqual([]);
    });

    it("returns every membership, oldest first, regardless of insertion order", async () => {
      const older = workspaceRow({ name: "Erste GmbH" });
      const newer = workspaceRow({ name: "Zweite GmbH" });
      const { useCases } = setup({
        workspaces: [older, newer],
        members: [
          memberRow({ workspaceId: newer.id, userId: "u1", role: "admin", joinedAt: new Date(2_000) }),
          memberRow({ workspaceId: older.id, userId: "u1", role: "member", joinedAt: new Date(1_000) }),
        ],
      });

      const result = await useCases.listMembershipsForUser("u1");

      expect(result.map((m) => m.workspace.name)).toEqual(["Erste GmbH", "Zweite GmbH"]);
    });

    it("never returns another user's membership", async () => {
      const mine = workspaceRow({ name: "Meine GmbH" });
      const theirs = workspaceRow({ name: "Fremde GmbH" });
      const { useCases } = setup({
        workspaces: [mine, theirs],
        members: [
          memberRow({ workspaceId: mine.id, userId: "u1", role: "admin" }),
          memberRow({ workspaceId: theirs.id, userId: "u2", role: "admin" }),
        ],
      });

      expect((await useCases.listMembershipsForUser("u1")).map((m) => m.workspace.name)).toEqual(["Meine GmbH"]);
    });
  });

  describe("getMembershipInWorkspace (decisions/0070-several-workspaces-per-user.md)", () => {
    it("returns the membership when the user is a member of that workspace", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const member = memberRow({ workspaceId: workspace.id, userId: "u1", role: "member" });
      const { useCases } = setup({ workspaces: [workspace], members: [member] });

      await expect(useCases.getMembershipInWorkspace({ userId: "u1", workspaceId: workspace.id })).resolves.toMatchObject(
        { membershipId: member.id, role: "member", workspace: { id: workspace.id } },
      );
    });

    it("returns null for a workspace the user is not a member of, the same as for one that does not exist", async () => {
      const mine = workspaceRow({ name: "Meine GmbH" });
      const theirs = workspaceRow({ name: "Fremde GmbH" });
      const { useCases } = setup({
        workspaces: [mine, theirs],
        members: [
          memberRow({ workspaceId: mine.id, userId: "u1", role: "admin" }),
          memberRow({ workspaceId: theirs.id, userId: "u2", role: "admin" }),
        ],
      });

      expect(await useCases.getMembershipInWorkspace({ userId: "u1", workspaceId: theirs.id })).toBeNull();
      expect(await useCases.getMembershipInWorkspace({ userId: "u1", workspaceId: crypto.randomUUID() })).toBeNull();
    });
  });

  describe("getMembershipForUser", () => {
    it("returns the OLDEST membership when the user has several", async () => {
      const older = workspaceRow({ name: "Erste GmbH" });
      const newer = workspaceRow({ name: "Zweite GmbH" });
      const { useCases } = setup({
        workspaces: [older, newer],
        members: [
          memberRow({ workspaceId: newer.id, userId: "u1", role: "admin", joinedAt: new Date(2_000) }),
          memberRow({ workspaceId: older.id, userId: "u1", role: "admin", joinedAt: new Date(1_000) }),
        ],
      });

      // `resolveAccess`'s fallback depends on this being deterministic, not on insertion order.
      await expect(useCases.getMembershipForUser("u1")).resolves.toMatchObject({ workspace: { id: older.id } });
    });

    it("returns null when the user has no membership", async () => {
      const { useCases } = setup();
      expect(await useCases.getMembershipForUser("u1")).toBeNull();
    });

    it("returns the membership and its workspace", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const member = memberRow({ workspaceId: workspace.id, userId: "u1", role: "admin" });
      const { useCases } = setup({ workspaces: [workspace], members: [member] });

      const result = await useCases.getMembershipForUser("u1");

      expect(result).toEqual({
        membershipId: member.id,
        role: "admin",
        workspace: { id: workspace.id, name: "Muster GmbH", tier: "free", createdAt: workspace.createdAt },
      });
    });
  });

  describe("listMembers", () => {
    it("lists members and only pending invitations", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const admin = memberRow({ workspaceId: workspace.id, userId: "u1", role: "admin" });
      const pending = invitationRow({
        workspaceId: workspace.id,
        email: "pending@example.test",
        tokenHash: "hash-1",
        invitedByUserId: "u1",
        expiresAt: new Date(FIXED_NOW.getTime() + DAY_MS),
      });
      const accepted = invitationRow({
        workspaceId: workspace.id,
        email: "accepted@example.test",
        tokenHash: "hash-2",
        invitedByUserId: "u1",
        expiresAt: new Date(FIXED_NOW.getTime() + DAY_MS),
        acceptedAt: FIXED_NOW,
      });
      const { useCases } = setup({
        workspaces: [workspace],
        members: [admin],
        users: { u1: { email: "admin@example.test", name: "Admin" } },
        invitations: [pending, accepted],
      });

      const result = await useCases.listMembers(workspace.id);

      expect(result.members).toEqual([
        { id: admin.id, userId: "u1", email: "admin@example.test", name: "Admin", role: "admin", joinedAt: admin.joinedAt },
      ]);
      expect(result.invitations).toEqual([
        { id: pending.id, email: "pending@example.test", expiresAt: pending.expiresAt, createdAt: pending.createdAt },
      ]);
    });
  });

  describe("invite", () => {
    it("creates a pending invitation and returns the plain token", async () => {
      const { useCases, invitationState } = setup({
        workspaces: [workspaceRow({ id: "w1", name: "Muster GmbH" })],
        generateToken: () => "plain-token",
      });

      const result = await useCases.invite({ workspaceId: "w1", invitedByUserId: "admin1", email: "New@Example.test" });

      expect(result.token).toBe("plain-token");
      expect(result.email).toBe("new@example.test");
      expect(invitationState).toHaveLength(1);
      expect(invitationState[0]?.tokenHash).toBe(createHash("sha256").update("plain-token").digest("hex"));
      expect(invitationState[0]?.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 7 * DAY_MS);
    });

    it("replaces an existing pending invitation for the same email", async () => {
      const existing = invitationRow({
        workspaceId: "w1",
        email: "new@example.test",
        tokenHash: "old-hash",
        invitedByUserId: "admin1",
        expiresAt: new Date(FIXED_NOW.getTime() + DAY_MS),
      });
      const { useCases, invitationState } = setup({
        workspaces: [workspaceRow({ id: "w1", name: "Muster GmbH" })],
        invitations: [existing],
        generateToken: () => "fresh-token",
      });

      await useCases.invite({ workspaceId: "w1", invitedByUserId: "admin1", email: "new@example.test" });

      expect(invitationState).toHaveLength(1);
      expect(invitationState[0]?.tokenHash).not.toBe("old-hash");
    });

    it("rejects a new invitation once the pending cap is reached", async () => {
      const seeded = Array.from({ length: MAX_PENDING_INVITATIONS }, (_, i) =>
        invitationRow({
          workspaceId: "w1",
          email: `person-${i}@example.test`,
          tokenHash: `hash-${i}`,
          invitedByUserId: "admin1",
          expiresAt: new Date(FIXED_NOW.getTime() + DAY_MS),
        }),
      );
      const { useCases } = setup({
        workspaces: [workspaceRow({ id: "w1", name: "Muster GmbH" })],
        invitations: seeded,
      });

      await expect(
        useCases.invite({ workspaceId: "w1", invitedByUserId: "admin1", email: "overflow@example.test" }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.invitationCapReached });
    });
  });

  describe("revokeInvitation", () => {
    it("deletes a pending invitation", async () => {
      const invitation = invitationRow({
        workspaceId: "w1",
        email: "pending@example.test",
        tokenHash: "hash",
        invitedByUserId: "admin1",
        expiresAt: new Date(FIXED_NOW.getTime() + DAY_MS),
      });
      const { useCases, invitationState } = setup({ invitations: [invitation] });

      await useCases.revokeInvitation({ workspaceId: "w1", invitationId: invitation.id });

      expect(invitationState).toHaveLength(0);
    });

    it("rejects revoking an invitation that does not exist", async () => {
      const { useCases } = setup();
      await expect(useCases.revokeInvitation({ workspaceId: "w1", invitationId: crypto.randomUUID() })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.notFound,
      });
    });
  });

  describe("removeMember", () => {
    it("removes a member", async () => {
      const member = memberRow({ workspaceId: "w1", userId: "u2", role: "member" });
      const { useCases, memberState } = setup({ members: [member] });

      await useCases.removeMember({ workspaceId: "w1", actorMembershipId: "admin-membership", memberId: member.id });

      expect(memberState).toHaveLength(0);
    });

    it("rejects removing yourself", async () => {
      const { useCases } = setup();
      await expect(
        useCases.removeMember({ workspaceId: "w1", actorMembershipId: "m1", memberId: "m1" }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.cannotRemoveSelf });
    });

    it("rejects removing a member that does not exist", async () => {
      const { useCases } = setup();
      await expect(
        useCases.removeMember({ workspaceId: "w1", actorMembershipId: "admin-membership", memberId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.notFound });
    });
  });

  describe("previewInvitation", () => {
    function seedInvitation(overrides: Partial<Parameters<typeof invitationRow>[0]> = {}) {
      return invitationRow({
        workspaceId: "w1",
        email: "invitee@example.test",
        tokenHash: createHash("sha256").update("plain-token").digest("hex"),
        invitedByUserId: "admin1",
        expiresAt: new Date(FIXED_NOW.getTime() + DAY_MS),
        ...overrides,
      });
    }

    it("returns the workspace name and inviter email for a pending, unexpired invitation", async () => {
      const invitation = seedInvitation();
      const { useCases } = setup({
        invitations: [invitation],
        details: { w1: { workspaceName: "Muster GmbH", inviterEmail: "admin@example.test" } },
      });

      await expect(useCases.previewInvitation("plain-token")).resolves.toEqual({
        workspaceName: "Muster GmbH",
        inviterEmail: "admin@example.test",
        email: "invitee@example.test",
        expiresAt: invitation.expiresAt,
      });
    });

    it("rejects an unknown token with invitation_not_found", async () => {
      const { useCases } = setup();
      await expect(useCases.previewInvitation("does-not-exist")).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invitationNotFound,
      });
    });

    it("rejects an already-accepted invitation with invitation_already_used", async () => {
      const invitation = seedInvitation({ acceptedAt: FIXED_NOW });
      const { useCases } = setup({
        invitations: [invitation],
        details: { w1: { workspaceName: "Muster GmbH", inviterEmail: "admin@example.test" } },
      });

      await expect(useCases.previewInvitation("plain-token")).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invitationAlreadyUsed,
      });
    });

    it("rejects an expired invitation with invitation_expired", async () => {
      const invitation = seedInvitation({ expiresAt: new Date(FIXED_NOW.getTime() - DAY_MS) });
      const { useCases } = setup({
        invitations: [invitation],
        details: { w1: { workspaceName: "Muster GmbH", inviterEmail: "admin@example.test" } },
      });

      await expect(useCases.previewInvitation("plain-token")).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invitationExpired,
      });
    });
  });

  describe("acceptInvitation", () => {
    function seedInvitation(overrides: Partial<Parameters<typeof invitationRow>[0]> = {}) {
      return invitationRow({
        workspaceId: "w1",
        email: "invitee@example.test",
        tokenHash: createHash("sha256").update("plain-token").digest("hex"),
        invitedByUserId: "admin1",
        expiresAt: new Date(FIXED_NOW.getTime() + DAY_MS),
        ...overrides,
      });
    }

    it("accepts a valid invitation and creates the membership", async () => {
      const invitation = seedInvitation();
      const { useCases, invitationState, memberState } = setup({ invitations: [invitation] });

      const result = await useCases.acceptInvitation({ token: "plain-token", userId: "u2", userEmail: "Invitee@Example.test" });

      expect(result).toEqual({ workspaceId: "w1" });
      expect(invitationState[0]?.acceptedAt).toEqual(FIXED_NOW);
      expect(memberState).toEqual([expect.objectContaining({ workspaceId: "w1", userId: "u2", role: "member" })]);
    });

    it("rejects an unknown token with invitation_not_found", async () => {
      const { useCases } = setup();
      await expect(
        useCases.acceptInvitation({ token: "does-not-exist", userId: "u2", userEmail: "invitee@example.test" }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.invitationNotFound });
    });

    it("rejects an already-used invitation with invitation_already_used", async () => {
      const invitation = seedInvitation({ acceptedAt: FIXED_NOW });
      const { useCases } = setup({ invitations: [invitation] });

      await expect(
        useCases.acceptInvitation({ token: "plain-token", userId: "u2", userEmail: "invitee@example.test" }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.invitationAlreadyUsed });
    });

    it("rejects an expired invitation with invitation_expired", async () => {
      const invitation = seedInvitation({ expiresAt: new Date(FIXED_NOW.getTime() - DAY_MS) });
      const { useCases } = setup({ invitations: [invitation] });

      await expect(
        useCases.acceptInvitation({ token: "plain-token", userId: "u2", userEmail: "invitee@example.test" }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.invitationExpired });
    });

    it("rejects a mismatched email with invitation_email_mismatch", async () => {
      const invitation = seedInvitation();
      const { useCases } = setup({ invitations: [invitation] });

      await expect(
        useCases.acceptInvitation({ token: "plain-token", userId: "u2", userEmail: "someone-else@example.test" }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.invitationEmailMismatch });
    });

    // decisions/0070-several-workspaces-per-user.md: `already_in_workspace` now means being
    // in THIS workspace, not in any workspace.
    it("accepts an invitation from a user who already belongs to a DIFFERENT workspace", async () => {
      const invitation = seedInvitation();
      const otherWorkspace = workspaceRow({ name: "Other Co" });
      const { useCases, memberState } = setup({
        invitations: [invitation],
        workspaces: [workspaceRow({ id: "w1", name: "Invited Co" }), otherWorkspace],
        members: [memberRow({ workspaceId: otherWorkspace.id, userId: "u2", role: "admin" })],
      });

      await expect(
        useCases.acceptInvitation({ token: "plain-token", userId: "u2", userEmail: "invitee@example.test" }),
      ).resolves.toEqual({ workspaceId: "w1" });
      expect(memberState.filter((m) => m.userId === "u2")).toHaveLength(2);
    });

    it("rejects a user who already belongs to THIS workspace with already_in_workspace", async () => {
      const invitation = seedInvitation();
      const { useCases } = setup({
        invitations: [invitation],
        workspaces: [workspaceRow({ id: "w1", name: "Invited Co" })],
        members: [memberRow({ workspaceId: "w1", userId: "u2", role: "member" })],
      });

      await expect(
        useCases.acceptInvitation({ token: "plain-token", userId: "u2", userEmail: "invitee@example.test" }),
      ).rejects.toMatchObject({ code: WORKSPACE_ERROR.alreadyInWorkspace });
    });
  });

  describe("company profile (decisions/0019-contacts.md)", () => {
    it("getCompanyProfile returns null for a workspace that does not exist", async () => {
      const { useCases } = setup();
      expect(await useCases.getCompanyProfile("does-not-exist")).toBeNull();
    });

    it("getCompanyProfile returns the workspace name plus null/empty company fields for a fresh workspace", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      expect(await useCases.getCompanyProfile("w1")).toEqual({
        name: "Muster GmbH",
        addressLine1: null,
        addressLine2: null,
        postalCode: null,
        city: null,
        country: null,
        vatId: null,
        aliases: [],
        ibans: [],
        domains: [],
        taxNumber: null,
        registerCourt: null,
        registerNumber: null,
        profileText: null,
      });
    });

    it("updateCompanyProfile trims fields, defaults a blank country to DE, and returns the updated profile", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases, workspaceState } = setup({ workspaces: [workspace] });

      const profile = await useCases.updateCompanyProfile({
        workspaceId: "w1",
        addressLine1: "  Musterstraße 1  ",
        postalCode: "12345",
        city: "Berlin",
        vatId: "DE123456789",
      });

      expect(profile).toEqual({
        name: "Muster GmbH",
        addressLine1: "Musterstraße 1",
        addressLine2: null,
        postalCode: "12345",
        city: "Berlin",
        country: "DE",
        vatId: "DE123456789",
        aliases: [],
        ibans: [],
        domains: [],
        taxNumber: null,
        registerCourt: null,
        registerNumber: null,
        profileText: null,
      });
      expect(workspaceState[0].companyCountry).toBe("DE");
    });

    it("updateCompanyProfile throws not_found for a workspace that does not exist", async () => {
      const { useCases } = setup();
      await expect(useCases.updateCompanyProfile({ workspaceId: "does-not-exist" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.notFound,
      });
    });
  });

  // decisions/0034-extended-company-profile.md (H1): aliases/IBANs/domains/tax-and-register
  // data/free text.
  describe("company profile - extended fields (decisions/0034-extended-company-profile.md)", () => {
    it("normalizes aliases (trims, drops blanks, de-duplicates case-insensitively keeping the first casing)", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.updateCompanyProfile({
        workspaceId: "w1",
        aliases: ["  Musterfirma  ", "", "musterfirma", "Muster Kurzform"],
      });

      expect(profile.aliases).toEqual(["Musterfirma", "Muster Kurzform"]);
    });

    it("rejects an alias that is too short with alias_too_generic", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(useCases.updateCompanyProfile({ workspaceId: "w1", aliases: ["AB"] })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.aliasTooGeneric,
      });
    });

    it.each(["GbR", "GmbH", "UG", "AG", "KG", "e.K.", "OHG"])("rejects the bare legal form %s as too generic", async (bareLegalForm) => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(useCases.updateCompanyProfile({ workspaceId: "w1", aliases: [bareLegalForm] })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.aliasTooGeneric,
      });
    });

    it("normalizes a valid IBAN (uppercase, spaces stripped)", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.updateCompanyProfile({
        workspaceId: "w1",
        ibans: ["de89 3704 0044 0532 0130 00"],
      });

      expect(profile.ibans).toEqual(["DE89370400440532013000"]);
    });

    it("rejects a malformed IBAN with invalid_iban", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(useCases.updateCompanyProfile({ workspaceId: "w1", ibans: ["DE00000000000000000000"] })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invalidIban,
      });
    });

    it("normalizes a domain (strips scheme, www., path, port; lowercases)", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.updateCompanyProfile({
        workspaceId: "w1",
        domains: ["HTTPS://WWW.Musterfirma.de:443/impressum"],
      });

      expect(profile.domains).toEqual(["musterfirma.de"]);
    });

    it("rejects a domain that does not look like a host with invalid_domain", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(useCases.updateCompanyProfile({ workspaceId: "w1", domains: ["not a domain"] })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invalidDomain,
      });
    });

    it("stores tax number, register court/number, and trimmed profile text", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.updateCompanyProfile({
        workspaceId: "w1",
        taxNumber: " 12/345/67890 ",
        registerCourt: " Amtsgericht Charlottenburg ",
        registerNumber: " HRB 123456 ",
        profileText: '  Wir treten als "musterfirma" auf.  ',
      });

      expect(profile.taxNumber).toBe("12/345/67890");
      expect(profile.registerCourt).toBe("Amtsgericht Charlottenburg");
      expect(profile.registerNumber).toBe("HRB 123456");
      expect(profile.profileText).toBe('Wir treten als "musterfirma" auf.');
    });

    it("clears profileText when given a blank value", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH", companyProfileText: "old text" });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.updateCompanyProfile({ workspaceId: "w1", profileText: "   " });

      expect(profile.profileText).toBeNull();
    });
  });

  // decisions/0037-correction-buttons.md: "Das sind wir" / "Das ist unsere Bank" add a single
  // entry to the extended profile's own aliases/ibans, reusing `updateCompanyProfile`'s own
  // validation exactly.
  describe("addCompanyAlias (decisions/0037-correction-buttons.md)", () => {
    it("adds the alias and preserves the rest of the profile untouched", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH", companyDomains: ["muster.de"], companyVatId: "DE123456789" });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.addCompanyAlias({ workspaceId: "w1", alias: "  Musterfirma  " });

      expect(profile.aliases).toEqual(["Musterfirma"]);
      expect(profile.domains).toEqual(["muster.de"]);
      expect(profile.vatId).toBe("DE123456789");
    });

    it("is idempotent: adding the same alias again (case-insensitively) is a no-op success", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH", companyAliases: ["Musterfirma"] });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.addCompanyAlias({ workspaceId: "w1", alias: "musterfirma" });

      expect(profile.aliases).toEqual(["Musterfirma"]);
    });

    it("rejects a too-generic alias with alias_too_generic, unchanged", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH", companyAliases: ["Musterfirma"] });
      const { useCases, workspaceState } = setup({ workspaces: [workspace] });

      await expect(useCases.addCompanyAlias({ workspaceId: "w1", alias: "GbR" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.aliasTooGeneric,
      });
      expect(workspaceState[0].companyAliases).toEqual(["Musterfirma"]);
    });

    it("rejects once the 20-entry cap is reached with invalid_input", async () => {
      const workspace = workspaceRow({
        id: "w1",
        name: "Muster GmbH",
        companyAliases: Array.from({ length: MAX_COMPANY_PROFILE_LIST_ENTRIES }, (_, i) => `Alias ${i}`),
      });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(useCases.addCompanyAlias({ workspaceId: "w1", alias: "One More" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invalidInput,
      });
    });

    it("throws not_found for a workspace that does not exist", async () => {
      const { useCases } = setup();
      await expect(useCases.addCompanyAlias({ workspaceId: "does-not-exist", alias: "Musterfirma" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.notFound,
      });
    });
  });

  describe("addCompanyIban (decisions/0037-correction-buttons.md)", () => {
    it("normalizes and adds the IBAN", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.addCompanyIban({ workspaceId: "w1", iban: "de89 3704 0044 0532 0130 00" });

      expect(profile.ibans).toEqual(["DE89370400440532013000"]);
    });

    it("is idempotent: adding an IBAN that normalizes to an existing entry is a no-op success", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH", companyIbans: ["DE89370400440532013000"] });
      const { useCases } = setup({ workspaces: [workspace] });

      const profile = await useCases.addCompanyIban({ workspaceId: "w1", iban: "DE89 3704 0044 0532 0130 00" });

      expect(profile.ibans).toEqual(["DE89370400440532013000"]);
    });

    it("rejects a malformed IBAN with invalid_iban, unchanged", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases, workspaceState } = setup({ workspaces: [workspace] });

      await expect(useCases.addCompanyIban({ workspaceId: "w1", iban: "DE00000000000000000000" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invalidIban,
      });
      expect(workspaceState[0].companyIbans).toEqual([]);
    });

    it("rejects a blank IBAN with invalid_iban", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(useCases.addCompanyIban({ workspaceId: "w1", iban: "   " })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.invalidIban,
      });
    });

    it("throws not_found for a workspace that does not exist", async () => {
      const { useCases } = setup();
      await expect(useCases.addCompanyIban({ workspaceId: "does-not-exist", iban: "DE89370400440532013000" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.notFound,
      });
    });
  });

  describe("leaveWorkspace (F5, decisions/0027-hardening-and-deletion.md)", () => {
    it("lets a non-admin member leave", async () => {
      const member = memberRow({ workspaceId: "w1", userId: "u2", role: "member" });
      const { useCases, memberState } = setup({ members: [member] });

      await useCases.leaveWorkspace({ workspaceId: "w1", membershipId: member.id });

      expect(memberState).toHaveLength(0);
    });

    it("rejects the workspace's own admin with cannot_leave_as_admin, touching nothing", async () => {
      const admin = memberRow({ workspaceId: "w1", userId: "u1", role: "admin" });
      const { useCases, memberState } = setup({ members: [admin] });

      await expect(useCases.leaveWorkspace({ workspaceId: "w1", membershipId: admin.id })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.cannotLeaveAsAdmin,
      });
      expect(memberState).toHaveLength(1);
    });

    it("rejects a membership that does not exist (or belongs to another workspace) with not_found", async () => {
      const member = memberRow({ workspaceId: "w2", userId: "u2", role: "member" });
      const { useCases } = setup({ members: [member] });

      await expect(useCases.leaveWorkspace({ workspaceId: "w1", membershipId: member.id })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.notFound,
      });
    });
  });

  describe("deleteWorkspace (F5, decisions/0027-hardening-and-deletion.md)", () => {
    // Object-storage keys are only ever built from real database ids (`assertUuid`,
    // src/platform/object-storage/core/keys.ts) - unlike this file's other describe blocks,
    // which use opaque test ids like "w1" freely, `deleteWorkspace` computes a storage prefix
    // from the deleted row's own id, so these tests need a real UUID-shaped one.
    const WORKSPACE_UUID = "11111111-1111-4111-8111-111111111111";

    it("deletes the workspace row and enqueues a workspace-less cleanup-workspace-storage job", async () => {
      const workspace = workspaceRow({ id: WORKSPACE_UUID, name: "Muster GmbH" });
      const { useCases, workspaceState, jobState } = setup({ workspaces: [workspace] });

      const result = await useCases.deleteWorkspace({ workspaceId: WORKSPACE_UUID, confirmName: "Muster GmbH" });

      expect(result.storagePrefix).toBe(`workspaces/${WORKSPACE_UUID}/`);
      expect(workspaceState).toHaveLength(0);
      expect(jobState).toEqual([
        expect.objectContaining({
          kind: JOB_KINDS.cleanupWorkspaceStorage,
          // `null`, not the deleted workspace's id: `jobs.workspace_id` cascades from
          // `workspaces.id`, so a non-null value here would delete this very job in the same
          // statement that creates the need for it (decisions/0027).
          workspaceId: null,
          payload: { prefix: `workspaces/${WORKSPACE_UUID}/` },
        }),
      ]);
    });

    it("accepts a leading/trailing-whitespace confirmation that trims to the exact name", async () => {
      const workspace = workspaceRow({ id: WORKSPACE_UUID, name: "Muster GmbH" });
      const { useCases, workspaceState } = setup({ workspaces: [workspace] });

      await useCases.deleteWorkspace({ workspaceId: WORKSPACE_UUID, confirmName: "  Muster GmbH  " });

      expect(workspaceState).toHaveLength(0);
    });

    it("rejects a mismatched confirmation, deleting nothing and enqueueing no job", async () => {
      const workspace = workspaceRow({ id: "w1", name: "Muster GmbH" });
      const { useCases, workspaceState, jobState } = setup({ workspaces: [workspace] });

      await expect(useCases.deleteWorkspace({ workspaceId: "w1", confirmName: "Wrong Name" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.confirmationMismatch,
      });
      expect(workspaceState).toHaveLength(1);
      expect(jobState).toHaveLength(0);
    });

    it("rejects a workspace that does not exist with not_found", async () => {
      const { useCases } = setup();
      await expect(useCases.deleteWorkspace({ workspaceId: "does-not-exist", confirmName: "anything" })).rejects.toMatchObject({
        code: WORKSPACE_ERROR.notFound,
      });
    });
  });
});
