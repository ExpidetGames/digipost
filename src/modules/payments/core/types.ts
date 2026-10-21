// Owner: src/modules/payments (decisions/0023-payment-matching.md). Pure types only, no I/O.
// `MatchableTransaction`/`MatchableDocument` are this module's OWN shape, deliberately not
// `@/modules/intake`'s `NormalizedTransaction` or `@/persistence/repositories/contracts`'s
// document row: F3b (persistence) maps its own bank-transaction/document rows into these two
// shapes at the call site, which keeps this entire module (and F3a's build) independent of
// F1b's in-flight schema work. See this module's own README ("Public contract for F3b") for
// the exact mapping F3b is expected to provide, in particular why `direction` here is
// deliberately narrower than `documents.direction`'s three-value column.

/** One bank transaction (from a parsed CAMT.053 statement, a bank CSV export, or any future
 * source `@/modules/intake` normalizes) as far as payment matching needs to see it.
 * `amountCents` is signed exactly like `@/modules/intake`'s `NormalizedTransaction`: positive
 * for money in, negative for money out - the sign is what "direction discipline" (never
 * cross) is checked against, see `core/direction.ts`. */
export type MatchableTransaction = {
  id: string;
  /** ISO `YYYY-MM-DD`. */
  bookingDate: string;
  /** Signed: positive = money in (a customer paid us), negative = money out (we paid a
   * supplier). */
  amountCents: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  /** Unstructured + structured remittance text, already joined by the caller exactly like
   * `@/modules/intake/core/camt053-parser.ts`'s `remittanceInformation` - this module never
   * looks at structured/unstructured separately. */
  remittanceText: string | null;
  endToEndId: string | null;
  /** The bank account this transaction posted to - used only to keep matching scoped to one
   * account when a workspace has several; this module does not otherwise interpret it. */
  accountId: string;
  /** `true` for a transaction already known to be a platform payout (Stripe, Apple, ...).
   * Product decision (F3a brief): a platform payout is never matched against an invoice
   * directly by this stage - `core/settlement.ts`'s `decomposeSettlement`/
   * `matchSettlementLinesToDocuments` (F4) is the only path that touches one. Callers are
   * expected to exclude `isPlatformPayout: true` transactions from `matchByRules`/
   * `selectCandidates`/the arbiter entirely; this flag exists so a caller can assert that
   * exclusion rather than silently relying on convention. */
  isPlatformPayout?: boolean;
};

/** Direction discipline only ever needs to know which side of the ledger a document sits on.
 * Deliberately narrower than `@/persistence/repositories/contracts`'s three-value
 * `DocumentDirection` (`incoming | outgoing | unknown`): a document whose direction is not
 * yet known can never be safely auto-matched (the "never cross" rule has nothing to check
 * against), so F3b must exclude `unknown`-direction documents before ever constructing a
 * `MatchableDocument` - never widen this type to accept `"unknown"` as a silent pass-through. */
export type MatchableDocumentDirection = "incoming" | "outgoing";

/** One document with money owed on it (an incoming invoice we must pay, an outgoing invoice
 * a customer must pay us, or a reminder referencing either) as far as payment matching needs
 * to see it. */
export type MatchableDocument = {
  id: string;
  direction: MatchableDocumentDirection;
  invoiceNumber: string | null;
  /** The invoice's original total, signed the same way a credit note already is upstream
   * (decisions/0021-extraction-direction-and-invoice-fields.md) - negative for a credit
   * note. Matching itself always compares against `openAmountCents`, never this field
   * directly, except where a rule explicitly says otherwise (e.g. skonto tolerance is a
   * percentage of the ORIGINAL total, not of what happens to still be open). */
  totalAmountCents: number;
  currency: string;
  /** ISO `YYYY-MM-DD`, or `null` when extraction found none. */
  documentDate: string | null;
  dueDate: string | null;
  paymentIban: string | null;
  contactId: string | null;
  contactIban: string | null;
  contactName: string | null;
  /** What is still unpaid, always `>= 0` (a paid-off document has `0`, never negative) -
   * F3b's own responsibility to keep in sync as partial payments are recorded (see
   * `core/arithmetic.ts`'s `partialPaymentFor`/`remainingOpenAmount`). A document with
   * `openAmountCents === 0` is skipped by every matching stage in this module: there is
   * nothing left to match. */
  openAmountCents: number;
  /** decisions/0071: the document's own OCR text, searched for the reference a card charge
   * carries in its statement descriptor ("FACEBK *4TXV8WLN2B"). Absent or `null` when the
   * caller has none, which simply never produces that signal. */
  referenceText?: string | null;
};

/** Stable, `as const` reason codes (AGENTS.md "Code": never raw text for anything a caller
 * branches on) - the UI translates each into German copy, never the reverse. Kept as one flat
 * set rather than split per stage: a `MatchSuggestion` commonly carries reasons from more than
 * one signal at once (e.g. both `invoice_number_in_remittance` and `iban_match`). */
