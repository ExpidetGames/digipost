// Workspace helpers for e2e setup/teardown (WEBAPP_TEMPLATE_SPEC.md §10.4,
// decisions/0014-workspaces-and-access.md). Talks to Postgres directly with `pg` (e2e
// imports no app code, `tests/e2e/helpers/db.ts`'s own header doc). Unlike a user's owned
// data, a workspace does NOT cascade from `auth.user` deletion
// (`src/persistence/schema/workspaces.ts`'s header comment): a fixture that creates a
// workspace must delete it explicitly, which is exactly what
// `tests/e2e/helpers/fixtures.ts`'s `adminUser` fixture does below.
import { ownerQuery } from "./db";

export type TestWorkspace = { id: string; name: string };

/** Creates a workspace and makes `userId` its admin - the same end state
 * `createWorkspaceAction`/`createForUser` produce, done directly so tests that only need
 * a signed-in admin with a workspace do not have to drive the onboarding UI first. */
export async function createWorkspaceForUser(userId: string, name: string): Promise<TestWorkspace> {
  const [workspace] = await ownerQuery<{ id: string; name: string }>(
    `insert into public.workspaces (name) values ($1) returning id, name`,
    [name],
  );
  if (!workspace) throw new Error(`createWorkspaceForUser(${name}) returned no row`);

  await ownerQuery(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`, [
    workspace.id,
    userId,
  ]);

  return workspace;
}

/** Adds an existing user to a workspace as a plain member - the same end state
 * `acceptInvitationAction` produces, done directly so a spec that only needs "a second real
 * member of this workspace" (e.g. the member-visibility tests in `finance.spec.ts`)
 * does not have to drive the full invite/accept UI flow first. */
export async function addMemberToWorkspace(workspaceId: string, userId: string): Promise<void> {
  await ownerQuery(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')`, [
    workspaceId,
    userId,
  ]);
}

/** Looks up the workspace a user belongs to (there is at most one, PRD) - used by specs
 * that create a workspace through the UI itself (`tests/e2e/onboarding.spec.ts`) rather
 * than through `createWorkspaceForUser`, so they can still clean it up afterward. */
export async function findWorkspaceIdForUser(userId: string): Promise<string | undefined> {
  const rows = await ownerQuery<{ workspace_id: string }>(
    `select workspace_id from public.workspace_members where user_id = $1`,
    [userId],
  );
  return rows[0]?.workspace_id;
}

/** Deletes a workspace (and, via `on delete cascade`, its memberships/invitations). Call
 * this explicitly for every workspace a test creates - it is never cleaned up by deleting
 * the user (see this file's header doc). */
export async function deleteWorkspaceById(id: string | undefined): Promise<void> {
  if (!id) return;
  await ownerQuery(`delete from public.workspaces where id = $1`, [id]);
}
