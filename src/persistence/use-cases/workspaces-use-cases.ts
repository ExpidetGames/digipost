// Owner: src/modules/workspaces (WEBAPP_TEMPLATE_SPEC.md §5.4/§14, decisions/0014). Inputs
// are normalized and re-checked here even though `src/modules/workspaces/actions.ts` already
// parsed them with Zod: use cases are the last line of defense. No `next/*`, `react`,
// `src/platform/*/client`, or a module's own `server.ts`/`client.ts` - this file only ever
// sees `Repositories`/`UnitOfWork` from `src/persistence/repositories/contracts`, never
// `repositories/drizzle/**`.
//
// Time and randomness are injected (`now`, `generateToken`), not read from global state
// (WEBAPP_TEMPLATE_SPEC.md §10.2), so unit tests can control invitation expiry and assert on
// a known token.
import { createHash, randomBytes } from "node:crypto";

import { isValidIbanFormat, normalizeIban } from "@/modules/contacts";
import { isPaymentAutoConfirmMode, type PaymentAutoConfirmMode } from "@/modules/payments";
import { isDbError } from "@/persistence/foundation/db-errors";
import type { CompanyProfileFields, Repositories, UnitOfWork, WorkspaceMemberRow, WorkspaceRow } from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { JOB_KINDS } from "@/platform/jobs";
import { workspaceStoragePrefix } from "@/platform/object-storage";

export const WORKSPACE_ERROR = {
  invalidInput: "invalid_input",
  /** Since decisions/0070-several-workspaces-per-user.md this means ONE thing only:
   * accepting an invitation to a workspace the user is already a member of. Belonging to
   * some other workspace is no longer an error anywhere. */
  alreadyInWorkspace: "already_in_workspace",
  notFound: "not_found",
  cannotRemoveSelf: "cannot_remove_self",
  invitationCapReached: "invitation_cap_reached",
  invitationNotFound: "invitation_not_found",
  invitationExpired: "invitation_expired",
  invitationAlreadyUsed: "invitation_already_used",
  invitationEmailMismatch: "invitation_email_mismatch",
  /** F5 (decisions/0027-hardening-and-deletion.md): `deleteWorkspace`'s typed confirmation
   * (the caller must re-type the workspace's exact current name) did not match. */
  confirmationMismatch: "confirmation_mismatch",
  /** F5: `leaveWorkspace` called by the workspace's own admin - blocked, since a workspace
   * always needs exactly one admin (the partial unique index) and there is no
   * admin-transfer flow; an admin who wants out deletes the workspace instead
   * (`deleteWorkspace`), which is a deliberate, typed-confirmation decision, not an
   * accidental click. */
  cannotLeaveAsAdmin: "cannot_leave_as_admin",
  /** decisions/0034-extended-company-profile.md: `updateCompanyProfile`'s extended-profile
   * alias list contains an entry that is either shorter than `COMPANY_ALIAS_MIN_LENGTH` after
   * trimming, or normalizes to nothing but a bare legal form ("GbR", "GmbH", "UG", ...) -
   * `isOwnCompany`'s alias rule is a whole-name match, so an alias this generic would match
   * every company sharing that legal form, not just this workspace's own. */
  aliasTooGeneric: "alias_too_generic",
  /** decisions/0034: an entry in the extended profile's IBAN list failed
   * `@/modules/contacts`'s `isValidIbanFormat` mod-97 checksum. */
  invalidIban: "invalid_iban",
  /** decisions/0034: an entry in the extended profile's domain list does not look like a host
   * once normalized (`normalizeCompanyDomain` below). */
  invalidDomain: "invalid_domain",
} as const;
export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR)[keyof typeof WORKSPACE_ERROR];

export const WORKSPACE_NAME_MIN_LENGTH = 1;
export const WORKSPACE_NAME_MAX_LENGTH = 120;

/** decisions/0034-extended-company-profile.md: caps on the extended profile's three list
 * fields (aliases/IBANs/domains) - a small business's own aliases/accounts/domains, never
 * meant to hold more than a handful of entries. */
export const MAX_COMPANY_PROFILE_LIST_ENTRIES = 20;
/** An alias shorter than this is always rejected by `isGenericCompanyAlias` regardless of
 * whether it also happens to be a legal-form token - a 1-2 character alias is exactly the
 * kind of over-broad whole-name match decisions/0034's guard exists to prevent. */
export const COMPANY_ALIAS_MIN_LENGTH = 3;
/** `companyProfileText`'s max length (decisions/0034): free text that only ever helps the
 * model find things (never decides anything on its own), so a generous but bounded size. */
export const COMPANY_PROFILE_TEXT_MAX_LENGTH = 1000;

/** Cap on pending invitations per workspace at once (PRD). */
export const MAX_PENDING_INVITATIONS = 50;

/** Invitation lifetime (PRD). */
export const INVITATION_EXPIRES_IN_DAYS = 7;

export type Role = WorkspaceMemberRow["role"];

