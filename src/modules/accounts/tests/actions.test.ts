// Unit tests for the Server Actions (WEBAPP_TEMPLATE_SPEC.md §10.2: `vi.mock` on the exact
// module paths `actions.ts` imports, no DB, no network). Mirrors
// `src/modules/documents/tests/actions.test.ts`'s pattern. Covers the permission gate
// (`finance.manage`, admin-only): a member's `requirePermission` call resolves to `forbidden`
// without ever reaching the use case.
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

const accountsUseCases = {
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  importFromDocument: vi.fn(),
};
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ accounts: accountsUseCases }),
}));

import { PERMISSIONS } from "@/platform/access";
import { AFTER_RESPONSE_JOB_BUDGET_MS } from "@/platform/jobs";
import { requirePermission } from "@/platform/access/server";

import { createAccountAction, importFromDocumentAction, updateAccountAction } from "../actions";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

const FORBIDDEN = { status: "error" as const, errorCode: "forbidden" as const };
const OK_ACCESS = {
  status: "ok" as const,
  access: {
    user: { id: "u1", email: "admin@example.test" },
    membershipId: "m1",
    role: "admin" as const,
    workspace: { id: "w1", name: "Muster GmbH", tier: "free" },
    permissions: [PERMISSIONS.financeRead, PERMISSIONS.financeManage] as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAccountAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await createAccountAction({ type: "bank", name: "" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("a member (no finance.manage) is forbidden, the use case is never called", async () => {
    vi.mocked(requirePermission).mockResolvedValue(FORBIDDEN);

    const result = await createAccountAction({ type: "bank", name: "Geschäftskonto" });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.financeManage);
    expect(accountsUseCases.createAccount).not.toHaveBeenCalled();
  });

  it("an admin creates the account", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    accountsUseCases.createAccount.mockResolvedValue({ id: ACCOUNT_ID });

    const result = await createAccountAction({ type: "bank", name: "Geschäftskonto" });

    expect(result).toEqual({ status: "success", data: { accountId: ACCOUNT_ID } });
    expect(accountsUseCases.createAccount).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", name: "Geschäftskonto" }));
  });
});

describe("updateAccountAction", () => {
  it("a member is forbidden", async () => {
    vi.mocked(requirePermission).mockResolvedValue(FORBIDDEN);

    const result = await updateAccountAction({ accountId: ACCOUNT_ID, type: "bank", name: "Neu" });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(accountsUseCases.updateAccount).not.toHaveBeenCalled();
  });
});

describe("importFromDocumentAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await importFromDocumentAction({ documentId: "not-a-uuid" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("a member is forbidden, the use case is never called", async () => {
    vi.mocked(requirePermission).mockResolvedValue(FORBIDDEN);

    const result = await importFromDocumentAction({ documentId: DOCUMENT_ID });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(accountsUseCases.importFromDocument).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("an admin re-runs the import", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    accountsUseCases.importFromDocument.mockResolvedValue({ status: "imported", accountId: ACCOUNT_ID });

    const result = await importFromDocumentAction({ documentId: DOCUMENT_ID });

    expect(result).toEqual({ status: "success", data: { status: "imported" } });
    expect(accountsUseCases.importFromDocument).toHaveBeenCalledWith({ workspaceId: "w1", documentId: DOCUMENT_ID, accountId: undefined });
    // decisions/0076: the import queued a matching run due now; the runner starts after the
    // response, scoped to the caller's own workspace, instead of waiting for the cron sweep.
    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterMock.mock.calls[0]![0]();
    expect(runDueJobsMock).toHaveBeenCalledWith({ workspaceId: "w1", limit: 5, budgetMs: AFTER_RESPONSE_JOB_BUDGET_MS });
  });
});
