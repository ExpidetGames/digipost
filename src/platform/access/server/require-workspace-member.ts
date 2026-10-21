// Auth+tenancy guard for pages/layouts under `(app)` (WEBAPP_TEMPLATE_SPEC.md §6.4/§6.6):
// `requireUser()` first (redirects a signed-out visitor to `/login?next=…`, same as every
// other protected page), then resolves the workspace membership and redirects a
// signed-in-but-workspace-less visitor to `/onboarding`. A user who already has a
// membership visiting `/onboarding` gets the opposite redirect
// (`src/app/(onboarding)/onboarding/page.tsx`'s own check, not this function's job).
import "server-only";

import { redirect } from "next/navigation";

import { requireUser } from "@/platform/auth/server";

import { resolveAccess, type WorkspaceAccess } from "./get-workspace-access";

export async function requireWorkspaceMember(): Promise<WorkspaceAccess> {
  const user = await requireUser();
  const access = await resolveAccess(user);
  if (!access) redirect("/onboarding");
  return access;
}
