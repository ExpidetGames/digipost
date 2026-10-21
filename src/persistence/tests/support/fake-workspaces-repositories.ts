// Typed in-memory fakes for `WorkspaceRepository`/`WorkspaceMemberRepository`/
// `WorkspaceInvitationRepository` (WEBAPP_TEMPLATE_SPEC.md §10.2): unit tests for
// `createWorkspaceUseCases` inject these instead of mocking with `vi.fn()`/`as never`
// casts. Changing a repository contract breaks this file at compile time, which is the
// point: a fake that silently drifts from the real contract is worse than no fake.
import type {
  CreateInvitationRow,
  CreateMembershipRow,
  CreateWorkspaceRow,
  WorkspaceInvitationRepository,
  WorkspaceInvitationRow,
  WorkspaceMemberRepository,
  WorkspaceMemberRow,
  WorkspaceRepository,
  WorkspaceRow,
} from "@/persistence/repositories/contracts";

/** A `pg`-shaped error `isDbError`/`dbErrorOf` (src/persistence/foundation/db-errors.ts) recognizes. */
export function fakeDbError(code: string, constraint: string | null = null): Error & { code: string; constraint: string | null } {
  const err = new Error(`fake db error ${code}`) as Error & { code: string; constraint: string | null };
  err.code = code;
  err.constraint = constraint;
  return err;
}

export function workspaceRow(overrides: Partial<WorkspaceRow> & Pick<WorkspaceRow, "name">): WorkspaceRow {
  return {
    id: crypto.randomUUID(),
    tier: "free",
    paymentAutoConfirm: "system",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    // Company profile (decisions/0019-contacts.md): every workspace created before this
    // phase has none yet, so the fake's default matches that.
    companyAddressLine1: null,
    companyAddressLine2: null,
    companyPostalCode: null,
    companyCity: null,
    companyCountry: null,
    companyVatId: null,
    // Extended company profile (decisions/0034-extended-company-profile.md): same "nothing
    // filled in yet" default as the rest of the company profile above.
    companyAliases: [],
    companyIbans: [],
    companyDomains: [],
    companyTaxNumber: null,
    companyRegisterCourt: null,
    companyRegisterNumber: null,
    companyProfileText: null,
    ...overrides,
  };
}

export function memberRow(
  overrides: Partial<WorkspaceMemberRow> & Pick<WorkspaceMemberRow, "workspaceId" | "userId" | "role">,
): WorkspaceMemberRow {
  return {
    id: crypto.randomUUID(),
    joinedAt: new Date(0),
    ...overrides,
  };
}