export type Workspace = { id: string; name: string; tier: WorkspaceRow["tier"]; createdAt: Date };

export type MembershipWithWorkspace = { membershipId: string; role: Role; workspace: Workspace };

export type WorkspaceMemberView = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: Date;
};

export type PendingInvitationView = { id: string; email: string; expiresAt: Date; createdAt: Date };

/** `inviterEmail` is `null` when the inviting user's account has since been deleted (P6
 * review finding A9: `invitedByUserId` is nullable, `onDelete: "set null"`). */
export type InvitationPreview = { workspaceName: string; inviterEmail: string | null; email: string; expiresAt: Date };

/** The workspace's own company profile (decisions/0019-contacts.md's own-company exclusion,
 * extended by decisions/0034-extended-company-profile.md): `name` is `workspaces.name` itself
 * (the company name); the rest are the `company_*` columns. C2 wires an onboarding step and a
 * settings page around `getCompanyProfile`/`updateCompanyProfile` below; `@/modules/contacts`'s
 * pure `isOwnCompany(extracted, ownCompany)` is what the processing pipeline calls with a
 * mapped `OwnCompanyProfile` shape (`toOwnCompanyProfile`,
 * `src/persistence/use-cases/documents-use-cases.ts`) to decide whether an extracted contact
 * is the workspace itself. `aliases`/`ibans`/`domains`/`taxNumber`/`registerCourt`/
 * `registerNumber`/`profileText` are H1's extended profile (decisions/0034): `aliases` are
 * stored trimmed and de-duplicated (original casing kept, exactly as the admin typed them -
 * `toOwnCompanyProfile` is where they get normalized with `normalizeName` for matching);
 * `ibans`/`domains` are stored already normalized (`normalizeIban`/`normalizeCompanyDomain`),
 * since normalizing either loses no information worth showing back to the admin. */
export type CompanyProfile = {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  aliases: string[];
  ibans: string[];
  domains: string[];
  taxNumber: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  profileText: string | null;
};

