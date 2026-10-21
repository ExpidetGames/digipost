// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Read models
// for `/dashboard/finance`/`/dashboard/finance/[accountId]`, published through `server.ts`
// like every other module's `server/read-models.ts`.
import "server-only";

import { cache } from "react";

import { getRequestServices } from "@/persistence/composition/request-services";
import type { AccountOverview } from "@/persistence/use-cases/accounts-use-cases";

import type { TransactionListQuery } from "../core/schemas";

export const listAccountsOverviewProjection = cache(async function listAccountsOverviewProjection(workspaceId: string): Promise<AccountOverview[]> {
  return getRequestServices().accounts.listAccounts(workspaceId);
});

export const listPendingAccountDocumentsProjection = cache(async function listPendingAccountDocumentsProjection(workspaceId: string) {
  return getRequestServices().accounts.listPendingAccountDocuments(workspaceId);
});

/** decisions/0068-supplier-clearing-accounts.md: the clearing account a contact already has
 * (or `null`) - the contact detail page decides between "open it" and "create it" from this.
 * Workspace-scoped like every other projection here. */
export const getContactClearingAccountProjection = cache(async function getContactClearingAccountProjection(workspaceId: string, contactId: string) {
  return getRequestServices().accounts.getContactClearingAccount(workspaceId, contactId);
});

/** decisions/0068: the account detail page needs the balance to explain a contact-owned
 * clearing account's residue ("im erfassten Zeitraum nicht erklärt"). */
export const getAccountOverviewProjection = cache(async function getAccountOverviewProjection(workspaceId: string, accountId: string) {
  return getRequestServices().accounts.getAccountOverview(workspaceId, accountId);
});

export const listTransactionsProjection = cache(async function listTransactionsProjection(
  workspaceId: string,
  accountId: string,
  query: TransactionListQuery,
) {
  return getRequestServices().accounts.listTransactions(workspaceId, accountId, { ...query, pageSize: 25 });
});

export const listImportBatchesProjection = cache(async function listImportBatchesProjection(workspaceId: string, accountId: string) {
  return getRequestServices().accounts.listImportBatches(workspaceId, accountId);
});
