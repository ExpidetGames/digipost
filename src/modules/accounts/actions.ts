"use server";

import { revalidatePath } from "next/cache";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { ACCOUNT_ERROR } from "@/persistence/use-cases/accounts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { ActionResult } from "@/shared/action-result";

import { createContactClearingAccountSchema, importFromDocumentInputSchema, manualAccountCreateSchema, manualAccountUpdateSchema } from "./core/schemas";
import type { AccountActionErrorCode } from "./core/error-codes";

/**
 * `finance.manage` (admin-only, decisions/0024-accounts-and-transactions.md): every mutation
 * in this module - creating/editing an account, and triggering/re-running an import - is
 * gated behind it. `finance.read` (also admin-only) is checked by the pages themselves
 * (`requireWorkspaceMember` + a `notFound()` fallback, same pattern as
 * `/dashboard/settings/intake`), never by a Server Action, since a read has no action of its
 * own.
 */
/** `manualAccountCreateSchema`/`manualAccountUpdateSchema` leave an omitted optional field as
 * `undefined` (the Zod convention); `AccountsUseCases`/the `accounts` table use `null` for
 * "no value" (the Drizzle/Postgres convention this whole persistence layer follows) - this is
 * the one narrow conversion point between the two. */
function toAccountUseCaseFields<T extends { iban?: string; bic?: string; holder?: string; platform?: string }>(
  fields: T,
): Omit<T, "iban" | "bic" | "holder" | "platform"> & { iban: string | null; bic: string | null; holder: string | null; platform: string | null } {
  return { ...fields, iban: fields.iban ?? null, bic: fields.bic ?? null, holder: fields.holder ?? null, platform: fields.platform ?? null };
}

function mapUseCaseError(err: unknown): AccountActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === ACCOUNT_ERROR.notFound ||
      code === ACCOUNT_ERROR.duplicateIban ||
      code === ACCOUNT_ERROR.notImportable ||
      code === ACCOUNT_ERROR.ibanLockedByImports ||
      code === ACCOUNT_ERROR.notBankAccount ||
      code === ACCOUNT_ERROR.clearingAccountExists
    ) {
      return code;
    }
  }
  return "unknown";
}

export async function createAccountAction(input: unknown): Promise<ActionResult<{ accountId: string }, AccountActionErrorCode>> {
  const parsed = manualAccountCreateSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const account = await getRequestServices().accounts.createAccount({ workspaceId: access.access.workspace.id, ...toAccountUseCaseFields(parsed.data) });
    revalidatePath("/dashboard/finance");
    return { status: "success", data: { accountId: account.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

export async function updateAccountAction(input: unknown): Promise<ActionResult<{ accountId: string }, AccountActionErrorCode>> {
  const parsed = manualAccountUpdateSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const account = await getRequestServices().accounts.updateAccount({ workspaceId: access.access.workspace.id, ...toAccountUseCaseFields(parsed.data) });
    revalidatePath("/dashboard/finance");
    revalidatePath(`/dashboard/finance/${account.id}`);
    return { status: "success", data: { accountId: account.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/**
 * "Verrechnungskonto anlegen" on a contact (decisions/0068-supplier-clearing-accounts.md):
 * admin-only like every other finance mutation. Two owners' use cases run here, in this
 * order, because each table keeps its own writer: `payments` records the optional payment
 * name (it owns `payment_aliases`), then `accounts` creates the account and books the history
 * (it owns `accounts`/`transactions`) - which needs the payment name to already exist, or the
 * charges it is supposed to resolve stay unexplained.
 */
export async function createContactClearingAccountAction(input: unknown): Promise<ActionResult<{ accountId: string }, AccountActionErrorCode>> {
  const parsed = createContactClearingAccountSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  const services = getRequestServices();
  const workspaceId = access.access.workspace.id;
  try {
    if (parsed.data.paymentName) {
      await services.payments.addAliasForContact({
        workspaceId,
        contactId: parsed.data.contactId,
        name: parsed.data.paymentName,
        actingUserId: access.access.user.id,
      });
    }
    const account = await services.accounts.createContactClearingAccount({ workspaceId, contactId: parsed.data.contactId });
    revalidatePath("/dashboard/finance");
    revalidatePath(`/dashboard/contacts/${parsed.data.contactId}`);
    revalidatePath("/dashboard/finance/zuordnung");
    revalidatePath("/dashboard/finance/offene-posten");
    return { status: "success", data: { accountId: account.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/**
 * "Erneut importieren" / the pending-account resolution form: re-runs (or, for a
 * pending-account document, completes for the first time) the import for one document,
 * optionally against an explicit `accountId` (decisions/0024-accounts-and-transactions.md's
 * "Pending account" section). Idempotent either way.
 */
export async function importFromDocumentAction(
  input: unknown,
): Promise<ActionResult<{ status: "imported" | "pending_account" | "settlement_imported" }, AccountActionErrorCode>> {
  const parsed = importFromDocumentInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const outcome = await getRequestServices().accounts.importFromDocument({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
      accountId: parsed.data.accountId,
    });
    revalidatePath("/dashboard/finance");
    if (outcome.status === "imported" || outcome.status === "settlement_imported") revalidatePath(`/dashboard/finance/${outcome.accountId}`);
    return { status: "success", data: { status: outcome.status } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}
