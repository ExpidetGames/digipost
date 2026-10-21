// Owner: src/modules/payments (decisions/0023-payment-matching.md). "Learned knowledge is
// deterministic" (F3a brief, product decisions): counterparty-name aliases to a contact,
// rejected (document, transaction) pairs that must never be re-suggested, and per-contact
// payment channel - all pure functions over caller-provided maps/sets. F3b owns persisting
// and loading the actual `Map`/`Set` this file operates on; nothing here touches a database.
import { normalizeName } from "@/modules/contacts";

import type { MatchSuggestion } from "./types";

/** Keyed by `normalizeName(counterpartyName)`, valued by the contact id a human has
 * previously confirmed that exact counterparty name refers to - e.g. a supplier whose bank
 * statement remittance line always reads a slightly different trading name than the contact's
 * own registered name. */
export type ContactAliasMap = ReadonlyMap<string, string>;

/** Looks up a learned alias for a transaction's counterparty name - `null` when the name is
 * absent or no alias has been learned for it yet. Callers use this BEFORE the ordinary
 * matching rules, so a previously-confirmed alias short-circuits straight to its contact
 * rather than re-running name similarity from scratch every time. */
export function applyAliases(counterpartyName: string | null | undefined, aliases: ContactAliasMap): string | null {
  if (!counterpartyName) return null;
  // The stable merchant key first (decisions/0047), then the full name aliases were keyed by
  // before, so an alias learned earlier keeps working.
  return aliases.get(aliasKeyForCounterparty(counterpartyName)) ?? aliases.get(normalizeName(counterpartyName)) ?? null;
}

/** decisions/0047: the key an alias is stored and looked up under. Card debits carry the
 * merchant, then a comma and a location or URL, and often a per-payment reference after an
 * asterisk ("FACEBK *AB12CD34EF,fb.me/ads"); keyed by the full name, an alias would never match
 * the next month's debit. The key is the part before the first comma, with an asterisk reference
 * that mixes letters and digits removed ("facebk"). A plain name keys exactly as before. */
export function aliasKeyForCounterparty(counterpartyName: string): string {
  const merchant = counterpartyName.split(",")[0] ?? counterpartyName;
  const withoutReference = merchant.replace(/\*\s*([A-Za-z0-9]+)/g, (_match, code: string) => (/[0-9]/.test(code) && /[A-Za-z]/.test(code) ? " " : ` ${code}`));
  return normalizeName(withoutReference);
}

/** Returns a NEW map with one alias added/overwritten (never mutates `aliases` in place -
 * every function in this module is a pure transform, consistent with the rest of this
 * module's `core/`). Called once a human confirms "yes, this counterparty name is this
 * contact" (accepting a suggestion, or an explicit "always match this name to this contact"
 * action F3b's UI may offer). */
export function learnAliasFromConfirmation(counterpartyName: string, contactId: string, aliases: ContactAliasMap): Map<string, string> {
  const next = new Map(aliases);
  next.set(aliasKeyForCounterparty(counterpartyName), contactId);
  return next;
}

/** One rejected (document, transaction) pairing, keyed so it can live in a plain `Set<string>`
 * - "rejected pairs never re-suggested" (F3a brief). */
export function rejectedPairKey(documentId: string, transactionId: string): string {
  return `${documentId}:${transactionId}`;
}

export type RejectedPairSet = ReadonlySet<string>;

/**
 * Drops any suggestion that pairs a rejected document with a rejected transaction - checked
 * per (document, transaction) pair inside a `collective`-kind suggestion's own arrays, so
 * rejecting one leg of a collective suggestion is enough to suppress the whole suggestion
 * (re-running the arithmetic stage without the rejected document is the caller's job if a
 * narrower re-suggestion is wanted; this function only ever removes, never edits, a
 * suggestion).
 */
export function filterRejectedPairs(suggestions: readonly MatchSuggestion[], rejectedPairs: RejectedPairSet): MatchSuggestion[] {
  return suggestions.filter((suggestion) => {
    for (const documentId of suggestion.documentIds) {
      for (const transactionId of suggestion.transactionIds) {
        if (rejectedPairs.has(rejectedPairKey(documentId, transactionId))) return false;
      }
    }
    return true;
  });
}

/** Per-contact payment channel a human has confirmed (which IBAN a given contact actually
 * pays from/to) - keyed by `contactId`. Exposed as a plain lookup type (not a class) so F3b
 * can back it with whatever storage shape it wants; this module never constructs one itself,
 * only reads it. */
export type PaymentChannelMap = ReadonlyMap<string, { iban: string }>;

/** `true` when a transaction's counterparty IBAN matches the contact's own learned payment
 * channel - a stronger, human-confirmed signal a caller can weight above the ordinary
 * `iban_match` rules-stage reason (e.g. skip the skonto-tolerance check entirely for a
 * contact whose channel is already known, since misdirected-payment risk is lower once a
 * human has confirmed the channel once). */
export function matchesLearnedChannel(contactId: string, counterpartyIban: string | null | undefined, channels: PaymentChannelMap): boolean {
  if (!counterpartyIban) return false;
  const channel = channels.get(contactId);
  if (!channel) return false;
  return channel.iban.toUpperCase().replace(/\s+/g, "") === counterpartyIban.toUpperCase().replace(/\s+/g, "");
}
