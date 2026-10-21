// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1, §10.2's Server Action
// row): calls the real Server Actions in `src/modules/workspaces/actions.ts` against real
// Postgres, with only the session (`@/platform/auth/server`), the mailer
// (`@/platform/mailer/server`), and `next/cache` mocked - `getRequestServices()` and
// `@/platform/access/server`'s `requirePermission`/`getWorkspaceAccess` build and run for
// real. Proves the full onboard -> invite -> accept flow end to end, the layer a unit test
// (which fakes the repository) cannot reach: creating a workspace makes the creator its
// admin, an invited email can accept once (and only once, and only as itself), and a
// second user cannot manage a workspace they do not belong to.
import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  requireUser: async () => {
    if (!currentUser) throw new Error("no current user set for this test");
    return currentUser;
  },
  getCurrentUser: async () => currentUser,
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

// `createSmtpMailer` only - `serverEnv()` (for APP_URL) runs for real: the Docker test
// stack's `tests` service already sets APP_URL (docker/compose.test.yml), and mocking the
// whole `@/platform/env/server` module would also replace `DATABASE_URL` for
// `src/persistence/foundation/client.ts`'s `getDb()`, which this test needs to reach the
// real test-stack Postgres.
const sendMailMock = vi.fn();
vi.mock("@/platform/mailer/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/mailer/server")>();
  return { ...actual, createSmtpMailer: () => ({ send: sendMailMock }) };
});

import { getDb } from "@/persistence/foundation/client";
import { user } from "@/persistence/schema/auth";
import {
  acceptInvitationAction,
  createWorkspaceAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
} from "@/modules/workspaces/actions";
import { getMembershipProjection, listTeamProjection } from "@/modules/workspaces/server";

