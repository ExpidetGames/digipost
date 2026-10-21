// Owner: src/modules/workspaces (WEBAPP_TEMPLATE_SPEC.md §14 "Mandanten" recipe).
// Contracts only: no Drizzle import here besides type-only schema references, erased at
// runtime (WEBAPP_TEMPLATE_SPEC.md §5.1 "contracts separate from Drizzle").
//
// Three repositories, one owner (`src/modules/workspaces`), matching the three tables in
// `src/persistence/schema/workspaces.ts`. Every workspace-scoped method takes and filters on
// `workspaceId` explicitly, even though the use case will already have resolved it from the
// caller's own session membership - authorization is then not only convention
// (`src/persistence/README.md`'s "only the owner writes" note, mirroring `projects-repository.ts`'s
// former pattern).
import type { InferSelectModel } from "drizzle-orm";

import type { workspaceInvitations, workspaceMembers, workspaces } from "@/persistence/schema/workspaces";

export type WorkspaceRow = InferSelectModel<typeof workspaces>;
export type WorkspaceMemberRow = InferSelectModel<typeof workspaceMembers>;
export type WorkspaceInvitationRow = InferSelectModel<typeof workspaceInvitations>;

export type CreateWorkspaceRow = { name: string };

/** The workspace's own company-profile fields (decisions/0019-contacts.md's own-company
 * exclusion, extended by decisions/0034-extended-company-profile.md) - `workspaces.name`
 * itself already holds the company name, so it is not part of this type. The three arrays
 * and `companyProfileText` are the extended profile (H1): callers are expected to already
 * have normalized `companyAliases`/`companyIbans`/`companyDomains` (this repository never
 * normalizes on write, the same "no I/O owner does anyone else's validation" split every
 * other repository method here follows) and trimmed `companyProfileText`. */
export type CompanyProfileFields = {
  companyAddressLine1: string | null;
  companyAddressLine2: string | null;
  companyPostalCode: string | null;
  companyCity: string | null;
  companyCountry: string | null;
  companyVatId: string | null;
  companyAliases: string[];
  companyIbans: string[];
  companyDomains: string[];
  companyTaxNumber: string | null;
  companyRegisterCourt: string | null;
  companyRegisterNumber: string | null;
  companyProfileText: string | null;
};
export type CreateMembershipRow = { workspaceId: string; userId: string; role: WorkspaceMemberRow["role"] };
export type CreateInvitationRow = {
  workspaceId: string;
  email: string;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
};

/** A member row joined with the auth user's `email`/`name` - the shape the team list needs. */
export type WorkspaceMemberWithUser = WorkspaceMemberRow & { email: string; name: string };

/** A member row joined with its own workspace row
 * (decisions/0070-several-workspaces-per-user.md): what `listByUserIdWithWorkspace` returns,
 * so resolving the active workspace for a request costs one query rather than one per
 * membership. */
export type WorkspaceMembershipWithWorkspace = { member: WorkspaceMemberRow; workspace: WorkspaceRow };

/** An invitation row joined with its workspace's name and the inviter's email - the shape
 * the `/invite/[token]` preview page needs before the invitee has accepted anything.
 * `inviterEmail` is `null` when the inviting user's account no longer exists
 * (`invitedByUserId` is nullable, `onDelete: "set null"` - P6 review finding A9: the
 * invitation itself must stay valid and readable even after its inviter's account is
 * deleted). */
export type WorkspaceInvitationWithDetails = {
  invitation: WorkspaceInvitationRow;
  workspaceName: string;
  inviterEmail: string | null;
};

