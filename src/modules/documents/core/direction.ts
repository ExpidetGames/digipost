// Pure direction decision (decisions/0021-extraction-direction-and-invoice-fields.md, tightened
// by decisions/0031-direction-from-kind-and-short-invoice-numbers.md, and by wave 2 of
// decisions/0036-guided-extraction.md): never trusts the model's own notion of direction.
// decisions/0031's real-world finding: the model's per-party `role` hint (priority 1 below) is
// NOT reliable run-to-run for the SAME document/prompt/model - three consecutive runs of one
// real outgoing invoice produced three different party lists, two of which had no own-company
// party at all. `documents.kind` (a separate classifier call, F1b) was correct in every run, so
// it is the second, more reliable signal; a deterministic own-company-in-text check is the
// third and weakest fallback. Called once per processed document by
// `src/persistence/use-cases/documents-use-cases.ts`'s `processOcrDocument`, but ONLY for a
// `CounterpartyPlan` of mode `"open"` since decisions/0036's wave 2 (`./party-roles.ts`): a
// `"derived"`-mode kind's direction is now `plan.ourRole` directly, decided in code before the
// analyzer even runs, never through this function at all - this function's own kind-based
// priority still matters for the "open" kinds whose direction genuinely depends on party-role
// hints (a letter, a contract, an authority letter that resolved to `"open"` some other way).
import { isOwnCompany, normalizeName, type OwnCompanyProfile } from "@/modules/contacts";
import type { DocumentKind } from "@/modules/intake";

import type { DocumentDirection } from "@/persistence/repositories/contracts";

import type { ExtractedParty } from "./ports";

/** Priority 2 (decisions/0031): `documents.kind` as decided by the intake classifier (or a
 * self-identified format like ZUGFeRD) - independent of the model's per-party role hints, and
 * observed to stay correct across runs where the party list itself was not. Any other kind
 * (a plain letter, a bank statement, ...) carries no direction signal of its own.
 *
 * `"reminder"` was REMOVED here by decisions/0036's wave 2 (H-contract.md section 5): unlike
 * `outgoing_invoice`/`incoming_invoice`, a reminder has no fixed "who sent this" shape - either
 * party can be the one chasing payment, so its kind alone must not imply a direction any more.
 * `core/reminder-direction.ts`'s `resolveReminderDirection` decides a reminder's direction
 * instead (the guided analyzer's own answer, overruled by a payment-IBAN check) - this function
 * is never even called for a reminder any more, see `processOcrDocument`. */
function directionFromKind(kind: DocumentKind | null): DocumentDirection | null {
  if (kind === "outgoing_invoice") return "outgoing";
  if (kind === "incoming_invoice") return "incoming";
  return null;
}

/** Priority 3 (decisions/0031, weakest): does the workspace's own company show up anywhere in
 * the document's own text - its name (normalized via `@/modules/contacts`'s `normalizeName`,
 * reused rather than duplicated) or its postal code, verbatim? This is not a structured
 * "party" match, only textual evidence the company is mentioned at all (typically the
 * letterhead of a plain scanned letter addressed to it). */
function ownCompanyAppearsInText(ownCompany: OwnCompanyProfile, documentText: string): boolean {
  const postalCode = ownCompany.postalCode?.trim();
  if (postalCode && documentText.includes(postalCode)) return true;

  const normalizedName = normalizeName(ownCompany.name);
  if (!normalizedName) return false;
  return normalizeName(documentText).includes(normalizedName);
}

