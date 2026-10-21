// Kind -> counterparty plan (H-contract.md section 2, decisions/0036-guided-extraction.md): a
// pure lookup table computed BEFORE the analyzer ever runs, from `documents.kind` alone - the
// same signal decisions/0031/0032 already established as reliable run-to-run, unlike the
// model's own per-party role labels. `planCounterparty`'s result tells the guided prompt
// (`src/platform/mistral/server/prompts.ts`'s `buildGuidedDerivedSystemPrompt`/
// `buildGuidedOpenSystemPrompt`) exactly what to ask the model, or not to ask it anything at
// all: for a `"derived"` kind our own role and the counterparty's role are stated as a fact,
// never a question, and `relationType` comes from this table alone, never from a model answer
// (a kind is a reliable signal, a role label is not - the same reasoning decisions/0032 already
// applied to direction).
import type { ContactRelationType } from "@/modules/contacts";
import type { DocumentKind } from "@/modules/intake";

export type CounterpartyPlan =
  | { mode: "derived"; ourRole: "sender" | "recipient"; counterpartyRole: "sender" | "recipient"; relationType: ContactRelationType | null }
  | { mode: "open" }
  | { mode: "none" };

/** Only the kinds with a `"derived"` plan need an entry here (H-contract.md section 2's
 * table) - every other kind falls through to `"open"` (or `"none"` for `bank_statement`,
 * checked separately below) via `planCounterparty`'s default. */
const DERIVED_PLANS: Partial<Record<DocumentKind, Extract<CounterpartyPlan, { mode: "derived" }>>> = {
  outgoing_invoice: { mode: "derived", ourRole: "sender", counterpartyRole: "recipient", relationType: "customer" },
  incoming_invoice: { mode: "derived", ourRole: "recipient", counterpartyRole: "sender", relationType: "supplier" },
  receipt: { mode: "derived", ourRole: "recipient", counterpartyRole: "sender", relationType: "supplier" },
  platform_settlement: { mode: "derived", ourRole: "recipient", counterpartyRole: "sender", relationType: null },
  payout_report: { mode: "derived", ourRole: "recipient", counterpartyRole: "sender", relationType: null },
  authority_letter: { mode: "derived", ourRole: "recipient", counterpartyRole: "sender", relationType: "authority" },
};

/** A bank statement (self-scanned/photographed, as opposed to the deterministic camt.053/MT940
 * upload paths that never reach the analyzer at all) has no counterparty concept - it is the
 * workspace's own account activity, not a piece of business correspondence with someone else.
 * `reminder`/`letter`/`contract`/`other` are deliberately NOT listed here: they fall through to
 * `planCounterparty`'s `"open"` default. */
const NO_COUNTERPARTY_KINDS: readonly DocumentKind[] = ["bank_statement"];

/**
 * H-contract.md section 2's table, verbatim:
 *
 * | kind | mode | ourRole | counterpartyRole | relationType |
 * |---|---|---|---|---|
 * | `outgoing_invoice` | derived | sender | recipient | `customer` |
 * | `incoming_invoice` | derived | recipient | sender | `supplier` |
 * | `receipt` | derived | recipient | sender | `supplier` |
 * | `platform_settlement` | derived | recipient | sender | `null` |
 * | `payout_report` | derived | recipient | sender | `null` |
 * | `authority_letter` | derived | recipient | sender | `authority` |
 * | `bank_statement` | none | - | - | - |
 * | `reminder` | open | - | - | `null` |
 * | `letter`, `contract`, `other` | open | - | - | `null` |
 */
export function planCounterparty(kind: DocumentKind): CounterpartyPlan {
  const derived = DERIVED_PLANS[kind];
  if (derived) return derived;
  if (NO_COUNTERPARTY_KINDS.includes(kind)) return { mode: "none" };
  return { mode: "open" };
}

/** Wave 2 (H2-wave2.md's self-counterparty check, decisions/0036-guided-extraction.md): `true`
 * for exactly the six kinds with a `"derived"` plan. Once `plan.mode === "derived"`, `direction`
 * can ONLY ever be `"outgoing"`/`"incoming"` (from `plan.ourRole`) or `"unknown"` (the
 * self-counterparty guard fired, `src/persistence/use-cases/documents-use-cases.ts`'s
 * `processOcrDocument`) - there is no third path. So `isDerivedCounterpartyKind(kind) &&
 * direction === "unknown"` is exactly the condition under which that guard fired, which is what
 * `ui/document-detail-client.tsx`'s "Die Richtung dieses Dokuments konnte nicht sicher bestimmt
 * werden" hint keys off - a small, named predicate here keeps the UI from re-deriving that
 * relationship (or, worse, hardcoding its own copy of the six-kind list) itself. */
export function isDerivedCounterpartyKind(kind: DocumentKind): boolean {
  return planCounterparty(kind).mode === "derived";
}
