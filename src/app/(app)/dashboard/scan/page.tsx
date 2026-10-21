import { getTranslations } from "next-intl/server";

import { requireWorkspaceMember } from "@/platform/access/server";
import { PERMISSIONS } from "@/platform/access";
import { UploadForm } from "@/modules/documents/client";

/**
 * "Post erfassen" (decisions/0015-documents-and-quotas.md): for now, a multi-file upload
 * (drag and drop + file input). The "Kamera" tab (`UploadForm`) is a clearly marked
 * placeholder slot P2c's camera scanner (`src/modules/scanner`) fills in, without this page
 * changing - it will render its own capture UI in that tab and call the same
 * `uploadDocument` helper the file-upload tab already uses. `canManageBilling` (P3,
 * decisions/0017-billing-tiers-and-packages.md) lets the quota-error message tell a
 * non-admin member to contact their admin, instead of just linking to a page they cannot
 * act on.
 */
export default async function ScanPage() {
  const access = await requireWorkspaceMember();
  const t = await getTranslations("Scan");

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <UploadForm canManageBilling={access.permissions.includes(PERMISSIONS.billingManage)} />
    </div>
  );
}
