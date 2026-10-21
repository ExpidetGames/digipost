import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireUser } from "@/platform/auth/server";
import { listWorkspacesProjection } from "@/modules/workspaces/server";
import { OnboardingForm } from "@/modules/workspaces/client";

// Reads the session cookie for real (via requireUser) and the workspace memberships;
// never statically prerendered. Deliberately outside the `(app)` route group
// (WEBAPP_TEMPLATE_SPEC.md §14 "Mandanten"): `(app)/layout.tsx`'s `requireWorkspaceMember()`
// would redirect a workspace-less user straight back here, an infinite loop.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await requireUser();
  // decisions/0070-several-workspaces-per-user.md: a user WITH a membership is no longer
  // redirected to /dashboard. This same page is "Weitere Firma anlegen" for them - it only
  // gains a way back to the dashboard they came from, since they are not stuck here the way
  // a brand-new user is. A user with NO membership still arrives here from
  // `requireWorkspaceMember()` exactly as before.
  const workspaces = await listWorkspacesProjection(user.id);
  const hasWorkspace = workspaces.length > 0;

  const t = await getTranslations("Onboarding");

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-foreground">{hasWorkspace ? t("additionalHeading") : t("heading")}</h1>
          <p className="text-sm text-muted-foreground">
            {hasWorkspace ? t("additionalDescription") : t("description")}
          </p>
        </div>
        <OnboardingForm />
        {hasWorkspace ? (
          <Link href="/dashboard" className="mt-4 inline-block text-sm text-muted-foreground underline hover:text-foreground">
            {t("backToDashboard")}
          </Link>
        ) : null}
      </div>
    </main>
  );
}