export interface WorkspaceUseCases {
  /** Creates a new workspace and makes `userId` its admin. A user may own several
   * (decisions/0070-several-workspaces-per-user.md: "Weitere Firma anlegen"), so an existing
   * membership elsewhere is no longer a rejection reason - a brand-new workspace cannot
   * collide with one the caller is already in. */
  createForUser(input: { userId: string; name: string }): Promise<{ workspace: Workspace; role: Role }>;
  /** Every workspace `userId` belongs to, oldest membership first - the list the workspace
   * switcher renders and the one `resolveAccess` picks the active workspace from
   * (decisions/0070-several-workspaces-per-user.md). Empty when the user belongs to none. */
  listMembershipsForUser(userId: string): Promise<MembershipWithWorkspace[]>;
  /** `userId`'s membership in ONE named workspace, or `null` if they have none there. The
   * database-backed gate behind the active-workspace cookie and
   * `switchWorkspaceAction` (decisions/0070-several-workspaces-per-user.md): a workspace id
   * that comes from client input is only ever usable once this returns a row for it. `null`
   * both for "no such workspace" and "not a member of it" - a caller must not be able to
   * tell those apart. */
  getMembershipInWorkspace(input: { userId: string; workspaceId: string }): Promise<MembershipWithWorkspace | null>;
  /** The caller's DEFAULT workspace: their oldest membership, or `null` if they belong to
   * none yet (the `/onboarding` gate). `resolveAccess`'s fallback whenever the
   * active-workspace cookie is absent, malformed, or names a workspace the user is not a
   * member of (decisions/0070-several-workspaces-per-user.md). */
  getMembershipForUser(userId: string): Promise<MembershipWithWorkspace | null>;
  /** `null` if the workspace does not exist; `adminEmail` is `null` only in the
   * theoretically-impossible case of a workspace with no admin member (the partial unique
   * index guarantees at most one, never zero, once `createForUser` has run - `removeMember`
   * never allows removing the sole admin either). Read by
   * `src/persistence/composition/job-handlers.ts`'s `send-quota-warning` handler (P3,
   * decisions/0017-billing-tiers-and-packages.md) to address and personalize the 80%
   * warning e-mail. */
  getWorkspaceWithAdminContact(workspaceId: string): Promise<{ workspace: Workspace; adminEmail: string | null } | null>;
  listMembers(workspaceId: string): Promise<{ members: WorkspaceMemberView[]; invitations: PendingInvitationView[] }>;
  /** Invites `email` to `workspaceId`. Replaces any existing pending invitation for the
   * same email (re-inviting), enforces the pending-invitation cap, and returns the plain
   * token exactly once (only ever stored hashed) so the caller can build the e-mail link. */
  invite(input: {
    workspaceId: string;
    invitedByUserId: string;
    email: string;
  }): Promise<{ invitationId: string; token: string; email: string; expiresAt: Date; createdAt: Date }>;
  revokeInvitation(input: { workspaceId: string; invitationId: string }): Promise<void>;
  /** `actorMembershipId` is the caller's own membership id; removing it directly fails
   * with `cannot_remove_self` before ever reaching the repository. */
  removeMember(input: { workspaceId: string; actorMembershipId: string; memberId: string }): Promise<void>;
  /** F5 (decisions/0027-hardening-and-deletion.md): a non-admin member leaves their own
   * workspace ("Arbeitsbereich verlassen") - the same membership cleanup as `removeMember`,
   * but self-initiated and rejecting the workspace's own admin
   * with `cannot_leave_as_admin` before ever touching the repository (mirroring
   * `removeMember`'s own `cannot_remove_self` pre-check shape). */
  leaveWorkspace(input: { workspaceId: string; membershipId: string }): Promise<void>;
  /** F5 (decisions/0027-hardening-and-deletion.md): permanently deletes the ENTIRE workspace
   * - every document, job, contact, account, transaction, settlement line, invitation,
   * membership, usage/purchase record, and intake fingerprint it owns (every workspace-owned
   * table's foreign key to `workspaces.id` is `onDelete: "cascade"`, so `repos.workspace.delete`
   * alone removes all of it in one statement). `confirmName` must exactly match the
   * workspace's current name (a typed confirmation, re-checked here as the last line of
   * defense even though the Server Action's UI already required it) or this throws
   * `confirmation_mismatch` without deleting anything. Also enqueues the durable
   * `cleanup-workspace-storage` job (§`JOB_KINDS.cleanupWorkspaceStorage`) inside the SAME
   * transaction as the row delete, with `workspaceId: null` so the job survives the very
   * cascade it is cleaning up after - the caller (the Server Action) additionally attempts an
   * immediate, synchronous best-effort object-storage cleanup right after this returns, but
   * that attempt can fail or the process can crash before it runs at all, and the enqueued job
   * is what makes cleanup eventually-durable regardless. Returns the object-storage prefix
   * (`workspaces/<id>/`) the caller should also try to clean up immediately. `not_found` if
   * the workspace does not exist (a concurrent deletion, or a stale id). */
  deleteWorkspace(input: { workspaceId: string; confirmName: string }): Promise<{ storagePrefix: string }>;
  /** Read-only lookup for the `/invite/[token]` page before the invitee has signed in or
   * accepted anything. Throws the same stable codes `acceptInvitation` would. */
  previewInvitation(token: string): Promise<InvitationPreview>;
  /** Accepts a pending invitation: validates it (found, unexpired, unused, addressed to
   * `userEmail`) and that `userId` is not already a member OF THAT WORKSPACE
   * (decisions/0070-several-workspaces-per-user.md - a membership in some other workspace is
   * expected and fine), then marks it accepted and inserts the membership in one
   * transaction. */
  acceptInvitation(input: { token: string; userId: string; userEmail: string }): Promise<{ workspaceId: string }>;
  /** `null` if the workspace does not exist. Permission-gated by the caller (admin-only,
   * `PERMISSIONS.companyProfileManage`), not by this use case. */
  getCompanyProfile(workspaceId: string): Promise<CompanyProfile | null>;
  /** Admin-only (enforced by the caller's Server Action via `src/platform/access`,
   * `PERMISSIONS.companyProfileManage`). All fields optional/nullable; a blank/absent
   * `country` defaults to `"DE"`, matching `contacts.country`'s own default. `not_found` if
   * the workspace does not exist.
   *
   * decisions/0034-extended-company-profile.md's extended fields: `aliases`/`ibans`/`domains`
   * are normalized here (trimmed + de-duplicated / `normalizeIban`'d /
   * `normalizeCompanyDomain`'d respectively) before being handed to the repository, which
   * never normalizes anything itself. Throws `alias_too_generic` for an alias that is too
   * short or normalizes to a bare legal form (`isGenericCompanyAlias`), `invalid_iban` for an
   * entry that fails `isValidIbanFormat`, `invalid_domain` for one that does not look like a
   * host once normalized - each checked BEFORE any write, so a single bad entry never leaves
   * the profile partially updated. `profileText` is trimmed and never consulted by
   * `isOwnCompany` itself (the central "structured data decides, free text only helps the
   * model" rule); a blank/absent value clears it. */
  updateCompanyProfile(input: {
    workspaceId: string;
    addressLine1?: string | null;
    addressLine2?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
    vatId?: string | null;
    aliases?: readonly string[];
    ibans?: readonly string[];
    domains?: readonly string[];
    taxNumber?: string | null;
    registerCourt?: string | null;
    registerNumber?: string | null;
    profileText?: string | null;
  }): Promise<CompanyProfile>;
  /** decisions/0044: sets which payment suggestions are confirmed without a human. The caller
   * checks `finance.manage`; an unknown mode is rejected. */
  setPaymentAutoConfirm(input: { workspaceId: string; mode: PaymentAutoConfirmMode }): Promise<void>;
  /** decisions/0037-correction-buttons.md: "Das sind wir" - adds a single name to the
   * company profile's `aliases` list, reusing `updateCompanyProfile`'s own alias
   * normalization/validation exactly (`normalizeCompanyAliases`, `isGenericCompanyAlias`,
   * `MAX_COMPANY_PROFILE_LIST_ENTRIES`), so it throws the same `alias_too_generic`/
   * `invalid_input` codes. Idempotent: an alias that already matches an existing one
   * case-insensitively is a no-op success (the profile is returned unchanged) - this is what
   * lets several duplicate contacts sharing the same brand name each be corrected one at a
   * time. Admin-only, enforced by the caller (`PERMISSIONS.companyProfileManage`), not here.
   * `not_found` if the workspace does not exist. */
  addCompanyAlias(input: { workspaceId: string; alias: string }): Promise<CompanyProfile>;
  /** decisions/0037-correction-buttons.md: "Das ist unsere Bank" - adds a single IBAN to the
   * company profile's own `ibans` list, reusing the same mod-97 validation
   * (`@/modules/contacts`'s `isValidIbanFormat`) `updateCompanyProfile`'s own IBAN list uses,
   * throwing `invalid_iban` for a blank or malformed value. Idempotent: an IBAN that already
   * normalizes to an existing entry is a no-op success. Admin-only, enforced by the caller,
   * not here. `not_found` if the workspace does not exist. */
  addCompanyIban(input: { workspaceId: string; iban: string }): Promise<CompanyProfile>;
}

