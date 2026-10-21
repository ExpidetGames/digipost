/**
 * Per-test unique users via Playwright fixtures (WEBAPP_TEMPLATE_SPEC.md §10.4).
 *
 * `user`: every test that uses it gets its own fresh user, already signed in via a fast
 * session (`createTestUser`/`loginAs`, `tests/e2e/helpers/auth.ts`, no mail/rate-limit round
 * trip). This user has no workspace - use it for specs about auth itself, or
 * `/onboarding`'s "no membership yet" case.
 *
 * `adminUser`: the same fast session, plus a workspace created directly
 * (`tests/e2e/helpers/workspace.ts`) with this user as its admin - the fixture every
 * document spec (a later phase) and every workspace-scoped spec (`tests/e2e/invitation.spec.ts`,
 * `tests/e2e/serial/auth.spec.ts`'s dashboard-reaching tests) should build on, since
 * `(app)/layout.tsx` now requires a workspace membership to reach anything under
 * `/dashboard/**`. Unlike `user`'s data (cleaned up "for free" by `on delete cascade` from
 * the user row), a workspace does NOT cascade from user deletion
 * (`src/persistence/schema/workspaces.ts`) - this fixture deletes the workspace
 * explicitly, before the user, in its own teardown.
 */
import { test as base } from "@playwright/test";

import { createTestUser, loginAs, type TestUser } from "./auth";
import { deleteUserById } from "./db";
import { createWorkspaceForUser, deleteWorkspaceById, type TestWorkspace } from "./workspace";

function labelFor(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

export const test = base.extend<{ user: TestUser; adminUser: TestUser & { workspace: TestWorkspace } }>({
  user: async ({ context, baseURL }, use, testInfo) => {
    const user = await createTestUser(labelFor(testInfo.title));
    await loginAs(context, user, baseURL!);
    // `use` here is Playwright's fixture-provide callback (its own documented convention),
    // not a React Hook - eslint-plugin-react-hooks' name heuristic cannot tell the two apart.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(user);
    await deleteUserById(user.id);
  },

  adminUser: async ({ context, baseURL }, use, testInfo) => {
    const label = labelFor(testInfo.title);
    const user = await createTestUser(label);
    await loginAs(context, user, baseURL!);
    const workspace = await createWorkspaceForUser(user.id, `${label} GmbH`);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use({ ...user, workspace });
    // Workspace first: it holds the foreign key to the user via `workspace_members`, and
    // does not cascade from the user's own deletion (see this file's header doc).
    await deleteWorkspaceById(workspace.id);
    await deleteUserById(user.id);
  },
});

export { expect } from "@playwright/test";
