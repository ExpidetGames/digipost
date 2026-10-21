// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Pure
// account-resolution-by-IBAN decision, reusing `@/modules/contacts`'s `normalizeIban` (already
// unit-tested there) rather than duplicating IBAN normalization in this module.
import { normalizeIban } from "@/modules/contacts";

export type ExistingAccountForResolution = { id: string; iban: string | null };

/**
 * Picks the account whose (already-normalized) `iban` matches `candidateIban` once both sides
 * are normalized the same way - a differently-formatted IBAN (spaces, lowercase) for an
 * account already on file still resolves to it. `null` when `candidateIban` is `null`/blank
 * (the "statement has no own-account IBAN" case, decisions/0024's "Pending account" section)
 * or when no existing account's IBAN matches - the caller then auto-creates one (real
 * resolution, `AccountRepository.findByIban`) or reports `pending_account` (the caller's own
 * decision, not this pure function's). `accounts.iban` is unique per workspace (the schema's
 * own partial unique index), so at most one match is ever possible here by construction.
 */
export function resolveAccountByIban(accounts: ExistingAccountForResolution[], candidateIban: string | null): string | null {
  if (!candidateIban || candidateIban.trim().length === 0) return null;
  const normalized = normalizeIban(candidateIban);
  return accounts.find((account) => account.iban === normalized)?.id ?? null;
}