function normalizedName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new UseCaseError(WORKSPACE_ERROR.invalidInput);
  }
  return trimmed;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, tier: row.tier, createdAt: row.createdAt };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

/** decisions/0034-extended-company-profile.md: strips a URL scheme, a leading "www.", any
 * path/query/fragment, and a trailing port, then lowercases - "https://www.musterfirma.de/x"
 * and "MUSTERFIRMA.de:443" both become "musterfirma.de". Pure text manipulation only: it does NOT
 * validate the result actually looks like a host (`isLikelyCompanyHost` below does that
 * separately, so `updateCompanyProfile` can reject a malformed entry with its own error code
 * instead of silently storing garbage). */
export function normalizeCompanyDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/, 1)[0] ?? value;
  value = value.replace(/^www\./, "");
  value = value.split(":", 1)[0] ?? value;
  return value;
}

const COMPANY_HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Whether an already-`normalizeCompanyDomain`d value looks like a real host (at least one
 * label, at least one dot, only host-legal characters) - loose on purpose, the same "a false
 * 'invalid' is worse than a missed one" reasoning `@/modules/contacts`'s `isPlausibleVatId`
 * documents for a foreign VAT id: this repository has no per-TLD validation table. */
export function isLikelyCompanyHost(value: string): boolean {
  return COMPANY_HOST_PATTERN.test(value);
}

/** decisions/0034: trims every entry, drops now-empty ones, then de-duplicates
 * case-insensitively while keeping the FIRST occurrence's own casing - so "Musterfirma" typed
 * once is what the settings form shows back on reload, not a later duplicate's casing. */
export function normalizeCompanyAliases(raw: readonly string[]): string[] {
  const seenKeys = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    result.push(trimmed);
  }
  return result;
}

/** Bare legal-form tokens (already normalized the same way `isGenericCompanyAlias` below
 * normalizes its input): lowercase, punctuation collapsed to spaces, umlauts/ß kept intact -
 * deliberately the same shape as `@/modules/contacts/core/normalizers.ts`'s own
 * `LEGAL_FORM_SUFFIXES` list (that list is private to that file, and its job - stripping a
 * suffix off the END of a longer name - is a different check than this one - is the WHOLE
 * alias nothing but a legal form - so it is not reused directly), plus `"gbr"`, which that
 * list has no need for since a GbR's legal form rarely doubles as a matching suffix there. */
const GENERIC_ALIAS_TOKENS = new Set([
  "gbr",
  "gmbh co kg",
  "gmbh co",
  "gmbh",
  "mbh",
  "ag co kg",
  "ag",
  "kg",
  "ohg",
  "ug haftungsbeschraenkt",
  "ug",
  "e k",
  "ek",
  "e v",
  "ev",
  "co kg",
]);

/** decisions/0034's generic-alias guard: `true` for an alias shorter than
 * `COMPANY_ALIAS_MIN_LENGTH` after trimming, or one that normalizes to nothing but a bare
 * legal form ("GbR", "GmbH & Co. KG", "e.K.", ...). `isOwnCompany`'s alias rule is a
 * whole-name match (never a substring), so an alias this generic would match every company
 * sharing that legal form, not just this workspace's own - a whole-name match on "GbR" would
 * swallow every GbR in Germany. `trimmedAlias` is expected already trimmed, the same value
 * `normalizeCompanyAliases` produces. */
