import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { listIntakeFingerprintsProjection } from "@/modules/documents/server";
import { IntakeSettingsClient } from "@/modules/documents/client";

/** "Erkannte Quellen" (F1b, decisions/0020-universal-intake.md's "confirm once" flow,
 * decisions/0022-intake-wiring.md): admin-only, 404s for a non-admin visiting the URL
 * directly - same pattern as `/dashboard/settings/company`. */
export default async function IntakeSettingsPage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.intakeManage)) notFound();

  const t = await getTranslations("IntakeSettings");
  const fingerprints = await listIntakeFingerprintsProjection(access.workspace.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <IntakeSettingsClient fingerprints={fingerprints} />
    </div>
  );
}
