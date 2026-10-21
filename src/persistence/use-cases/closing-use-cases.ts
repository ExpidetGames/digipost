// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The Abschluss
// owns no table of its own: every read here is a period-scoped query against tables other
// owners already own (`documents`, `transactions`, `document_transactions`), and nothing in
// this file ever writes. It exists so the Abschluss page and the export route reach those
// reads through one named door instead of three repositories.
//
// No business decision lives here either - what "complete" means is
// `@/modules/closing`'s own pure `buildClosingReport`, and what a period IS is its
// `parseClosingPeriod`. This file only fans out and bundles.
import type {
  ClosingDocumentCounts,
  ClosingDocumentRow,
  ClosingTransactionCounts,
  ClosingTransactionRow,
  Repositories,
} from "@/persistence/repositories/contracts";

export type ClosingPeriodCounts = {
  documents: ClosingDocumentCounts;
  transactions: ClosingTransactionCounts;
  /** "Offene Zuordnungsvorschläge": suggestions awaiting a decision on a transaction booked
   * inside the period. */
  openSuggestions: number;
};

export interface ClosingUseCases {
  /** Every number the completeness check shows, for one period, in three parallel queries.
   * `from`/`to` are inclusive ISO `YYYY-MM-DD` dates (`@/modules/closing`'s
   * `parseClosingPeriod` is what produces them - never raw user input). */
  getPeriodCounts(workspaceId: string, from: string, to: string): Promise<ClosingPeriodCounts>;
  /** The export's two sheets. Deliberately two separate reads rather than one bundled call:
   * the archive builder streams the documents one at a time and never needs both lists in
   * hand at the same moment for any reason but the workbook. */
  listPeriodDocuments(workspaceId: string, from: string, to: string): Promise<ClosingDocumentRow[]>;
  listPeriodTransactions(workspaceId: string, from: string, to: string): Promise<ClosingTransactionRow[]>;
}

type ClosingUseCaseDeps = {
  repos: Pick<Repositories, "document" | "transaction" | "documentTransaction">;
};

export function createClosingUseCases(deps: ClosingUseCaseDeps): ClosingUseCases {
  return {
    async getPeriodCounts(workspaceId, from, to) {
      const [documents, transactions, openSuggestions] = await Promise.all([
        deps.repos.document.countsForPeriod(workspaceId, from, to),
        deps.repos.transaction.countsForPeriod(workspaceId, from, to),
        deps.repos.documentTransaction.countSuggestedForPeriod(workspaceId, from, to),
      ]);
      return { documents, transactions, openSuggestions };
    },

    listPeriodDocuments: (workspaceId, from, to) => deps.repos.document.listForPeriod(workspaceId, from, to),
    listPeriodTransactions: (workspaceId, from, to) => deps.repos.transaction.listForPeriod(workspaceId, from, to),
  };
}
