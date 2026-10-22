"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { DOCUMENT_ERROR, MappingValidationError } from "@/persistence/use-cases/documents-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { AFTER_RESPONSE_JOB_BUDGET_MS } from "@/platform/jobs";
import { runDueJobs } from "@/platform/jobs/server";
import type { ActionResult } from "@/shared/action-result";

import {
  confirmIntakeInputSchema,
  deleteDocumentInputSchema,
  kickProcessingInputSchema,
  reclassifyDocumentInputSchema,
  rejectIntakeInputSchema,
  resetIntakeFingerprintInputSchema,
  retryProcessingInputSchema,
} from "./core/schemas";
import type { DocumentActionErrorCode } from "./core/error-codes";

function mapUseCaseError(err: unknown): DocumentActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === DOCUMENT_ERROR.notFound ||
      code === DOCUMENT_ERROR.retryNotAllowed ||
      code === DOCUMENT_ERROR.intakeNotPending ||
      code === DOCUMENT_ERROR.mappingValidationFailed ||
      code === DOCUMENT_ERROR.reclassifyNotAllowed ||
      code === DOCUMENT_ERROR.kindNotSelectable ||
      code === DOCUMENT_ERROR.kindUnchanged ||
      code === DOCUMENT_ERROR.paymentLinked ||
      code === DOCUMENT_ERROR.paymentSettled
    ) {
      return code;
    }
  }
  return "unknown";
}

/** Deletes a document (row + both storage objects). Any workspace member may delete
 * (architecture brief's product decision 9). */
export async function deleteDocumentAction(input: unknown): Promise<ActionResult<undefined, DocumentActionErrorCode>> {
  const parsed = deleteDocumentInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.documentsWrite);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().documents.deleteDocument({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
    });
    revalidatePath("/dashboard");
    // The document's own detail page (P6 review finding A5): without this, a stale cached
    // render of the now-deleted document could still be served if it is ever revisited.
    revalidatePath(`/dashboard/documents/${parsed.data.documentId}`);
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** "Erneut verarbeiten" (requirement 9 of decisions/0016-processing-pipeline-and-ai.md):
 * re-enqueues processing for a `failed` document. Kicks the job runner right after so the
 * user does not have to wait for the next cron sweep or page visit to see it move. */
export async function retryProcessingAction(input: unknown): Promise<ActionResult<undefined, DocumentActionErrorCode>> {
  const parsed = retryProcessingInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.documentsWrite);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().documents.retryProcessing({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
    });
    const workspaceId = access.access.workspace.id;
    after(() => runDueJobs({ workspaceId, limit: 5, budgetMs: AFTER_RESPONSE_JOB_BUDGET_MS }));
    revalidatePath("/dashboard");
    revalidatePath(`/dashboard/documents/${parsed.data.documentId}`);
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** "Dokumentart ändern" (decisions/0072-correcting-a-document-s-kind.md): re-extracts a
 * processed PDF as the kind a human chose. `PERMISSIONS.documentsWrite`, like confirming an
 * intake proposal: one-document work every member does. Workspace scope comes from
 * `requirePermission`, never from the input. Clears the document's open payment suggestions
 * through `src/modules/payments`' own use case right after (they describe the old kind); a
 * failure there is logged, not returned, because the reclassification itself already
 * committed and the job handler clears them again once re-extraction finished. */
