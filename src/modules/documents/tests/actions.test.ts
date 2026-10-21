// Unit tests for the Server Actions (WEBAPP_TEMPLATE_SPEC.md §10.2: `vi.mock` on the exact
// module paths `actions.ts` imports, no DB, no network). Mirrors
// `src/modules/workspaces/tests/actions.test.ts`'s pattern.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/access/server", () => ({
  requirePermission: vi.fn(),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

const afterMock = vi.fn();
vi.mock("next/server", () => ({
  after: (cb: () => void) => afterMock(cb),
}));

const runDueJobsMock = vi.fn();
vi.mock("@/platform/jobs/server", () => ({
  runDueJobs: (input: unknown) => runDueJobsMock(input),
}));

const documentsUseCases = {
  deleteDocument: vi.fn(),
  retryProcessing: vi.fn(),
  reclassifyDocument: vi.fn(),
  confirmIntake: vi.fn(),
  rejectIntake: vi.fn(),
  resetIntakeFingerprint: vi.fn(),
};
const paymentsUseCases = {
  discardOpenSuggestionsForDocument: vi.fn(),
};
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ documents: documentsUseCases, payments: paymentsUseCases }),
}));

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { DOCUMENT_ERROR, MappingValidationError } from "@/persistence/use-cases/documents-use-cases";

import {
  confirmIntakeAction,
  deleteDocumentAction,
  kickProcessingAction,
  reclassifyDocumentAction,
  rejectIntakeAction,
  resetIntakeFingerprintAction,
  retryProcessingAction,
} from "../actions";

const DOC_ID = "11111111-1111-4111-8111-111111111111";

const ACCESS = {
  status: "ok" as const,
  access: {
    user: { id: "u1", email: "member@example.test" },
    membershipId: "m1",
    role: "member" as const,
    workspace: { id: "w1", name: "Muster GmbH", tier: "free" },
    permissions: ["documents.read", "documents.write"] as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleteDocumentAction", () => {
  it("requires documents.write and deletes", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.deleteDocument.mockResolvedValue(undefined);

    const result = await deleteDocumentAction({ documentId: DOC_ID });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(documentsUseCases.deleteDocument).toHaveBeenCalledWith({ workspaceId: "w1", documentId: DOC_ID });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
    // P6 review finding A5: the document's own detail page must also be revalidated, not
    // just the inbox.
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/documents/${DOC_ID}`);
  });

  it("maps not_found", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.deleteDocument.mockRejectedValue(new UseCaseError(DOCUMENT_ERROR.notFound));

    const result = await deleteDocumentAction({ documentId: DOC_ID });

    expect(result).toEqual({ status: "error", errorCode: "not_found" });
  });
});

describe("retryProcessingAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await retryProcessingAction({ documentId: "not-a-uuid" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("forwards a forbidden result from requirePermission", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });
    const result = await retryProcessingAction({ documentId: DOC_ID });
    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(documentsUseCases.retryProcessing).not.toHaveBeenCalled();
  });

  it("maps retry_not_allowed from a thrown UseCaseError", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.retryProcessing.mockRejectedValue(new UseCaseError(DOCUMENT_ERROR.retryNotAllowed));

    const result = await retryProcessingAction({ documentId: DOC_ID });

    expect(result).toEqual({ status: "error", errorCode: "retry_not_allowed" });
  });

  it("re-enqueues, kicks the runner, and revalidates on success", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.retryProcessing.mockResolvedValue(undefined);

    const result = await retryProcessingAction({ documentId: DOC_ID });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(documentsUseCases.retryProcessing).toHaveBeenCalledWith({ workspaceId: "w1", documentId: DOC_ID });
    expect(afterMock).toHaveBeenCalledTimes(1);
    // The callback passed to `after()` calls `runDueJobs` for the caller's own workspace.
    await afterMock.mock.calls[0]![0]();
    expect(runDueJobsMock).toHaveBeenCalledWith({ workspaceId: "w1", limit: 5 });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/documents/${DOC_ID}`);
  });
});