export function isGenericCompanyAlias(trimmedAlias: string): boolean {
  if (trimmedAlias.length < COMPANY_ALIAS_MIN_LENGTH) return true;
  const normalized = trimmedAlias
    .toLowerCase()
    .replace(/[.,;:!?'"()/\\_&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return GENERIC_ALIAS_TOKENS.has(normalized);
}

/** decisions/0034: validates and normalizes the extended profile's IBAN list, throwing
 * `invalid_iban` on the first entry that fails `@/modules/contacts`'s mod-97 format check -
 * checked before any write, so a single bad IBAN never leaves the profile partially saved. */
function normalizeCompanyIbans(raw: readonly string[]): string[] {
  const result: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!isValidIbanFormat(trimmed)) throw new UseCaseError(WORKSPACE_ERROR.invalidIban);
    result.push(normalizeIban(trimmed));
  }
  return result;
}

/** decisions/0034: validates and normalizes the extended profile's domain list, throwing
 * `invalid_domain` on the first entry that does not look like a host once normalized. */
function normalizeCompanyDomains(raw: readonly string[]): string[] {
  const result: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalized = normalizeCompanyDomain(trimmed);
    if (!isLikelyCompanyHost(normalized)) throw new UseCaseError(WORKSPACE_ERROR.invalidDomain);
    result.push(normalized);
  }
  return result;
}

/** decisions/0034: validates the extended profile's alias list, throwing `alias_too_generic`
 * on the first entry `isGenericCompanyAlias` rejects. Normalization (trim + de-dup) already
 * happened via `normalizeCompanyAliases` before this runs. */
function assertAliasesNotGeneric(aliases: readonly string[]): void {
  for (const alias of aliases) {
    if (isGenericCompanyAlias(alias)) throw new UseCaseError(WORKSPACE_ERROR.aliasTooGeneric);
  }
}

/** Shared by `removeMember` (an admin removes someone else) and `leaveWorkspace` (a member
 * removes themself): deletes the membership row inside the caller's own transaction - kept as
 * its own function (rather than inlined at both call sites) so `leaveWorkspace` gets the exact
 * same `not_found` handling as `removeMember` without duplicating it. */
async function deleteMembershipAndCleanUp(repos: Repositories, workspaceId: string, memberId: string): Promise<void> {
  const row = await repos.workspaceMember.deleteById(workspaceId, memberId);
  if (!row) throw new UseCaseError(WORKSPACE_ERROR.notFound);
}

/** decisions/0037-correction-buttons.md: the current row's own company-profile columns as a
 * full `CompanyProfileFields`, unchanged - `addCompanyAlias`/`addCompanyIban` start from this
 * and only ever replace ONE list field, since `WorkspaceRepository.updateCompanyProfile`
 * always writes every column (no partial `update` in the contract), the same reason
 * `updateCompanyProfile` above always builds a full `CompanyProfileFields` object itself. */
function companyProfileFieldsFromRow(row: WorkspaceRow): CompanyProfileFields {
  return {
    companyAddressLine1: row.companyAddressLine1,
    companyAddressLine2: row.companyAddressLine2,
    companyPostalCode: row.companyPostalCode,
    companyCity: row.companyCity,
    companyCountry: row.companyCountry,
    companyVatId: row.companyVatId,
    companyAliases: row.companyAliases,
    companyIbans: row.companyIbans,
    companyDomains: row.companyDomains,
    companyTaxNumber: row.companyTaxNumber,
    companyRegisterCourt: row.companyRegisterCourt,
    companyRegisterNumber: row.companyRegisterNumber,
    companyProfileText: row.companyProfileText,
  };
}

function toCompanyProfile(row: WorkspaceRow): CompanyProfile {
  return {
    name: row.name,
    addressLine1: row.companyAddressLine1,
    addressLine2: row.companyAddressLine2,
    postalCode: row.companyPostalCode,
    city: row.companyCity,
    country: row.companyCountry,
    vatId: row.companyVatId,
    aliases: row.companyAliases,
    ibans: row.companyIbans,
    domains: row.companyDomains,
    taxNumber: row.companyTaxNumber,
    registerCourt: row.companyRegisterCourt,
    registerNumber: row.companyRegisterNumber,
    profileText: row.companyProfileText,
  };
}

