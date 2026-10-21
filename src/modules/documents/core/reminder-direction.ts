// Reminder direction resolution (H-contract.md section 5, decisions/0036-guided-extraction.md):
// a `reminder` is the one invoice-shaped kind `planCounterparty` (`./party-roles.ts`) leaves in
// `"open"` mode - the model still decides whether we received it or sent it, because unlike an
// invoice a reminder has no fixed "who sent this" shape (either party can be the one chasing
// payment). Code still has the final word: a payment IBAN that belongs to the workspace itself
// overrules whatever the model answered, the same "structured data decides, free text/model
// answers only help" principle `@/modules/contacts`'s `isOwnCompany` already applies to company
// identity. Pure, next to `./direction.ts` (this module's other code-decides-direction logic),
// deliberately its own file rather than an addition to `direction.ts`: `decideDirection` reasons
// over `ExtractedParty[]`/`OwnCompanyProfile`, this over one IBAN string and the model's own
// narrow yes/no-shaped answer - different inputs, same "never trust the model directly" spirit.
import { normalizeIban } from "@/modules/contacts";

import type { DocumentDirection } from "@/persistence/repositories/contracts";

/**
 * `modelDirection` is the guided open prompt's own `reminderDirection` answer ("did we receive
 * this or send it ourselves", H-contract.md section 5) - `"received"` reads as `"incoming"`,
 * `"sent"` as `"outgoing"`, anything else (including a genuinely absent answer) as `"unknown"`.
 *
 * Decision order, `paymentIban` first:
 * 1. `paymentIban` is one of `ownIbans` (normalized via `@/modules/contacts`'s `normalizeIban` -
 *    tolerant of spacing/case on both sides) -> `"outgoing"` (we are chasing our own payment).
 * 2. `paymentIban` is present but matches none of `ownIbans` -> `"incoming"` (someone else is
 *    chasing us).
 * 3. No `paymentIban` at all -> the model's own answer, or `"unknown"` when it gave none.
 */
export function resolveReminderDirection(input: {
  modelDirection: "received" | "sent" | null;
  paymentIban: string | null;
  ownIbans: readonly string[];
}): DocumentDirection {
  const { modelDirection, paymentIban, ownIbans } = input;

  if (paymentIban) {
    const normalizedPaymentIban = normalizeIban(paymentIban);
    const isOwnIban = ownIbans.some((ownIban) => normalizeIban(ownIban) === normalizedPaymentIban);
    return isOwnIban ? "outgoing" : "incoming";
  }

  if (modelDirection === "received") return "incoming";
  if (modelDirection === "sent") return "outgoing";
  return "unknown";
}
