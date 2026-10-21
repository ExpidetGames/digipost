"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/platform/auth/server";
import {
  clearActiveWorkspaceCookie,
  getWorkspaceAccess,
  requirePermission,
  setActiveWorkspaceCookie,
} from "@/platform/access/server";
import { PERMISSIONS } from "@/platform/access";
import { getRequestServices } from "@/persistence/composition/request-services";
import { WORKSPACE_ERROR } from "@/persistence/use-cases/workspaces-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createSmtpMailer } from "@/platform/mailer/server";
import { serverEnv } from "@/platform/env/server";
import { getObjectStorage } from "@/platform/object-storage/server";
import type { ActionResult } from "@/shared/action-result";

import {
  acceptInvitationInputSchema,
  companyProfileInputSchema,
  createWorkspaceInputSchema,
  deleteWorkspaceInputSchema,
  inviteMemberInputSchema,
  removeMemberInputSchema,
  revokeInvitationInputSchema,
  switchWorkspaceInputSchema,
} from "./core/schemas";
import type { CompanyProfileActionErrorCode, WorkspaceActionErrorCode } from "./core/error-codes";
import { INVITATION_EMAIL_SUBJECT, renderInvitationEmail } from "./server/emails/invitation-email";

function mapUseCaseError(err: unknown): WorkspaceActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === WORKSPACE_ERROR.invalidInput ||
      code === WORKSPACE_ERROR.alreadyInWorkspace ||
      code === WORKSPACE_ERROR.notFound ||
      code === WORKSPACE_ERROR.cannotRemoveSelf ||
      code === WORKSPACE_ERROR.invitationCapReached ||
      code === WORKSPACE_ERROR.invitationNotFound ||
      code === WORKSPACE_ERROR.invitationExpired ||
      code === WORKSPACE_ERROR.invitationAlreadyUsed ||
      code === WORKSPACE_ERROR.invitationEmailMismatch ||
      code === WORKSPACE_ERROR.confirmationMismatch ||
      code === WORKSPACE_ERROR.cannotLeaveAsAdmin ||
      code === WORKSPACE_ERROR.aliasTooGeneric
    ) {
      return code;
    }
  }
  return "unknown";
}

/** `updateCompanyProfileAction`'s own mapping (decisions/0034-extended-company-profile.md):
 * a superset of `mapUseCaseError` above with the two extended-profile codes
 * `mapUseCaseError` never needs (`createWorkspaceAction`'s onboarding form collects `aliases`
 * only, never `ibans`/`domains`). */
function mapCompanyProfileUseCaseError(err: unknown): CompanyProfileActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === WORKSPACE_ERROR.notFound ||
      code === WORKSPACE_ERROR.aliasTooGeneric ||
      code === WORKSPACE_ERROR.invalidIban ||
      code === WORKSPACE_ERROR.invalidDomain
    ) {
      return code;
    }
  }
  return "unknown";
}

/**
 * Creates a workspace for the signed-in user and makes them its admin. `requireUser()`
 * re-authenticates: Server Actions are public endpoints (WEBAPP_TEMPLATE_SPEC.md §6.4).
 */