export function invitationRow(
  overrides: Partial<WorkspaceInvitationRow> &
    Pick<WorkspaceInvitationRow, "workspaceId" | "email" | "tokenHash" | "invitedByUserId" | "expiresAt">,
): WorkspaceInvitationRow {
  return {
    id: crypto.randomUUID(),
    acceptedAt: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

export function createFakeWorkspaceRepository(seed: WorkspaceRow[] = []): { repo: WorkspaceRepository; state: WorkspaceRow[] } {
  const rows = [...seed];

  const repo: WorkspaceRepository = {
    async create(input: CreateWorkspaceRow) {
      const row = workspaceRow(input);
      rows.push(row);
      return row;
    },
    async findById(id) {
      return rows.find((w) => w.id === id) ?? null;
    },
    async lockForUpdate(id) {
      // No real locking semantics in-memory: fakes exercise use-case logic, not concurrency
      // (that is `src/persistence/tests/documents-repository.db.test.ts`'s job).
      return rows.find((w) => w.id === id) ?? null;
    },
    async updateTier(id, tier) {
      const row = rows.find((w) => w.id === id);
      if (!row) return null;
      row.tier = tier;
      row.updatedAt = new Date();
      return row;
    },
    async updatePaymentAutoConfirm(id, mode) {
      const row = rows.find((w) => w.id === id);
      if (!row) return null;
      row.paymentAutoConfirm = mode;
      row.updatedAt = new Date();
      return row;
    },
    async updateCompanyProfile(id, fields) {
      const row = rows.find((w) => w.id === id);
      if (!row) return null;
      Object.assign(row, fields);
      row.updatedAt = new Date();
      return row;
    },
    async delete(id) {
      const index = rows.findIndex((w) => w.id === id);
      if (index === -1) return null;
      const [row] = rows.splice(index, 1);
      return row ?? null;
    },
  };

  return { repo, state: rows };
}

/** `workspaces` is the live row array `createFakeWorkspaceRepository` returns as its own
 * `state` (decisions/0070-several-workspaces-per-user.md): `listByUserIdWithWorkspace` is a
 * join in the real repository, so the fake needs the same rows to join against. A membership
 * whose workspace is missing from that array is skipped, exactly as an inner join would. */
export function createFakeWorkspaceMemberRepository(
  seed: WorkspaceMemberRow[] = [],
  users: Record<string, { email: string; name: string }> = {},
  workspaces: WorkspaceRow[] = [],
): { repo: WorkspaceMemberRepository; state: WorkspaceMemberRow[] } {
  const rows = [...seed];

  const repo: WorkspaceMemberRepository = {
    async listByUserIdWithWorkspace(userId) {
      return rows
        .filter((m) => m.userId === userId)
        .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.id.localeCompare(b.id))
        .flatMap((member) => {
          const workspace = workspaces.find((w) => w.id === member.workspaceId);
          return workspace ? [{ member, workspace }] : [];
        });
    },
    async findByWorkspaceAndUser(workspaceId, userId) {
      return rows.find((m) => m.workspaceId === workspaceId && m.userId === userId) ?? null;
    },
    async findById(workspaceId, memberId) {
      return rows.find((m) => m.id === memberId && m.workspaceId === workspaceId) ?? null;
    },
    async create(input: CreateMembershipRow) {
      // decisions/0070-several-workspaces-per-user.md: the same user in the same workspace
      // twice, not the same user anywhere twice.
      if (rows.some((m) => m.userId === input.userId && m.workspaceId === input.workspaceId)) {
        throw fakeDbError("23505", "workspace_members_workspace_user_key");
      }
      if (input.role === "admin" && rows.some((m) => m.workspaceId === input.workspaceId && m.role === "admin")) {
        throw fakeDbError("23505", "workspace_members_one_admin_key");
      }
      const row = memberRow(input);
      rows.push(row);
      return row;
    },
    async listByWorkspace(workspaceId) {
      return rows
        .filter((m) => m.workspaceId === workspaceId)
        .map((m) => ({ ...m, email: users[m.userId]?.email ?? "unknown@example.test", name: users[m.userId]?.name ?? "Unknown" }));
    },
    async deleteById(workspaceId, memberId) {
      const index = rows.findIndex((m) => m.id === memberId && m.workspaceId === workspaceId);
      if (index === -1) return null;
      const [row] = rows.splice(index, 1);
      return row ?? null;
    },
  };

  return { repo, state: rows };
}

export function createFakeWorkspaceInvitationRepository(
  seed: WorkspaceInvitationRow[] = [],
  details: Record<string, { workspaceName: string; inviterEmail: string }> = {},
): { repo: WorkspaceInvitationRepository; state: WorkspaceInvitationRow[] } {
  const rows = [...seed];

  const repo: WorkspaceInvitationRepository = {
    async countPending(workspaceId) {
      return rows.filter((i) => i.workspaceId === workspaceId && i.acceptedAt === null).length;
    },
    async deletePendingByEmail(workspaceId, email) {
      const remaining = rows.filter((i) => !(i.workspaceId === workspaceId && i.email === email && i.acceptedAt === null));
      rows.length = 0;
      rows.push(...remaining);
    },
    async create(input: CreateInvitationRow) {
      const row = invitationRow(input);
      rows.push(row);
      return row;
    },
    async findByTokenHash(tokenHash) {
      return rows.find((i) => i.tokenHash === tokenHash) ?? null;
    },
    async findByTokenHashWithDetails(tokenHash) {
      const invitation = rows.find((i) => i.tokenHash === tokenHash);
      if (!invitation) return null;
      const detail = details[invitation.workspaceId] ?? { workspaceName: "Unknown", inviterEmail: "unknown@example.test" };
      return { invitation, ...detail };
    },
    async listPendingByWorkspace(workspaceId) {
      return rows.filter((i) => i.workspaceId === workspaceId && i.acceptedAt === null);
    },
    async deleteById(workspaceId, invitationId) {
      const index = rows.findIndex((i) => i.id === invitationId && i.workspaceId === workspaceId && i.acceptedAt === null);
      if (index === -1) return null;
      const [row] = rows.splice(index, 1);
      return row ?? null;
    },
    async markAccepted(id, acceptedAt) {
      const row = rows.find((i) => i.id === id && i.acceptedAt === null);
      if (!row) return null;
      row.acceptedAt = acceptedAt;
      return row;
    },
  };

  return { repo, state: rows };
}
