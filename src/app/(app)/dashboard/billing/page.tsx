import { requireWorkspaceMember } from "@/platform/access/server";
import { PERMISSIONS } from "@/platform/access";
import { getUsageViewModel, isBillingTestModeActive } from "@/modules/billing/server";
import { BillingPageClient } from "@/modules/billing/client";
import type { Tier } from "@/modules/billing";

// Seam (WEBAPP_TEMPLATE_SPEC.md §5.6, decisions/0017-billing-tiers-and-packages.md):
// everyone in the workspace may view this page; only `billing.manage` (admin-only) may
// change the tier or buy a package (`BillingPageClient` renders those controls only for
// that permission, and only when `BILLING_TEST_MODE` is active).
export default async function BillingPage() {
  const access = await requireWorkspaceMember();
  const usage = await getUsageViewModel(access.workspace.id, access.workspace.tier as Tier);

  return (
    <BillingPageClient
      usage={usage}
      canManage={access.permissions.includes(PERMISSIONS.billingManage)}
      testModeActive={isBillingTestModeActive()}
    />
  );
}