export async function createWorkspaceAction(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }, WorkspaceActionErrorCode>> {
  const user = await requireUser();
  const parsed = createWorkspaceInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  try {
    const services = getRequestServices();
    const { workspace } = await services.workspaces.createForUser({
      userId: user.id,
      name: parsed.data.name,
    });
    // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): the company profile is
    // stored right after workspace creation, in the same action call. `updateCompanyProfile`
    // does not itself enforce authorization (`decisions/0019-contacts.md`'s own documented
    // "use cases never enforce authorization" pattern) - the freshly created workspace's
    // creator is its sole admin either way (`createForUser`'s own contract), so no separate
    // permission check is needed for THIS call specifically.
    await services.workspaces.updateCompanyProfile({
      workspaceId: workspace.id,
      addressLine1: parsed.data.addressLine1,
      addressLine2: parsed.data.addressLine2,
      postalCode: parsed.data.postalCode,
      city: parsed.data.city,
      country: parsed.data.country,
      vatId: parsed.data.vatId,
      // decisions/0034-extended-company-profile.md: onboarding only collects `aliases`
      // (kept short on purpose) - the settings form is where the rest of the extended
      // profile gets filled in.
      aliases: parsed.data.aliases,
    });
    // decisions/0070-several-workspaces-per-user.md: the workspace you just created is the
    // one you want to be in, whether it is your first or your third. Safe to write without a
    // further membership check - `createForUser` made this caller its admin one statement
    // ago.
    await setActiveWorkspaceCookie(workspace.id);
    revalidatePath("/dashboard");
    revalidatePath("/onboarding");
    return { status: "success", data: { id: workspace.id, name: workspace.name } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/**
 * Updates the workspace's own company profile ("Firmendaten",
 * decisions/0021-extraction-direction-and-invoice-fields.md, extended by
 * decisions/0034-extended-company-profile.md's aliases/IBANs/domains/tax-and-register-data/
 * free text). Admin-only (`PERMISSIONS.companyProfileManage`) - existing workspaces from
 * before this phase have no company profile yet, and only the admin may set or change one.
 */
export async function updateCompanyProfileAction(
  input: unknown,
): Promise<ActionResult<undefined, CompanyProfileActionErrorCode>> {
  const parsed = companyProfileInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.companyProfileManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().workspaces.updateCompanyProfile({
      workspaceId: access.access.workspace.id,
      addressLine1: parsed.data.addressLine1,
      addressLine2: parsed.data.addressLine2,
      postalCode: parsed.data.postalCode,
      city: parsed.data.city,
      country: parsed.data.country,
      vatId: parsed.data.vatId,
      aliases: parsed.data.aliases,
      ibans: parsed.data.ibans,
      domains: parsed.data.domains,
      taxNumber: parsed.data.taxNumber,
      registerCourt: parsed.data.registerCourt,
      registerNumber: parsed.data.registerNumber,
      profileText: parsed.data.profileText,
    });
    revalidatePath("/dashboard/settings/company");
    revalidatePath("/dashboard");
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapCompanyProfileUseCaseError(err) };
  }
}

/**
 * Invites `email` to the caller's workspace. Only an admin may invite
 * (`PERMISSIONS.membersManage`, `requirePermission` resolves the caller's own workspace -
 * never the client's input - and checks the role's permission bundle). Sending the
 * invitation e-mail is best-effort: a delivery failure is logged but does not roll back
 * the created invitation, since the admin can still see and re-send it from the team list.
 */
export async function inviteMemberAction(
  input: unknown,
): Promise<ActionResult<{ id: string; email: string; expiresAt: string; createdAt: string }, WorkspaceActionErrorCode>> {
  const parsed = inviteMemberInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.membersManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const result = await getRequestServices().workspaces.invite({
      workspaceId: access.access.workspace.id,
      invitedByUserId: access.access.user.id,
      email: parsed.data.email,
    });

    try {
      const url = new URL(`/invite/${result.token}`, serverEnv().APP_URL).toString();
      const { html, text } = await renderInvitationEmail({
        workspaceName: access.access.workspace.name,
        inviterEmail: access.access.user.email,
        url,
      });
      await createSmtpMailer().send({ to: result.email, subject: INVITATION_EMAIL_SUBJECT, html, text });
    } catch (mailErr) {
      console.error("[workspaces] sending invitation email failed", mailErr instanceof Error ? mailErr.message : mailErr);
    }

    revalidatePath("/dashboard/team");
    return {
      status: "success",
      data: {
        id: result.invitationId,
        email: result.email,
        expiresAt: result.expiresAt.toISOString(),
        createdAt: result.createdAt.toISOString(),
      },
    };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** Revokes a pending invitation. Admin-only, same authorization as `inviteMemberAction`. */
export async function revokeInvitationAction(
  input: unknown,
): Promise<ActionResult<undefined, WorkspaceActionErrorCode>> {
  const parsed = revokeInvitationInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.membersManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().workspaces.revokeInvitation({
      workspaceId: access.access.workspace.id,
      invitationId: parsed.data.invitationId,
    });
    revalidatePath("/dashboard/team");
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** Removes a member. Admin-only; the use case itself rejects removing yourself
 * (`cannot_remove_self`) before ever touching the repository. */
export async function removeMemberAction(
  input: unknown,
): Promise<ActionResult<undefined, WorkspaceActionErrorCode>> {
  const parsed = removeMemberInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.membersManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().workspaces.removeMember({
      workspaceId: access.access.workspace.id,
      actorMembershipId: access.access.membershipId,
      memberId: parsed.data.memberId,
    });
    revalidatePath("/dashboard/team");
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/**
 * A non-admin member leaves their own workspace ("Arbeitsbereich verlassen", F5,
 * decisions/0027-hardening-and-deletion.md). Any member may call this (no permission bundle
 * gate - it only ever acts on the caller's own membership), but the use case itself rejects
 * the workspace's own admin with `cannot_leave_as_admin` before touching the repository.
 * `getWorkspaceAccess()` (never `requireWorkspaceMember()`, which redirects) is the correct
 * choice here: a Server Action has no page to redirect from mid-request.
 */
export async function leaveWorkspaceAction(): Promise<ActionResult<undefined, WorkspaceActionErrorCode>> {
  const access = await getWorkspaceAccess();
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().workspaces.leaveWorkspace({
      workspaceId: access.access.workspace.id,
      membershipId: access.access.membershipId,
    });
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }

  // The caller's own membership in THIS workspace is gone; they may still have others
  // (decisions/0070-several-workspaces-per-user.md). `landAfterLosingActiveWorkspace` sends
  // them to one of those, or to the same workspace-less gate as before when none is left.
  return landAfterLosingActiveWorkspace(access.access.user.id);
}

/**
 * Shared ending of `leaveWorkspaceAction`/`deleteWorkspaceAction`
 * (decisions/0070-several-workspaces-per-user.md): the caller's active workspace has just
 * stopped being theirs, so the stale cookie is replaced by their next remaining workspace -
 * or cleared, landing them on `/onboarding` exactly as before this phase when they have
 * none. Never returns (both branches `redirect()`).
 */
async function landAfterLosingActiveWorkspace(userId: string): Promise<never> {
  const remaining = await getRequestServices().workspaces.listMembershipsForUser(userId);
  // The oldest remaining membership, the same deterministic pick `resolveAccess`'s own
  // fallback would make on the next request if the cookie were simply cleared here.
  const next = remaining[0];

  if (next) {
    await setActiveWorkspaceCookie(next.workspace.id);
    revalidatePath("/dashboard");
    redirect("/dashboard");
  }

  await clearActiveWorkspaceCookie();
  redirect("/onboarding");
}

/**
 * Switches the browser's active workspace ("Firma wechseln",
 * decisions/0070-several-workspaces-per-user.md). The workspace id is client input, so the
 * membership is verified against the database BEFORE the cookie is written, not only when
 * `resolveAccess` reads it back: a caller must never be able to put an id they have no
 * membership for into their own cookie, even though reading it would reject that id anyway.
 * `not_found` both for an unknown workspace and for one the caller is not a member of - the
 * two must not be distinguishable. Redirects to `/dashboard` on success (a cookie write only
 * takes effect for the NEXT request, so the current page must be left behind).
 */
export async function switchWorkspaceAction(
  input: unknown,
): Promise<ActionResult<undefined, WorkspaceActionErrorCode>> {
  const user = await requireUser();
  const parsed = switchWorkspaceInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  try {
    const membership = await getRequestServices().workspaces.getMembershipInWorkspace({
      userId: user.id,
      workspaceId: parsed.data.workspaceId,
    });
    if (!membership) return { status: "error", errorCode: "not_found" };
    await setActiveWorkspaceCookie(membership.workspace.id);
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

/**
 * Permanently deletes the ENTIRE workspace ("Arbeitsbereich löschen", F5,
 * decisions/0027-hardening-and-deletion.md's danger zone): every document, job, contact,
 * account, transaction, settlement line, invitation, membership, usage/purchase record, and
 * intake fingerprint the workspace owns, then every object-storage object under
 * `workspaces/<id>/`. Admin-only (`workspace.manage`). `confirmName` must exactly match the
 * workspace's current name - re-validated server-side by the use case, never trusted from
 * this action's own input parsing alone.
 */
export async function deleteWorkspaceAction(
  input: unknown,
): Promise<ActionResult<undefined, WorkspaceActionErrorCode>> {
  const parsed = deleteWorkspaceInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.workspaceManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  let storagePrefix: string;
  try {
    const result = await getRequestServices().workspaces.deleteWorkspace({
      workspaceId: access.access.workspace.id,
      confirmName: parsed.data.confirmName,
    });
    storagePrefix = result.storagePrefix;
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }

  // Best-effort IMMEDIATE cleanup: the use case already enqueued a durable
  // `cleanup-workspace-storage` job inside its own transaction (decisions/0027's "Storage
  // cleanup" section) as the fallback if this fails, throws, or never runs at all (a crash
  // right after the transaction committed) - so a failure here is only logged, never
  // surfaced to the admin as an error, since the workspace and its data are already gone
  // either way.
  try {
    const objectStorage = getObjectStorage();
    const keys = await objectStorage.listObjects(storagePrefix);
    if (keys.length > 0) {
      const { failedKeys } = await objectStorage.deleteObjects(keys);
      if (failedKeys.length > 0) {
        console.error(
          `[workspaces] deleteWorkspaceAction: ${failedKeys.length}/${keys.length} object(s) under ${storagePrefix} not cleaned up immediately, the retry job will handle it`,
        );
      }
    }
  } catch (err) {
    console.error(
      "[workspaces] deleteWorkspaceAction: immediate storage cleanup failed, the retry job will handle it",
      err instanceof Error ? err.message : err,
    );
  }

  // The acting admin's own membership is gone along with everything else: land them on
  // another of their workspaces if they still have one, otherwise on the same
  // workspace-less gate any user without a membership already gets
  // (`requireWorkspaceMember()` in `src/app/(app)/layout.tsx`), rather than a stale
  // dashboard page for a workspace that no longer exists.
  return landAfterLosingActiveWorkspace(access.access.user.id);
}

/**
 * Accepts a pending invitation for the signed-in user. `requireUser()` re-authenticates
 * (the `/invite/[token]` page already checked a session exists, but a Server Action is its
 * own endpoint, WEBAPP_TEMPLATE_SPEC.md §6.4). The use case checks the invitation is
 * pending, unexpired, and addressed to the signed-in user's email, and that the user has
 * no membership yet, all inside one transaction with the membership insert.
 */
export async function acceptInvitationAction(
  input: unknown,
): Promise<ActionResult<{ workspaceId: string }, WorkspaceActionErrorCode>> {
  const user = await requireUser();
  const parsed = acceptInvitationInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  try {
    const result = await getRequestServices().workspaces.acceptInvitation({
      token: parsed.data.token,
      userId: user.id,
      userEmail: user.email,
    });
    // decisions/0070-several-workspaces-per-user.md: accepting an invitation while already a
    // member of another workspace is allowed, and the workspace just joined becomes the
    // active one - otherwise the invitee would land back in their old workspace and wonder
    // whether the invitation worked at all.
    await setActiveWorkspaceCookie(result.workspaceId);
    revalidatePath("/dashboard");
    return { status: "success", data: result };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}
