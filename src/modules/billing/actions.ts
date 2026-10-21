"use server";

import { revalidatePath } from "next/cache";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { BILLING_ERROR } from "@/persistence/use-cases/billing-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { ActionResult } from "@/shared/action-result";

import { changeTierInputSchema, purchasePackageInputSchema } from "./core/schemas";
import type { BillingActionErrorCode } from "./core/error-codes";
import type { PackageKey, Tier } from "./core/plans";

function mapUseCaseError(err: unknown): BillingActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === BILLING_ERROR.notFound ||
      code === BILLING_ERROR.unknownTier ||
      code === BILLING_ERROR.unknownPackage ||
      code === BILLING_ERROR.downgradeBelowStoredCount ||
      code === BILLING_ERROR.packagesNotAvailableOnFree ||
      code === BILLING_ERROR.notConfigured
    ) {
      return code;
    }
  }
  return "unknown";
}

/**
 * Changes the workspace's tier (`billing.manage`, admin-only - decisions/0017-billing-tiers-and-packages.md).
 * The use case is the actual last line of defense on every rule below (unknown tier,
 * downgrade below the stored document count, `BILLING_TEST_MODE` off): this action's own
 * checks (the permission gate, Zod validation) narrow the error earlier, but calling the
 * use case directly, bypassing this action entirely, would still be refused the same way.
 */
export async function changeTierAction(input: unknown): Promise<ActionResult<{ tier: Tier }, BillingActionErrorCode>> {
  const parsed = changeTierInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.billingManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const result = await getRequestServices().billing.changeTier({
      workspaceId: access.access.workspace.id,
      newTier: parsed.data.tier,
      actingUserId: access.access.user.id,
    });
    revalidatePath("/dashboard/billing");
    return { status: "success", data: result };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/**
 * Buys a one-off digitization package for the current calendar month (`billing.manage`,
 * admin-only). Rejected on Free (`packages_not_available_on_free`, product decision 6) and
 * refused entirely when `BILLING_TEST_MODE` is not `true` (`billing_not_configured`), same
 * defense-in-depth guarantee as `changeTierAction` above.
 */
export async function purchasePackageAction(
  input: unknown,
): Promise<ActionResult<{ packageKey: PackageKey; extraDocuments: number }, BillingActionErrorCode>> {
  const parsed = purchasePackageInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.billingManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const purchase = await getRequestServices().billing.purchasePackage({
      workspaceId: access.access.workspace.id,
      packageKey: parsed.data.packageKey,
      actingUserId: access.access.user.id,
    });
    revalidatePath("/dashboard/billing");
    return { status: "success", data: { packageKey: purchase.packageKey, extraDocuments: purchase.extraDocuments } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}
