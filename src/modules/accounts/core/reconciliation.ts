// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Pure
// balance-reconciliation check for one statement: mirrors `@/modules/intake`'s
// `camt053StatementReconciles` but operates on already-mapped `ImportableStatement` data (a
// tabular source has no balance data at all, so this needs to be reusable for that case's
// deliberate "always no mismatch" answer too - see the batch-level caller,
// `summarizeStatementsForBatch`).
export function computeBalanceMismatch(input: { openingBalanceCents: number | null; closingBalanceCents: number | null; transactionAmountCents: number[] }): boolean {
  if (input.openingBalanceCents === null || input.closingBalanceCents === null) return false;
  const sum = input.transactionAmountCents.reduce((total, amount) => total + amount, 0);
  return input.openingBalanceCents + sum !== input.closingBalanceCents;
}