export function createWorkspaceUseCases(deps: {
  repos: Repositories;
  uow: UnitOfWork;
  now?: () => Date;
  generateToken?: () => string;
}): WorkspaceUseCases {
  const now = deps.now ?? (() => new Date());
  const generateToken = deps.generateToken ?? (() => randomBytes(32).toString("hex"));

  /** Declared here rather than as a method so `getMembershipForUser` can reuse it without
   * going through `this` (these use cases are routinely destructured by callers). */
  async function listMembershipsForUser(userId: string): Promise<MembershipWithWorkspace[]> {
    const rows = await deps.repos.workspaceMember.listByUserIdWithWorkspace(userId);
    return rows.map(({ member, workspace }) => ({
      membershipId: member.id,
      role: member.role,
      workspace: toWorkspace(workspace),
    }));
  }

  return {
    async createForUser({ userId, name }) {
      const trimmed = normalizedName(name);

      // decisions/0070-several-workspaces-per-user.md: no "do you already have one?"
      // pre-check any more. The workspace row is created in this very transaction, so the
      // composite unique on `(workspace_id, user_id)` can never be violated here - the only
      // membership that can exist for it is the one inserted right below.
      return await deps.uow.transaction(async (repos) => {
        const workspace = await repos.workspace.create({ name: trimmed });
        await repos.workspaceMember.create({ workspaceId: workspace.id, userId, role: "admin" });
        return { workspace: toWorkspace(workspace), role: "admin" as const };
      });
    },

    listMembershipsForUser,

    async getMembershipInWorkspace({ userId, workspaceId }) {
      const member = await deps.repos.workspaceMember.findByWorkspaceAndUser(workspaceId, userId);
      if (!member) return null;
      const workspace = await deps.repos.workspace.findById(workspaceId);
      if (!workspace) return null;
      return { membershipId: member.id, role: member.role, workspace: toWorkspace(workspace) };
    },

    async getMembershipForUser(userId) {
      const [oldest] = await listMembershipsForUser(userId);
      return oldest ?? null;
    },

    async getWorkspaceWithAdminContact(workspaceId) {
      const workspace = await deps.repos.workspace.findById(workspaceId);
      if (!workspace) return null;
      const members = await deps.repos.workspaceMember.listByWorkspace(workspaceId);
      const admin = members.find((m) => m.role === "admin");
      return { workspace: toWorkspace(workspace), adminEmail: admin?.email ?? null };
    },

    async listMembers(workspaceId) {
      const [members, invitations] = await Promise.all([
        deps.repos.workspaceMember.listByWorkspace(workspaceId),
        deps.repos.workspaceInvitation.listPendingByWorkspace(workspaceId),
      ]);
      return {
        members: members.map((m) => ({
          id: m.id,
          userId: m.userId,
          email: m.email,
          name: m.name,
          role: m.role,
          joinedAt: m.joinedAt,
        })),
        invitations: invitations.map((i) => ({
          id: i.id,
          email: i.email,
          expiresAt: i.expiresAt,
          createdAt: i.createdAt,
        })),
      };
    },

    async invite({ workspaceId, invitedByUserId, email }) {
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) throw new UseCaseError(WORKSPACE_ERROR.invalidInput);

      const token = generateToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(now().getTime() + INVITATION_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);

      const invitation = await deps.uow.transaction(async (repos) => {
        // Lock the workspace row first (same pattern as `documents-use-cases.ts`'s upload
        // quota check) so two concurrent invites for the same workspace serialize against
        // the pending-invitation cap instead of racing (P6 review finding A6: without this
        // lock, two concurrent invites can both read a pending count of
        // MAX_PENDING_INVITATIONS - 1 and both succeed, exceeding the cap).
        const lockedWorkspace = await repos.workspace.lockForUpdate(workspaceId);
        if (!lockedWorkspace) throw new UseCaseError(WORKSPACE_ERROR.notFound);

        // Delete any existing pending invitation for this email first (re-inviting
        // replaces it), so it never counts against the cap below.
        await repos.workspaceInvitation.deletePendingByEmail(workspaceId, normalizedEmail);

        const pendingCount = await repos.workspaceInvitation.countPending(workspaceId);
        if (pendingCount >= MAX_PENDING_INVITATIONS) {
          throw new UseCaseError(WORKSPACE_ERROR.invitationCapReached);
        }

        return repos.workspaceInvitation.create({
          workspaceId,
          email: normalizedEmail,
          tokenHash,
          invitedByUserId,
          expiresAt,
        });
      });

      return {
        invitationId: invitation.id,
        token,
        email: normalizedEmail,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      };
    },

    async revokeInvitation({ workspaceId, invitationId }) {
      const row = await deps.repos.workspaceInvitation.deleteById(workspaceId, invitationId);
      if (!row) throw new UseCaseError(WORKSPACE_ERROR.notFound);
    },

    async removeMember({ workspaceId, actorMembershipId, memberId }) {
      if (actorMembershipId === memberId) throw new UseCaseError(WORKSPACE_ERROR.cannotRemoveSelf);

      await deps.uow.transaction(async (repos) => {
        await deleteMembershipAndCleanUp(repos, workspaceId, memberId);
      });
    },

    async leaveWorkspace({ workspaceId, membershipId }) {
      await deps.uow.transaction(async (repos) => {
        const membership = await repos.workspaceMember.findById(workspaceId, membershipId);
        if (!membership) throw new UseCaseError(WORKSPACE_ERROR.notFound);
        if (membership.role === "admin") throw new UseCaseError(WORKSPACE_ERROR.cannotLeaveAsAdmin);
        await deleteMembershipAndCleanUp(repos, workspaceId, membershipId);
      });
    },

    async deleteWorkspace({ workspaceId, confirmName }) {
      let storagePrefix: string | undefined;

      await deps.uow.transaction(async (repos) => {
        // Locked, not a plain `findById`: two concurrent delete attempts (two browser tabs,
        // a double-click) must not both proceed past the confirmation check only for one of
        // `repos.workspace.delete`'s two `RETURNING` calls to silently find nothing.
        const workspace = await repos.workspace.lockForUpdate(workspaceId);
        if (!workspace) throw new UseCaseError(WORKSPACE_ERROR.notFound);
        if (workspace.name.trim() !== confirmName.trim()) {
          throw new UseCaseError(WORKSPACE_ERROR.confirmationMismatch);
        }

        const deleted = await repos.workspace.delete(workspaceId);
        if (!deleted) throw new UseCaseError(WORKSPACE_ERROR.notFound);

        // Computed from the just-deleted row's own id (always a real database `uuid`), not
        // the raw input, so a malformed `workspaceId` fails as `not_found` above rather than
        // as a confusing `InvalidObjectKeySegmentError` from the key builder.
        storagePrefix = workspaceStoragePrefix(deleted.id);

        // Durable retry for the object-storage cleanup (decisions/0027's "Cascade
        // verification"/"Storage cleanup" sections): `workspaceId: null` on purpose - the
        // workspace this job is cleaning up after no longer exists by the time it runs, and
        // `jobs.workspace_id` cascades from `workspaces.id` like everything else, so a
        // non-null value here would delete this very job in the same statement that creates
        // the need for it.
        await repos.jobs.enqueue({
          kind: JOB_KINDS.cleanupWorkspaceStorage,
          workspaceId: null,
          payload: { prefix: storagePrefix },
        });
      });

      // `storagePrefix` is always set by the time the transaction above returns without
      // throwing (every throwing path returns before it is assigned) - the `undefined` case
      // is unreachable, not a real runtime possibility.
      if (!storagePrefix) throw new UseCaseError(WORKSPACE_ERROR.notFound);
      return { storagePrefix };
    },

    async previewInvitation(token) {
      const tokenHash = hashToken(token);
      const details = await deps.repos.workspaceInvitation.findByTokenHashWithDetails(tokenHash);
      if (!details) throw new UseCaseError(WORKSPACE_ERROR.invitationNotFound);
      const { invitation, workspaceName, inviterEmail } = details;
      if (invitation.acceptedAt) throw new UseCaseError(WORKSPACE_ERROR.invitationAlreadyUsed);
      if (invitation.expiresAt.getTime() < now().getTime()) throw new UseCaseError(WORKSPACE_ERROR.invitationExpired);
      return { workspaceName, inviterEmail, email: invitation.email, expiresAt: invitation.expiresAt };
    },

    async acceptInvitation({ token, userId, userEmail }) {
      const tokenHash = hashToken(token);

      try {
        return await deps.uow.transaction(async (repos) => {
          const invitation = await repos.workspaceInvitation.findByTokenHash(tokenHash);
          if (!invitation) throw new UseCaseError(WORKSPACE_ERROR.invitationNotFound);
          if (invitation.acceptedAt) throw new UseCaseError(WORKSPACE_ERROR.invitationAlreadyUsed);
          if (invitation.expiresAt.getTime() < now().getTime()) throw new UseCaseError(WORKSPACE_ERROR.invitationExpired);
          if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
            throw new UseCaseError(WORKSPACE_ERROR.invitationEmailMismatch);
          }

          // decisions/0070-several-workspaces-per-user.md: belonging to ANOTHER workspace is
          // fine now (that is the whole point of the feature) - only being in THIS one
          // already is a rejection, and `already_in_workspace` means exactly that from here
          // on. The `isDbError(err, "unique")` catch below is the composite unique index
          // backing this same check against a concurrent double-accept.
          const existingMembership = await repos.workspaceMember.findByWorkspaceAndUser(invitation.workspaceId, userId);
          if (existingMembership) throw new UseCaseError(WORKSPACE_ERROR.alreadyInWorkspace);

          const accepted = await repos.workspaceInvitation.markAccepted(invitation.id, now());
          if (!accepted) throw new UseCaseError(WORKSPACE_ERROR.invitationAlreadyUsed);

          await repos.workspaceMember.create({ workspaceId: invitation.workspaceId, userId, role: "member" });
          return { workspaceId: invitation.workspaceId };
        });
      } catch (err) {
        if (isDbError(err, "unique")) throw new UseCaseError(WORKSPACE_ERROR.alreadyInWorkspace);
        throw err;
      }
    },

    async getCompanyProfile(workspaceId) {
      const row = await deps.repos.workspace.findById(workspaceId);
      if (!row) return null;
      return toCompanyProfile(row);
    },

    async setPaymentAutoConfirm({ workspaceId, mode }) {
      if (!isPaymentAutoConfirmMode(mode)) throw new UseCaseError(WORKSPACE_ERROR.invalidInput);
      const row = await deps.repos.workspace.updatePaymentAutoConfirm(workspaceId, mode);
      if (!row) throw new UseCaseError(WORKSPACE_ERROR.notFound);
    },

    async updateCompanyProfile({
      workspaceId,
      addressLine1,
      addressLine2,
      postalCode,
      city,
      country,
      vatId,
      aliases,
      ibans,
      domains,
      taxNumber,
      registerCourt,
      registerNumber,
      profileText,
    }) {
      // Normalized/validated BEFORE any write (each throws its own stable code on the first
      // bad entry) - decisions/0034's own rule: a single malformed alias/IBAN/domain must
      // never leave the rest of the profile partially saved. The entry-count cap is re-checked
      // here too (not only by the action's own Zod schema), same "last line of defense" rule
      // as `companyProfileText`'s length above.
      if (
        (aliases?.length ?? 0) > MAX_COMPANY_PROFILE_LIST_ENTRIES ||
        (ibans?.length ?? 0) > MAX_COMPANY_PROFILE_LIST_ENTRIES ||
        (domains?.length ?? 0) > MAX_COMPANY_PROFILE_LIST_ENTRIES
      ) {
        throw new UseCaseError(WORKSPACE_ERROR.invalidInput);
      }
      const normalizedAliases = normalizeCompanyAliases(aliases ?? []);
      assertAliasesNotGeneric(normalizedAliases);
      const normalizedIbans = normalizeCompanyIbans(ibans ?? []);
      const normalizedDomains = normalizeCompanyDomains(domains ?? []);

      const row = await deps.repos.workspace.updateCompanyProfile(workspaceId, {
        companyAddressLine1: trimmedOrNull(addressLine1),
        companyAddressLine2: trimmedOrNull(addressLine2),
        companyPostalCode: trimmedOrNull(postalCode),
        companyCity: trimmedOrNull(city),
        companyCountry: country?.trim() ? country.trim().toUpperCase() : "DE",
        companyVatId: trimmedOrNull(vatId),
        companyAliases: normalizedAliases,
        companyIbans: normalizedIbans,
        companyDomains: normalizedDomains,
        companyTaxNumber: trimmedOrNull(taxNumber),
        companyRegisterCourt: trimmedOrNull(registerCourt),
        companyRegisterNumber: trimmedOrNull(registerNumber),
        // Sliced here too (not only Zod's `.max()`), the same "use cases are the last line of
        // defense" discipline this file's header comment states - a caller bypassing the
        // action's own Zod schema must still never write more than the documented cap.
        companyProfileText: trimmedOrNull(profileText)?.slice(0, COMPANY_PROFILE_TEXT_MAX_LENGTH) ?? null,
      });
      if (!row) throw new UseCaseError(WORKSPACE_ERROR.notFound);
      return toCompanyProfile(row);
    },

    async addCompanyAlias({ workspaceId, alias }) {
      return deps.uow.transaction(async (repos) => {
        // Locked, not a plain `findById` (the same reasoning as `invite`'s own lock above):
        // two of the observed defect's three "Musterfirma" contacts corrected in quick
        // succession must not both read the profile before either one's alias is saved.
        const workspace = await repos.workspace.lockForUpdate(workspaceId);
        if (!workspace) throw new UseCaseError(WORKSPACE_ERROR.notFound);

        // `normalizeCompanyAliases` both re-normalizes the already-stored aliases (a no-op,
        // they were normalized the same way on their own way in) and de-duplicates the new
        // one against them case-insensitively - the idempotency `updateCompanyProfile` itself
        // never needed, since a caller resubmitting the same list is a different use case
        // from repeatedly clicking "Das sind wir" on separate duplicate contacts.
        const merged = normalizeCompanyAliases([...workspace.companyAliases, alias]);
        if (merged.length > MAX_COMPANY_PROFILE_LIST_ENTRIES) throw new UseCaseError(WORKSPACE_ERROR.invalidInput);
        assertAliasesNotGeneric(merged);

        const row = await repos.workspace.updateCompanyProfile(workspaceId, {
          ...companyProfileFieldsFromRow(workspace),
          companyAliases: merged,
        });
        if (!row) throw new UseCaseError(WORKSPACE_ERROR.notFound);
        return toCompanyProfile(row);
      });
    },

    async addCompanyIban({ workspaceId, iban }) {
      const trimmed = iban.trim();
      if (!trimmed || !isValidIbanFormat(trimmed)) throw new UseCaseError(WORKSPACE_ERROR.invalidIban);
      const normalized = normalizeIban(trimmed);

      return deps.uow.transaction(async (repos) => {
        const workspace = await repos.workspace.lockForUpdate(workspaceId);
        if (!workspace) throw new UseCaseError(WORKSPACE_ERROR.notFound);

        const merged = workspace.companyIbans.includes(normalized) ? workspace.companyIbans : [...workspace.companyIbans, normalized];
        if (merged.length > MAX_COMPANY_PROFILE_LIST_ENTRIES) throw new UseCaseError(WORKSPACE_ERROR.invalidInput);

        const row = await repos.workspace.updateCompanyProfile(workspaceId, {
          ...companyProfileFieldsFromRow(workspace),
          companyIbans: merged,
        });
        if (!row) throw new UseCaseError(WORKSPACE_ERROR.notFound);
        return toCompanyProfile(row);
      });
    },
  };
}