export interface WorkspaceRepository {
  create(input: CreateWorkspaceRow): Promise<WorkspaceRow>;
  findById(id: string): Promise<WorkspaceRow | null>;
  /** `select ... for update`: locks the workspace row for the duration of the caller's
   * transaction. `src/persistence/use-cases/documents-use-cases.ts`'s `createFromUpload`
   * uses this to serialize concurrent uploads for the same workspace against the quota
   * check (`src/modules/billing`'s `evaluateQuota`) - a read-only lock, not a write, so it
   * stays a legitimate cross-owner call (`src/persistence/README.md`'s "only the owner
   * writes" rule is about writes). `null` if the workspace does not exist. */
  lockForUpdate(id: string): Promise<WorkspaceRow | null>;
  /** Updates the workspace's `tier` column - only `src/modules/billing`'s `changeTier` use
   * case calls this (P3, decisions/0017-billing-tiers-and-packages.md), inside its own
   * transaction alongside `BillingRepository.insertTierChange`, the same cross-owner
   * transaction-sharing shape as `documents-use-cases.ts`'s `recordDocumentsCreated` call:
   * the write still only ever happens inside this owner's own repository implementation.
   * `null` if the workspace does not exist. */
  updateTier(id: string, tier: WorkspaceRow["tier"]): Promise<WorkspaceRow | null>;
  /** Updates the workspace's `company_*` columns (decisions/0019-contacts.md) - admin-only,
   * enforced by the caller (C2's settings Server Action), not here. `null` if the workspace
   * does not exist. */
  updateCompanyProfile(id: string, fields: CompanyProfileFields): Promise<WorkspaceRow | null>;
  /** decisions/0044: the workspace's auto-confirm mode for payment suggestions. */
  updatePaymentAutoConfirm(id: string, mode: WorkspaceRow["paymentAutoConfirm"]): Promise<WorkspaceRow | null>;
  /** F5 (decisions/0027-hardening-and-deletion.md): deletes the workspace row itself. Every
   * other workspace-owned table's foreign key to `workspaces.id` is `onDelete: "cascade"`
   * (verified against the full schema when this was added - see that ADR's "Cascade
   * verification" section), so this single statement removes every document, job, contact,
   * account, transaction, settlement line, invitation, membership, usage/purchase, and
   * fingerprint row that belonged to it - there is no separate per-table delete sequence to
   * keep in sync. `null` if the workspace does not exist (already deleted, or a bad id -
   * the caller re-checks the typed confirmation before ever reaching here). */
  delete(id: string): Promise<WorkspaceRow | null>;
}

export interface WorkspaceMemberRepository {
  /** Every workspace `userId` belongs to, each joined with its workspace row, oldest
   * membership first (`joined_at`, then `id` as the tie-breaker, so the order is total and
   * stable - `resolveAccess`'s deterministic fallback depends on it,
   * decisions/0070-several-workspaces-per-user.md). Empty when the user belongs to none. */
  listByUserIdWithWorkspace(userId: string): Promise<WorkspaceMembershipWithWorkspace[]>;
  /** The caller's own membership in ONE named workspace, or `null` if they have none there.
   * This is the gate behind the active-workspace cookie
   * (decisions/0070-several-workspaces-per-user.md): the cookie names a workspace, this
   * lookup decides whether the caller may have it. */
  findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceMemberRow | null>;
  findById(workspaceId: string, memberId: string): Promise<WorkspaceMemberRow | null>;
  create(input: CreateMembershipRow): Promise<WorkspaceMemberRow>;
  listByWorkspace(workspaceId: string): Promise<WorkspaceMemberWithUser[]>;
  /** Deletes the member row scoped to `workspaceId`; `null` (not an error) if it does not exist. */
  deleteById(workspaceId: string, memberId: string): Promise<WorkspaceMemberRow | null>;
}

export interface WorkspaceInvitationRepository {
  countPending(workspaceId: string): Promise<number>;
  /** Deletes the workspace's pending (unaccepted) invitation for `email`, if any - the
   * "re-inviting replaces the pending invitation" rule. A no-op if none exists. */
  deletePendingByEmail(workspaceId: string, email: string): Promise<void>;
  create(input: CreateInvitationRow): Promise<WorkspaceInvitationRow>;
  findByTokenHash(tokenHash: string): Promise<WorkspaceInvitationRow | null>;
  /** Same lookup as `findByTokenHash`, joined with workspace name and inviter email for
   * the `/invite/[token]` preview, which never needs to be transaction-bound. */
  findByTokenHashWithDetails(tokenHash: string): Promise<WorkspaceInvitationWithDetails | null>;
  listPendingByWorkspace(workspaceId: string): Promise<WorkspaceInvitationRow[]>;
  /** Deletes the pending invitation scoped to `workspaceId`; `null` (not an error) if it
   * does not exist or is not pending. */
  deleteById(workspaceId: string, invitationId: string): Promise<WorkspaceInvitationRow | null>;
  markAccepted(id: string, acceptedAt: Date): Promise<WorkspaceInvitationRow | null>;
}
