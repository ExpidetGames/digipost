"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { AFTER_RESPONSE_JOB_BUDGET_MS } from "@/platform/jobs";
import { runDueJobs } from "@/platform/jobs/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { PAYMENT_ERROR } from "@/persistence/use-cases/payments-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { ActionResult } from "@/shared/action-result";

import {
  decisionInputSchema,
  linkManuallyInputSchema,
  markNoDocumentNeededInputSchema,
  markSettledWithoutPaymentInputSchema,
  deletePaymentAliasInputSchema,
  paymentAutoConfirmInputSchema,
} from "./core/schemas";
import type { PaymentActionErrorCode } from "./core/error-codes";

/**
 * Confirming/rejecting/unlinking/linking a transaction, and bulk "kein Beleg nötig", all sit
 * behind `finance.manage` (admin-only, decisions/0024-accounts-and-transactions.md's bundle,
 * reused unchanged by F3b): every one of these actions necessarily reveals or acts on
 * transaction-level data (an amount, a counterparty), exactly what a member must never see
 * (decisions/0025-payment-matching-wiring.md). `markSettledWithoutPaymentAction` ("ohne
 * Zahlung erledigt") is the one exception - it never references a transaction at all, only the
 * document's own status, so it stays behind `documents.write` (every member), the same tier
 * deleting a document already sits behind.
 */
function mapUseCaseError(err: unknown): PaymentActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === PAYMENT_ERROR.notFound || code === PAYMENT_ERROR.alreadyDecided || code === PAYMENT_ERROR.crossDirection || code === PAYMENT_ERROR.amountExceedsOpen ||
      code === PAYMENT_ERROR.amountExceedsTransaction
    ) {
      return code;
    }
  }
  return "unknown";
}

function revalidateAfterDecision(documentId?: string) {
  revalidatePath("/dashboard/finance/zuordnung");
  revalidatePath("/dashboard/finance/offene-posten");
  revalidatePath("/dashboard");
  if (documentId) revalidatePath(`/dashboard/documents/${documentId}`);
}

export async function confirmSuggestionAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = decisionInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().payments.confirmSuggestion({
      workspaceId: access.access.workspace.id,
      documentTransactionId: parsed.data.documentTransactionId,
      actingUserId: access.access.user.id,
    });
    revalidateAfterDecision();
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

export async function rejectSuggestionAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = decisionInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().payments.rejectSuggestion({
      workspaceId: access.access.workspace.id,
      documentTransactionId: parsed.data.documentTransactionId,
      actingUserId: access.access.user.id,
    });
    revalidateAfterDecision();
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

export async function unlinkTransactionAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = decisionInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().payments.unlink({
      workspaceId: access.access.workspace.id,
      documentTransactionId: parsed.data.documentTransactionId,
      actingUserId: access.access.user.id,
    });
    revalidateAfterDecision();
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

export async function linkManuallyAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = linkManuallyInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().payments.linkManually({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
      transactionId: parsed.data.transactionId,
      allocatedAmountCents: parsed.data.allocatedAmountCents,
      actingUserId: access.access.user.id,
    });
    revalidateAfterDecision(parsed.data.documentId);
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

export async function markNoDocumentNeededAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = markNoDocumentNeededInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().payments.markNoDocumentNeeded({
      workspaceId: access.access.workspace.id,
      transactionIds: parsed.data.transactionIds,
      forCounterparty: parsed.data.forCounterparty,
      actingUserId: access.access.user.id,
    });
    revalidatePath("/dashboard/finance/zuordnung");
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** "Ohne Zahlung erledigt" (e.g. a paid-in-cash receipt) - `documents.write` (every member),
 * never `finance.manage`: it references no transaction, only the document's own status. */
export async function markSettledWithoutPaymentAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = markSettledWithoutPaymentInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.documentsWrite);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().payments.markSettledWithoutPayment({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
      actingUserId: access.access.user.id,
    });
    revalidatePath(`/dashboard/documents/${parsed.data.documentId}`);
    revalidatePath("/dashboard");
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** decisions/0044: an admin chooses which payment suggestions are confirmed without a human.
 * The mode lives on the workspace (written by `src/modules/workspaces`' use case); a matching run
 * is scheduled right away so the new mode also applies to the suggestions already open, and the
 * job runner starts after the response to run it (decisions/0076). */
export async function setPaymentAutoConfirmAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = paymentAutoConfirmInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const services = getRequestServices();
    await services.workspaces.setPaymentAutoConfirm({ workspaceId: access.access.workspace.id, mode: parsed.data.mode });
    const workspaceId = access.access.workspace.id;
    await services.payments.scheduleMatching({ workspaceId });
    after(() => runDueJobs({ workspaceId, limit: 5, budgetMs: AFTER_RESPONSE_JOB_BUDGET_MS }));
    revalidateAfterDecision();
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** decisions/0047: forgets a counterparty name learned for a contact. Finance data (a bank
 * counterparty name), so `finance.manage` like every other payment decision. */
export async function deletePaymentAliasAction(input: unknown): Promise<ActionResult<void, PaymentActionErrorCode>> {
  const parsed = deletePaymentAliasInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().payments.deleteAlias({ workspaceId: access.access.workspace.id, aliasId: parsed.data.aliasId });
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}
