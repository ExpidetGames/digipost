/**
 * Guards against the P6 review finding: a reachable error code with no matching message
 * under `de.json` renders the literal key instead of German copy. Generalized to every code
 * this module's error-code sets can return, against every namespace that surfaces them
 * (`ui/*.tsx`'s `t(\`errors.${errorCode}\`)` call sites): `WorkspaceActionErrorCode` is
 * shared by `createWorkspaceAction` (Onboarding), `inviteMemberAction`/
 * `revokeInvitationAction`/`removeMemberAction`/`leaveWorkspaceAction` (Team), and
 * `acceptInvitationAction` (Invite) - each namespace needs the full set since the UI has no
 * static way to narrow which subset of the union a given action returns. F5
 * (decisions/0027-hardening-and-deletion.md) added `CompanySettings.dangerZone.errors`
 * (`deleteWorkspaceAction`, `WorkspaceDangerZone`) as a fourth surface, nested one level
 * deeper than the other three - `getErrors` below abstracts the lookup path so this stays a
 * single generalized check rather than one-off duplicated assertions. decisions/0034
 * (extended company profile, H1) added a fifth surface, `CompanySettings.errors` itself
 * (`updateCompanyProfileAction`'s own `COMPANY_PROFILE_ACTION_ERROR_CODES`, previously
 * untested here - a pre-existing gap this phase closes alongside adding its own three new
 * codes), plus `alias_too_generic` to `WORKSPACE_ACTION_ERROR_CODES` (reachable from
 * `createWorkspaceAction`'s onboarding form, which also collects the extended profile's
 * `aliases` field).
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";

import { COMPANY_PROFILE_ACTION_ERROR_CODES, WORKSPACE_ACTION_ERROR_CODES } from "../core/error-codes";

type Messages = Record<string, unknown>;

const CASES: { codes: readonly string[]; label: string; getErrors: () => Messages }[] = [
  { codes: WORKSPACE_ACTION_ERROR_CODES, label: "Team.errors", getErrors: () => (de.Team as { errors: Messages }).errors },
  { codes: WORKSPACE_ACTION_ERROR_CODES, label: "Onboarding.errors", getErrors: () => (de.Onboarding as { errors: Messages }).errors },
  { codes: WORKSPACE_ACTION_ERROR_CODES, label: "Invite.errors", getErrors: () => (de.Invite as { errors: Messages }).errors },
  { codes: COMPANY_PROFILE_ACTION_ERROR_CODES, label: "CompanySettings.errors", getErrors: () => (de.CompanySettings as { errors: Messages }).errors },
  {
    codes: WORKSPACE_ACTION_ERROR_CODES,
    label: "CompanySettings.dangerZone.errors",
    getErrors: () => (de.CompanySettings as { dangerZone: { errors: Messages } }).dangerZone.errors,
  },
  // decisions/0070-several-workspaces-per-user.md: `switchWorkspaceAction` surfaces the same
  // union through the sidebar's workspace switcher, a sixth surface.
  {
    codes: WORKSPACE_ACTION_ERROR_CODES,
    label: "DashboardShell.workspaceSwitcher.errors",
    getErrors: () => (de.DashboardShell as { workspaceSwitcher: { errors: Messages } }).workspaceSwitcher.errors,
  },
];

describe("workspaces action-error codes have German copy", () => {
  for (const { codes, label, getErrors } of CASES) {
    describe(label, () => {
      const errors = getErrors();
      it.each(codes)("code %s resolves", (code) => {
        expect(typeof errors[code], `${label}.${code} is missing from de.json`).toBe("string");
      });
    });
  }
});
