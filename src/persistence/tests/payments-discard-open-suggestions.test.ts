// Unit test for `PaymentsUseCases.discardOpenSuggestionsForDocument`
// (decisions/0072-correcting-a-document-s-kind.md), typed fakes via dependency injection
// (WEBAPP_TEMPLATE_SPEC.md §10.2). Kept in its own file, beside `payments-use-cases.test.ts`,
// because it covers only this one narrow entry point "Dokumentart ändern" needs.
import { describe, expect, it } from "vitest";

import { createFakePaymentArbiter } from "@/modules/payments";
import { createFakeDocumentTransactionRepository, documentTransactionRow } from "@/persistence/tests/support/fake-payments-repositories";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import type { Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { createPaymentsUseCases } from "@/persistence/use-cases/payments-use-cases";

describe("discardOpenSuggestionsForDocument", () => {
  it("deletes only this document's suggested rows, never a confirmed or rejected one, never another document's", async () => {
    const workspaceId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const otherDocumentId = crypto.randomUUID();
    const row = (overrides: Parameters<typeof documentTransactionRow>[0]) => documentTransactionRow(overrides);

    const suggestedRule = row({ workspaceId, documentId, transactionId: crypto.randomUUID(), status: "suggested", kind: "exact" });
    const suggestedAi = row({ workspaceId, documentId, transactionId: crypto.randomUUID(), status: "suggested", kind: "ai" });
    const confirmed = row({ workspaceId, documentId, transactionId: crypto.randomUUID(), status: "confirmed" });
    const rejected = row({ workspaceId, documentId, transactionId: crypto.randomUUID(), status: "rejected" });
    const otherDocument = row({ workspaceId, documentId: otherDocumentId, transactionId: crypto.randomUUID(), status: "suggested" });
    const otherWorkspace = row({ workspaceId: crypto.randomUUID(), documentId, transactionId: crypto.randomUUID(), status: "suggested" });

    const { repo: documentTransaction, state } = createFakeDocumentTransactionRepository([
      suggestedRule,
      suggestedAi,
      confirmed,
      rejected,
      otherDocument,
      otherWorkspace,
    ]);
    const repos: Repositories = withUnusedRepositories({ documentTransaction });
    const uow: UnitOfWork = { transaction: (work) => work(repos) };
    const useCases = createPaymentsUseCases({ repos, uow, paymentArbiter: createFakePaymentArbiter() });

    await useCases.discardOpenSuggestionsForDocument({ workspaceId, documentId });

    expect(state.map((r) => r.id).sort()).toEqual([confirmed.id, rejected.id, otherDocument.id, otherWorkspace.id].sort());
  });
});