export const MATCH_REASON_CODES = {
  invoiceNumberInRemittance: "invoice_number_in_remittance",
  customerNumberInRemittance: "customer_number_in_remittance",
  /** decisions/0071: the reference from a card charge's statement descriptor appears in the
   * document's own text. As strong as the invoice number, but only with an exact amount. */
  statementReferenceInDocument: "statement_reference_in_document",
  amountExact: "amount_exact",
  amountWithinSkonto: "amount_within_skonto",
  ibanMatch: "iban_match",
  counterpartyNameMatch: "counterparty_name_match",
  dateWithinWindow: "date_within_window",
  subsetSum: "subset_sum",
  partialPayment: "partial_payment",
  collectivePayment: "collective_payment",
  aliasLearned: "alias_learned",
  aiRanked: "ai_ranked",
  /** decisions/0048-app-store-reports.md: a bank credit paired with an Apple/Google report by
   * `core/app-store-payout-matching.ts` - an exact-amount, platform-named, deterministic match,
   * never itself a signal any other stage produces. */
  platformPayoutMatched: "platform_payout_matched",
} as const;
export type MatchReasonCode = (typeof MATCH_REASON_CODES)[keyof typeof MATCH_REASON_CODES];

export const MATCH_KINDS = {
  exact: "exact",
  skonto: "skonto",
  partial: "partial",
  collective: "collective",
  ai: "ai",
  /** F3b: a human picked this transaction/document pair directly (the "Transaktion manuell
   * verknüpfen" dialog) - never produced by any of the three matching stages themselves,
   * `autoConfirm` is always `false` for it (the same rule an `ai` suggestion follows). */
  manual: "manual",
} as const;
export type MatchKind = (typeof MATCH_KINDS)[keyof typeof MATCH_KINDS];

/** F3b (decisions/0025-payment-matching-wiring.md): the lifecycle of one persisted
 * `document_transactions` row. `suggested` - stages 1-3 proposed it, awaiting a human decision
 * (or already auto-confirmed straight to `confirmed` when `autoConfirm` was `true`).
 * `confirmed` - a real link counted against the document's open amount. `rejected` - a human
 * declined it; kept as a row (not deleted) so the UI can show why it will never be
 * re-suggested, mirroring `payment_rejections`'s own record of the same decision. */
export const DOCUMENT_TRANSACTION_STATUSES = ["suggested", "confirmed", "rejected"] as const;
export type DocumentTransactionStatus = (typeof DOCUMENT_TRANSACTION_STATUSES)[number];

/** F3b: who produced a `confirmed` decision - `auto` (stage 1's `autoConfirm`), `ai` (a human
 * accepted stage 3's ranked suggestion), `user` (a human confirmed a rules/arithmetic
 * suggestion, or linked/rejected manually). Never itself a trust signal beyond provenance -
 * the UI shows it, nothing branches on it besides display. */
export const MATCHED_BY_VALUES = ["auto", "ai", "user"] as const;
export type MatchedBy = (typeof MATCHED_BY_VALUES)[number];

/** One proposed link between one or more transactions and one or more documents.
 * `documentIds`/`transactionIds` are both arrays so a `collective` suggestion (several
 * invoices paid by one transfer) and a future "several transactions settle one invoice"
 * shape can both be represented without a second type - a `rules`/`ai`-stage suggestion
 * always has exactly one of each. */
export type MatchSuggestion = {
  documentIds: string[];
  transactionIds: string[];
  kind: MatchKind;
  /** `0..1`. */
  confidence: number;
  /** Product decision (F3a brief): `true` ONLY when the invoice number was found in the
   * remittance text AND the amount matches (exact or within skonto tolerance) - never for a
   * `partial`/`collective`/`ai` suggestion, regardless of confidence. Every stage in this
   * module that can produce `true` here also has its own standalone-tested predicate
   * (`core/rules.ts`'s `isAutoConfirmMatch`) rather than inlining the condition. */
  autoConfirm: boolean;
  reasons: MatchReasonCode[];
  /** German, one sentence, present ONLY on a `kind: "ai"` suggestion - never populated by any
   * other stage (decisions/0023-payment-matching.md's own prompt requires exactly one
   * sentence; `core/arbiter.ts`'s validation drops anything longer rather than truncating
   * mid-sentence). */
  aiExplanation?: string;
};

/** F3b (decisions/0025-payment-matching-wiring.md): why a `runMatching` call happened -
 * carried on the `match-payments` job payload purely for logging/observability, never
 * branched on inside `runMatching` itself (the three stages run identically regardless of
 * what triggered them; idempotency is what makes a redundant trigger harmless, not a trigger
 * check). `document_done` - C2's `processDocument` extracted invoice fields on a `done`
 * document. `import_batch` - F2's `importFromDocument` imported at least one new transaction.
 * `cron` - the existing sweep (`GET /api/cron/process-jobs`) simply ran a due `match-payments`
 * job like any other; nothing schedules a NEW one periodically on its own (see this module's
 * README "What F3b Adds" update for why a separate periodic re-trigger was rejected). */
export const MATCH_TRIGGERS = ["document_done", "import_batch", "cron"] as const;
export type MatchTrigger = (typeof MATCH_TRIGGERS)[number];

export const PAYMENT_STATUSES = {
  open: "open",
  partiallyPaid: "partially_paid",
  paid: "paid",
  overdue: "overdue",
  settled: "settled",
  noDocumentNeeded: "no_document_needed",
  /** F3b (decisions/0025-payment-matching-wiring.md): the document is not invoice-shaped at
   * all (no `direction`, or no `totalAmountCents`) - there is nothing to pay, so payment
   * matching never applies. `derivePaymentStatus` never produces this value itself (it is
   * always given an actual open/total amount to derive from); it is `documents.payment_status`'s
   * own default/reset value, set directly by the use case for a non-invoice document. */
  notApplicable: "not_applicable",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[keyof typeof PAYMENT_STATUSES];