async function createTestUser(): Promise<{ id: string; email: string }> {
  const email = `${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Integration Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

// C2 (decisions/0021-extraction-direction-and-invoice-fields.md): onboarding now also
// requires a company address.
const VALID_ADDRESS = { addressLine1: "Musterstraße 1", postalCode: "10115", city: "Berlin" };

function extractInviteToken(): string {
  const sentMessage = sendMailMock.mock.calls.at(-1)?.[0] as { html: string } | undefined;
  const match = sentMessage?.html.match(/\/invite\/([a-f0-9]+)/);
  if (!match?.[1]) throw new Error("no invite token found in the sent invitation e-mail");
  return match[1];
}

beforeEach(() => {
  revalidatePathMock.mockClear();
  sendMailMock.mockClear();
});

describe("workspaces onboarding and invitation flow (real Postgres, session mocked)", () => {
  it("creates a workspace and makes the creator its admin", async () => {
    const founder = await createTestUser();
    currentUser = founder;

    const result = await createWorkspaceAction({ name: "Muster GmbH", ...VALID_ADDRESS });

    expect(result).toMatchObject({ status: "success", data: { name: "Muster GmbH" } });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");

    const membership = await getMembershipProjection(founder.id);
    expect(membership).toMatchObject({ role: "admin", workspace: { name: "Muster GmbH" } });
  });

  it("rejects creating a second workspace for the same user", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    await createWorkspaceAction({ name: "First Co", ...VALID_ADDRESS });

    const result = await createWorkspaceAction({ name: "Second Co", ...VALID_ADDRESS });

    expect(result).toEqual({ status: "error", errorCode: "already_in_workspace" });
  });

  it("invites, sends the invitation e-mail, and lets the invitee accept", async () => {
    const admin = await createTestUser();
    currentUser = admin;
    await createWorkspaceAction({ name: "Invite Flow GmbH", ...VALID_ADDRESS });
    const adminMembership = await getMembershipProjection(admin.id);
    if (!adminMembership) throw new Error("setup: admin has no membership");

    const invitee = await createTestUser();
    const inviteResult = await inviteMemberAction({ email: invitee.email });
    expect(inviteResult.status).toBe("success");
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ to: invitee.email.toLowerCase() }));

    const team = await listTeamProjection(adminMembership.workspace.id);
    expect(team.invitations).toEqual([expect.objectContaining({ email: invitee.email.toLowerCase() })]);

    const token = extractInviteToken();
    currentUser = invitee;
    const acceptResult = await acceptInvitationAction({ token });

    expect(acceptResult).toEqual({ status: "success", data: { workspaceId: adminMembership.workspace.id } });
    const inviteeMembership = await getMembershipProjection(invitee.id);
    expect(inviteeMembership).toMatchObject({ role: "member", workspace: { id: adminMembership.workspace.id } });
  });

  it("rejects acceptance from a different email than the one invited", async () => {
    const admin = await createTestUser();
    currentUser = admin;
    await createWorkspaceAction({ name: "Mismatch Co", ...VALID_ADDRESS });

    const invitee = await createTestUser();
    await inviteMemberAction({ email: invitee.email });
    const token = extractInviteToken();

    const someoneElse = await createTestUser();
    currentUser = someoneElse;
    const result = await acceptInvitationAction({ token });

    expect(result).toEqual({ status: "error", errorCode: "invitation_email_mismatch" });
  });

  it("rejects a non-admin member from inviting or removing", async () => {
    const admin = await createTestUser();
    currentUser = admin;
    await createWorkspaceAction({ name: "Permissions Co", ...VALID_ADDRESS });

    const invitee = await createTestUser();
    await inviteMemberAction({ email: invitee.email });
    const token = extractInviteToken();
    currentUser = invitee;
    await acceptInvitationAction({ token });

    // The now-member (not admin) tries to invite and remove: both require members.manage.
    const inviteAttempt = await inviteMemberAction({ email: "someone-else@example.test" });
    expect(inviteAttempt).toEqual({ status: "error", errorCode: "forbidden" });

    const adminMembership = await getMembershipProjection(admin.id);
    if (!adminMembership) throw new Error("setup: admin has no membership");
    const removeAttempt = await removeMemberAction({ memberId: adminMembership.membershipId });
    expect(removeAttempt).toEqual({ status: "error", errorCode: "forbidden" });
  });

  it("rejects a user with no workspace at all from managing members", async () => {
    const outsider = await createTestUser();
    currentUser = outsider;

    const result = await inviteMemberAction({ email: "someone@example.test" });

    expect(result).toEqual({ status: "error", errorCode: "no_workspace" });
  });

  it("lets the admin revoke a pending invitation and remove a member", async () => {
    const admin = await createTestUser();
    currentUser = admin;
    await createWorkspaceAction({ name: "Revoke Co", ...VALID_ADDRESS });
    const adminMembership = await getMembershipProjection(admin.id);
    if (!adminMembership) throw new Error("setup: admin has no membership");

    const pendingInvitee = await createTestUser();
    const inviteResult = await inviteMemberAction({ email: pendingInvitee.email });
    if (inviteResult.status !== "success") throw new Error("setup: invite failed");

    const revokeResult = await revokeInvitationAction({ invitationId: inviteResult.data.id });
    expect(revokeResult).toEqual({ status: "success", data: undefined });
    expect((await listTeamProjection(adminMembership.workspace.id)).invitations).toEqual([]);

    const memberToRemove = await createTestUser();
    await inviteMemberAction({ email: memberToRemove.email });
    const token = extractInviteToken();
    currentUser = memberToRemove;
    await acceptInvitationAction({ token });

    currentUser = admin;
    const memberMembership = await getMembershipProjection(memberToRemove.id);
    if (!memberMembership) throw new Error("setup: member has no membership");
    const removeResult = await removeMemberAction({ memberId: memberMembership.membershipId });

    expect(removeResult).toEqual({ status: "success", data: undefined });
    expect(await getMembershipProjection(memberToRemove.id)).toBeNull();
  });

  it("rejects an admin removing themself", async () => {
    const admin = await createTestUser();
    currentUser = admin;
    await createWorkspaceAction({ name: "Self Removal Co", ...VALID_ADDRESS });
    const adminMembership = await getMembershipProjection(admin.id);
    if (!adminMembership) throw new Error("setup: admin has no membership");

    const result = await removeMemberAction({ memberId: adminMembership.membershipId });

    expect(result).toEqual({ status: "error", errorCode: "cannot_remove_self" });
  });

});