// decisions/0072-correcting-a-document-s-kind.md: "Dokumentart ändern".
describe("reclassifyDocumentAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await reclassifyDocumentAction({ documentId: "not-a-uuid", kind: "incoming_invoice" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("rejects an account-feeding kind as invalid input (never selectable for a PDF)", async () => {
    for (const kind of ["bank_statement", "payout_report", "platform_settlement"]) {
      const result = await reclassifyDocumentAction({ documentId: DOC_ID, kind });
      expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    }
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("requires documents.write and forwards a forbidden result", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });
    const result = await reclassifyDocumentAction({ documentId: DOC_ID, kind: "incoming_invoice" });
    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.documentsWrite);
    expect(documentsUseCases.reclassifyDocument).not.toHaveBeenCalled();
  });

  it.each([
    DOCUMENT_ERROR.notFound,
    DOCUMENT_ERROR.reclassifyNotAllowed,
    DOCUMENT_ERROR.kindNotSelectable,
    DOCUMENT_ERROR.kindUnchanged,
    DOCUMENT_ERROR.paymentLinked,
    DOCUMENT_ERROR.paymentSettled,
  ])("maps %s from a thrown UseCaseError and touches no suggestion", async (code) => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.reclassifyDocument.mockRejectedValue(new UseCaseError(code));

    const result = await reclassifyDocumentAction({ documentId: DOC_ID, kind: "incoming_invoice" });

    expect(result).toEqual({ status: "error", errorCode: code });
    expect(paymentsUseCases.discardOpenSuggestionsForDocument).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("reclassifies in the caller's own workspace, clears open suggestions, kicks the runner, and revalidates", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.reclassifyDocument.mockResolvedValue(undefined);
    paymentsUseCases.discardOpenSuggestionsForDocument.mockResolvedValue(undefined);

    const result = await reclassifyDocumentAction({ documentId: DOC_ID, kind: "incoming_invoice", workspaceId: "w-other" });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(documentsUseCases.reclassifyDocument).toHaveBeenCalledWith({ workspaceId: "w1", documentId: DOC_ID, kind: "incoming_invoice" });
    expect(paymentsUseCases.discardOpenSuggestionsForDocument).toHaveBeenCalledWith({ workspaceId: "w1", documentId: DOC_ID });
    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterMock.mock.calls[0]![0]();
    expect(runDueJobsMock).toHaveBeenCalledWith({ workspaceId: "w1", limit: 5 });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/documents/${DOC_ID}`);
  });

  it("still succeeds when clearing the suggestions fails (the reclassification already committed)", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.reclassifyDocument.mockResolvedValue(undefined);
    paymentsUseCases.discardOpenSuggestionsForDocument.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reclassifyDocumentAction({ documentId: DOC_ID, kind: "receipt" });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(afterMock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("kickProcessingAction", () => {
  it("does nothing when the caller has no valid workspace access", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "unauthenticated" });

    await kickProcessingAction({});

    expect(afterMock).not.toHaveBeenCalled();
  });

  it("schedules runDueJobs for the caller's own workspace", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);

    await kickProcessingAction({ limit: 10 });

    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterMock.mock.calls[0]![0]();
    expect(runDueJobsMock).toHaveBeenCalledWith({ workspaceId: "w1", limit: 10 });
  });

  it("defaults the limit when called with no input", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);

    await kickProcessingAction();

    await afterMock.mock.calls[0]![0]();
    expect(runDueJobsMock).toHaveBeenCalledWith({ workspaceId: "w1", limit: 5 });
  });
});

// F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): confirming or
// rejecting a tabular-import proposal is ordinary document work, gated behind
// `documentsWrite` (every member) - NOT admin-only. Only the settings page's "Zuordnung
// zurücksetzen" (`resetIntakeFingerprintAction`) is admin-only (`intake.manage`).
describe("confirmIntakeAction", () => {
  const VALID_INPUT = {
    documentId: DOC_ID,
    documentKind: "bank_statement",
    platform: null,
    mapping: { bookingDate: "Datum" },
    amountSign: null,
  };

  it("rejects invalid input without checking permission", async () => {
    const result = await confirmIntakeAction({ documentId: "not-a-uuid" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("checks documents.write, not an admin-only permission", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.confirmIntake.mockResolvedValue({ id: DOC_ID });

    await confirmIntakeAction(VALID_INPUT);

    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.documentsWrite);
  });

  it("forwards a forbidden result from requirePermission", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });
    const result = await confirmIntakeAction(VALID_INPUT);
    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(documentsUseCases.confirmIntake).not.toHaveBeenCalled();
  });

  it("confirms and revalidates (including the intake settings page) on success", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.confirmIntake.mockResolvedValue({ id: DOC_ID });

    const result = await confirmIntakeAction(VALID_INPUT);

    expect(result).toEqual({ status: "success", data: { id: DOC_ID } });
    expect(documentsUseCases.confirmIntake).toHaveBeenCalledWith({
      workspaceId: "w1",
      documentId: DOC_ID,
      actingUserId: "u1",
      documentKind: "bank_statement",
      platform: null,
      mapping: { bookingDate: "Datum" },
      amountSign: null,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/settings/intake");
  });

  it("surfaces mapping validation problems from a thrown MappingValidationError", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    const problems = [{ rowNumber: 3, field: "amount", code: "unparseable_amount", message: "boom" }];
    documentsUseCases.confirmIntake.mockRejectedValue(new MappingValidationError(problems));

    const result = await confirmIntakeAction(VALID_INPUT);

    expect(result).toEqual({ status: "error", errorCode: "mapping_validation_failed", problems });
  });

  it("maps intake_not_pending from a thrown UseCaseError", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.confirmIntake.mockRejectedValue(new UseCaseError(DOCUMENT_ERROR.intakeNotPending));

    const result = await confirmIntakeAction(VALID_INPUT);

    expect(result).toEqual({ status: "error", errorCode: "intake_not_pending" });
  });
});

describe("rejectIntakeAction", () => {
  it("checks documents.write, not an admin-only permission", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.rejectIntake.mockResolvedValue({ id: DOC_ID });

    await rejectIntakeAction({ documentId: DOC_ID });

    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.documentsWrite);
  });

  it("rejects and revalidates on success", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.rejectIntake.mockResolvedValue({ id: DOC_ID });

    const result = await rejectIntakeAction({ documentId: DOC_ID });

    expect(result).toEqual({ status: "success", data: { id: DOC_ID } });
    expect(documentsUseCases.rejectIntake).toHaveBeenCalledWith({ workspaceId: "w1", documentId: DOC_ID });
  });
});

describe("resetIntakeFingerprintAction", () => {
  it("checks the admin-only intake.manage permission, not documents.write", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.resetIntakeFingerprint.mockResolvedValue(undefined);

    await resetIntakeFingerprintAction({ fingerprintId: DOC_ID });

    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.intakeManage);
  });

  it("forwards a forbidden result for a non-admin", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });

    const result = await resetIntakeFingerprintAction({ fingerprintId: DOC_ID });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(documentsUseCases.resetIntakeFingerprint).not.toHaveBeenCalled();
  });

  it("resets and revalidates the settings page on success", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    documentsUseCases.resetIntakeFingerprint.mockResolvedValue(undefined);

    const result = await resetIntakeFingerprintAction({ fingerprintId: DOC_ID });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(documentsUseCases.resetIntakeFingerprint).toHaveBeenCalledWith("w1", DOC_ID);
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/settings/intake");
  });
});
