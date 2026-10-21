// Owner: src/modules/payments (decisions/0068-supplier-clearing-accounts.md). Pure: which
// contact a bank transaction's counterparty name refers to, built only from what this module
// already has - the learned payment names of decisions/0047 (`applyAliases`,
// `aliasKeyForCounterparty`) and the card-merchant tolerance of decisions/0046
// (`counterpartyNameSimilarity`, which already reduces "FACEBK *QX7MNP41KD,fb.me/ads" to its
// merchant part before comparing). Deliberately NOT a new fuzzy matcher: no new normalizer,
// no new threshold, no new scoring.
//
// Used by the supplier clearing account (`src/persistence/use-cases/accounts-use-cases.ts`
// books a charge onto the contact's clearing account) and by the matching run itself
// (`payments-use-cases.ts` skips a transaction that resolves to a clearing-account contact).
// Conservative by construction: an ambiguous name resolves to nothing, and nothing means the
// transaction stays unexplained and visible, which is the safe failure.
import { applyAliases, type ContactAliasMap } from "./learning";
import { NAME_MATCH_THRESHOLD } from "./rules";
import { counterpartyNameSimilarity } from "./text-signals";

export type ContactForResolution = { id: string; name: string };

/**
 * The contact `counterpartyName` refers to, or `null`:
 *
 * 1. A learned payment name wins outright (a human confirmed it once, or an admin stated it
 *    when creating a supplier's clearing account) - `applyAliases` already tries the stable
 *    merchant key first and the older full-name key second.
 * 2. Otherwise the single best contact whose name is at least `NAME_MATCH_THRESHOLD` similar,
 *    the same bar `matchByRules` uses for its own `name_match` rule. A tie between two
 *    contacts at the same best score is ambiguous and resolves to `null` - the same "more
 *    than one candidate means no match" rule `@/modules/contacts`'s `pickBestMatch` applies.
 */
export function resolveContactForCounterparty(
  counterpartyName: string | null | undefined,
  contacts: readonly ContactForResolution[],
  aliases: ContactAliasMap,
): string | null {
  const aliased = applyAliases(counterpartyName, aliases);
  if (aliased) return aliased;
  if (!counterpartyName) return null;

  const scored = contacts
    .map((contact) => ({ id: contact.id, score: counterpartyNameSimilarity(counterpartyName, contact.name) }))
    .filter((candidate) => candidate.score >= NAME_MATCH_THRESHOLD);
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((candidate) => candidate.score));
  const winners = scored.filter((candidate) => candidate.score === best);
  return winners.length === 1 ? winners[0]!.id : null;
}
