// Permission bundles (WEBAPP_TEMPLATE_SPEC.md §6.6, decisions/0014-workspaces-and-access.md).
// There is no role beyond `admin`/`member` (PRD: "kein Rechte-Management"), but the UI never
// branches on the role string itself: every check goes through a named permission, bound to
// a role's bundle here, so a future role or a narrower bundle only ever changes this file.
export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  membersManage: "members.manage",
  billingManage: "billing.manage",
  documentsRead: "documents.read",
  documentsWrite: "documents.write",
  /** C2 (decisions/0019-contacts.md's "own-company exclusion",
   * decisions/0021-extraction-direction-and-invoice-fields.md): editing the workspace's own
   * company profile (`/dashboard/settings/company`, "Firmendaten") - admin-only, a
   * "workspace settings, not document work" bundle. */
  companyProfileManage: "company_profile.manage",
  /** F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): correcting an
   * already-confirmed intake source (`/dashboard/settings/intake`, "Zuordnung
   * zurücksetzen") - admin-only, same "workspace settings, not everyday document work" shape
   * as `companyProfileManage`. Confirming a NEW proposal is ordinary document work and stays
   * behind `documentsWrite` (every member), only the correction/reset action needs this
   * bundle. */
  intakeManage: "intake.manage",
  /** F2 (decisions/0024-accounts-and-transactions.md): the finance area (`/dashboard/finance`,
   * "Finanzen" - bank accounts and imported transactions) is admin-only end to end, the first
   * deliberate deviation from the PRD's "kein Rechte-Management" - a bank statement exposes
   * salaries and other private debits, information no ordinary member should see just by
   * being on the team. Both permissions are admin-only; there is no member-level "finance
   * read" the way `documentsRead` is shared by every member. */
  financeRead: "finance.read",
  financeManage: "finance.manage",
  /** F5 (decisions/0027-hardening-and-deletion.md): deleting the entire workspace
   * (`/dashboard/settings/company`'s danger zone) - admin-only, the most destructive action
   * in the product, deliberately its own bundle rather than reusing `membersManage` (removing
   * a member is reversible by re-inviting; deleting the workspace is not). */
  workspaceManage: "workspace.manage",
} as const;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** `admin` gets every permission that exists today; `member` gets only the document
 * permissions every workspace member shares (PRD: everyone reads/writes documents, only
 * the admin manages members and billing). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: Object.values(PERMISSIONS),
  member: [PERMISSIONS.documentsRead, PERMISSIONS.documentsWrite],
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