export async function reclassifyDocumentAction(input: unknown): Promise<ActionResult<undefined, DocumentActionErrorCode>> {
  const parsed = reclassifyDocumentInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.documentsWrite);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  const workspaceId = access.access.workspace.id;
  const { documentId, kind } = parsed.data;
  const services = getRequestServices();
  try {
    await services.documents.reclassifyDocument({ workspaceId, documentId, kind });
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }

  try {
    await services.payments.discardOpenSuggestionsForDocument({ workspaceId, documentId });
  } catch (err) {
    console.error("[documents] failed to discard open payment suggestions after a reclassification", { workspaceId, documentId, err });
  }

  after(() => runDueJobs({ workspaceId, limit: 5, budgetMs: AFTER_RESPONSE_JOB_BUDGET_MS }));
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/documents/${documentId}`);
  return { status: "success", data: undefined };
}

/**
 * The workspace-scoped "kick" (decisions/0016-processing-pipeline-and-ai.md, requirement
 * 2c): while the Posteingang or a document's detail page shows any document in
 * `uploaded`/`processing`, the client polls and calls this action, which schedules
 * `runDueJobs` for the caller's own workspace via `after()` - so local development without a
 * cron scheduler self-heals after a dev-server restart, and production gets a second,
 * client-driven trigger alongside the cron sweeper and the upload route's own `after()`.
 * Never throws for a plain "not signed in any more" case - the poller is best-effort UI
 * plumbing, not a user-facing action with its own error message.
 */
export async function kickProcessingAction(input: unknown = {}): Promise<void> {
  const parsed = kickProcessingInputSchema.safeParse(input);
  const access = await requirePermission(PERMISSIONS.documentsRead);
  if (access.status === "error") return;

  const workspaceId = access.access.workspace.id;
  const limit = parsed.success ? parsed.data.limit : 5;
  after(() => runDueJobs({ workspaceId, limit, budgetMs: AFTER_RESPONSE_JOB_BUDGET_MS }));
}

/** "Bestätigen und importieren" (F1b, decisions/0020-universal-intake.md's confirmation step,
 * decisions/0022-intake-wiring.md). `PERMISSIONS.documentsWrite` (like every other document
 * action) - not admin-only; any workspace member can confirm a tabular import, matching the
 * architecture brief's "any workspace member may read/write documents". The mapping is
 * re-validated against the full file server-side regardless of what the client sends -
 * `problems` on a `mapping_validation_failed` error lets the UI show exactly what still fails
 * without a second round trip. */
export type ConfirmIntakeActionResult =
  | { status: "success"; data: { id: string } }
  | { status: "error"; errorCode: DocumentActionErrorCode; problems?: readonly { rowNumber: number; field: string; code: string; message: string }[] };

export async function confirmIntakeAction(input: unknown): Promise<ConfirmIntakeActionResult> {
  const parsed = confirmIntakeInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.documentsWrite);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const doc = await getRequestServices().documents.confirmIntake({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
      actingUserId: access.access.user.id,
      documentKind: parsed.data.documentKind,
      platform: parsed.data.platform,
      mapping: parsed.data.mapping,
      amountSign: parsed.data.amountSign,
    });
    revalidatePath("/dashboard");
    revalidatePath(`/dashboard/documents/${doc.id}`);
    revalidatePath("/dashboard/settings/intake");
    return { status: "success", data: { id: doc.id } };
  } catch (err) {
    if (err instanceof MappingValidationError) {
      return { status: "error", errorCode: "mapping_validation_failed", problems: err.problems };
    }
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** "Ablehnen": sets `intakeStatus: "rejected"`, nothing is imported. */
export async function rejectIntakeAction(input: unknown): Promise<ActionResult<{ id: string }, DocumentActionErrorCode>> {
  const parsed = rejectIntakeInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.documentsWrite);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const doc = await getRequestServices().documents.rejectIntake({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
    });
    revalidatePath("/dashboard");
    revalidatePath(`/dashboard/documents/${doc.id}`);
    return { status: "success", data: { id: doc.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** "Zuordnung zurücksetzen" (`/dashboard/settings/intake`, admin-only): removes a confirmed
 * source layout, so the next matching file goes through the classifier proposal flow again. */
export async function resetIntakeFingerprintAction(input: unknown): Promise<ActionResult<undefined, DocumentActionErrorCode>> {
  const parsed = resetIntakeFingerprintInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.intakeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  await getRequestServices().documents.resetIntakeFingerprint(access.access.workspace.id, parsed.data.fingerprintId);
  revalidatePath("/dashboard/settings/intake");
  return { status: "success", data: undefined };
}