/**
 * Decision order (decisions/0031, `"reminder"` removed from step 2 by decisions/0036's wave 2),
 * never inventing a direction when nothing matches. Only ever called for a `CounterpartyPlan` of
 * mode `"open"` since wave 2 (`processOcrDocument`) - `kind` is still one of its own parameters
 * because a `"open"`-mode kind can still be `null` (a plain OCR'd letter with no self-identified
 * format) and because this function's unit tests exercise it directly, independent of the
 * pipeline:
 *
 * 1. We appear among the parties as `recipient` -> `"incoming"`; as `sender` -> `"outgoing"`
 *    (checked after `recipient`: a reply thread that lists us in both roles is read as
 *    incoming, the more common case for a scanned-mail inbox, and the one worth erring toward
 *    when the model contradicts itself). The strongest signal when it is actually present.
 * 2. Else `directionFromKind(kind)`: `"outgoing_invoice"` -> `"outgoing"`;
 *    `"incoming_invoice"` -> `"incoming"`. (Every kind with its OWN direction implication now
 *    resolves through `./party-roles.ts`'s `"derived"` plan mode before this function is ever
 *    called at all - these two entries only remain reachable for a self-identified ZUGFeRD
 *    invoice's own kind-guessing fallback, which still calls `isOwnCompany` directly rather
 *    than this whole function.)
 * 3. Else, if the own company appears in `documentText` (name or postal code) AND exactly one
 *    party is marked `sender`, the own company is the recipient -> `"incoming"`.
 * 4. Otherwise -> `"unknown"`.
 *
 * `kind`/`documentText` are required (not optional) precisely so a caller cannot silently skip
 * priorities 2/3 by forgetting an argument - pass `null` explicitly when either is genuinely
 * unavailable.
 */
export function decideDirection(parties: readonly ExtractedParty[], ownCompany: OwnCompanyProfile, kind: DocumentKind | null, documentText: string | null): DocumentDirection {
  // decisions/0032-kind-outranks-party-roles.md: `kind` comes FIRST. The owner's own
  // outgoing invoice proved the model's role labels wrong three runs in a row (own company
  // absent once, and labelled `recipient` on a letter they themselves sent twice), while the
  // classifier's `kind` was correct every single time. Role labels stay as the fallback for
  // every kind that carries no direction of its own (a letter, a contract, an authority
  // letter).
  const fromKind = directionFromKind(kind);
  if (fromKind) return fromKind;

  const ownMatches = parties.filter((party) => isOwnCompany(party, ownCompany));
  if (ownMatches.some((party) => party.role === "recipient")) return "incoming";
  if (ownMatches.some((party) => party.role === "sender")) return "outgoing";

  if (documentText && ownCompanyAppearsInText(ownCompany, documentText)) {
    const senders = parties.filter((party) => party.role === "sender");
    if (senders.length === 1) return "incoming";
  }

  return "unknown";
}

/** Every party that is NOT the workspace's own company - `@/modules/contacts`'s
 * `upsertFromExtraction` must never be called for a party `isOwnCompany` matches (the
 * code-side check that always wins over whatever the model itself labeled that party). */
export function nonOwnParties(parties: readonly ExtractedParty[], ownCompany: OwnCompanyProfile): ExtractedParty[] {
  return parties.filter((party) => !isOwnCompany(party, ownCompany));
}

/**
 * The role to link a non-own party under (decisions/0021's "Linking"): once `direction` is
 * known, the resolved counterparty (the first non-own party whose own role hint does not
 * already match what direction implies) is forced to the directionally-correct role -
 * `"sender"` for an incoming document, `"recipient"` for an outgoing one. Every other non-own
 * party (a CC'd insurer, a debt-collection agency writing `on_behalf_of`, ...) keeps its own
 * extracted role hint unchanged ("others as hinted").
 */
function expectedRoleFor(direction: DocumentDirection): ExtractedParty["role"] | null {
  if (direction === "incoming") return "sender";
  if (direction === "outgoing") return "recipient";
  return null;
}

export function resolveLinkRoles(
  parties: readonly ExtractedParty[],
  direction: DocumentDirection,
): Array<{ party: ExtractedParty; role: ExtractedParty["role"] }> {
  const expectedRole = expectedRoleFor(direction);
  const alreadyHasExpectedRole = expectedRole ? parties.some((party) => party.role === expectedRole) : true;

  let forced = false;
  return parties.map((party) => {
    if (expectedRole && !alreadyHasExpectedRole && !forced) {
      forced = true;
      return { party, role: expectedRole };
    }
    return { party, role: party.role };
  });
}
