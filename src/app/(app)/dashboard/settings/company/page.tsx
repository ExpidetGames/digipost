import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getCompanyProfileProjection } from "@/modules/workspaces/server";
import { CompanyProfileForm, WorkspaceDangerZone } from "@/modules/workspaces/client";

/** "Firmendaten" (C2, decisions/0021-extraction-direction-and-invoice-fields.md): admin-only,
 * 404s for a non-admin visiting the URL directly - same pattern as `/dashboard/settings/intake`
 * (`src/app/(app)/dashboard/settings/intake/page.tsx`). Existing workspaces created before this
 * phase have no company profile yet; `getCompanyProfileProjection` still returns a (mostly
 * empty) view so the form always has something to render. */
export default async function CompanySettingsPage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.companyProfileManage)) notFound();

  const t = await getTranslations("CompanySettings");
  const profile = (await getCompanyProfileProjection(access.workspace.id)) ?? {
    workspaceName: access.workspace.name,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    country: "DE",
    vatId: null,
    // decisions/0034-extended-company-profile.md (H1): same "nothing filled in yet" default
    // as the rest of this fallback above.
    aliases: [],
    ibans: [],
    domains: [],
    taxNumber: null,
    registerCourt: null,
    registerNumber: null,
    profileText: null,
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <CompanyProfileForm profile={profile} />
      {access.permissions.includes(PERMISSIONS.workspaceManage) ? (
        <WorkspaceDangerZone workspaceName={access.workspace.name} />
      ) : null}
    </div>
  );
}
