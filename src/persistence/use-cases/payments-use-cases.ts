// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md, orchestrating
// F3a's pure domain layer, decisions/0023-payment-matching.md). Inputs are normalized and
// re-checked here even though the Server Action layer already validated them: use cases are
// the last line of defense (WEBAPP_TEMPLATE_SPEC.md §5.4). No `next/*`, `react`,
// `src/platform/*/client`, or a module's own `server.ts`/`client.ts` - only
// `Repositories`/`UnitOfWork` from `src/persistence/repositories/contracts`, the injected
// `PaymentArbiter` port, and pure logic from `@/modules/payments`/`@/modules/contacts`.
//
// `runMatching` is this file's one method worth reading closely first: it is the ONLY place
// F3a's three fixed stages (`matchByRules` -> `findSubsetSums`/`partialPaymentFor` ->
// `PaymentArbiter.rank`) are actually run in sequence, per transaction, stopping at the first
// stage that produces something (decisions/0023's decision 1). It is always safe to call
// twice in a row for the same workspace: `upsertSuggestion` never overwrites an
// already-`confirmed`/`rejected` row, `filterRejectedPairs` drops anything a human already
// declined, and the AI stage's own cache key (`arbiterCacheKey`) skips a repeated model call
// for the identical question, whatever the earlier answer was (decisions/0077).
import { normalizeIban, normalizeName } from "@/modules/contacts";
import { parseIntakeResult } from "@/modules/documents";
import type { SettlementPlatform } from "@/modules/intake";
import {
  applyAliases,
  arbiterCacheKey,
  DEFAULT_SKONTO_TOLERANCE_PERCENT,
  derivePaymentStatus,
  detectPlatformFromText,
  aliasKeyForCounterparty,
  counterpartyNameSimilarity,
  dayDistance,
  DEFAULT_PAYMENT_AUTO_CONFIRM_MODE,
  directionMatches,
  documentNamesStatementReference,
  extractStatementReferences,
  filterRejectedPairs,
  findInvoiceNumbers,
  findSubsetSums,
  hasContradictingInvoiceReference,
  isAutoConfirmMatch,
  isWithinSkontoTolerance,
  looksLikePlatformPayout,
  MATCH_KINDS,
  MATCH_REASON_CODES,
  matchByRules,
  matchSettlementLinesToDocuments,
  NAME_MATCH_THRESHOLD,
  PAYMENT_STATUSES,
  planApplePayoutPairing,
  planGooglePayoutPairing,
  reconcileFeeInvoice,
  rejectedPairKey,
  resolveContactForCounterparty,
  sameCurrency,
  selectCandidateDocuments,
  toCacheableArbiterAnswer,
  validateArbiterResult,
  type AppStorePayoutPairing,
  type AppStoreReportSummary,
  type BankCreditCandidate,
  type ContactAliasMap,
  type MatchableDocument,
  type MatchableTransaction,
  type MatchKind,
  type MatchReasonCode,
  type MatchSuggestion,
  type MatchTrigger,
  type PaymentArbiter,
  type PaymentArbiterRawResult,
  type PaymentAutoConfirmMode,
  type PaymentStatus,
  type RejectedPairSet,
  type SettlementLine,
} from "@/modules/payments";
import type {
  ContactRow,
  DocumentRow,
  DocumentTransactionWithDetails,
  Repositories,
  SettlementLineRow,
  TransactionRow,
  UnitOfWork,
} from "@/persistence/repositories/contracts";
import type { AccountsUseCases } from "@/persistence/use-cases/accounts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { JOB_KINDS } from "@/platform/jobs";
import type { DateRange } from "@/shared/date-range";

export const PAYMENT_ERROR = {
  notFound: "not_found",
  /** Confirming/rejecting a `document_transactions` row that is not (or no longer)
   * `suggested` - a second browser tab, or another admin, already decided it. */
  alreadyDecided: "already_decided",
  /** `linkManually`: the chosen transaction's sign is incompatible with the document's
   * direction (`@/modules/payments`'s `directionMatches`, "never cross", no exception). */
  crossDirection: "cross_direction",
  /** `linkManually` with an explicit `allocatedAmountCents` greater than the document's
   * currently open amount. */
  amountExceedsOpen: "amount_exceeds_open",
  /** `confirmSuggestion`/`linkManually` would claim more of the transaction than is still
   * unallocated (decisions/0025): the same 50,00 EUR debit was confirmed against two copies of
   * one letter. A plain error, the suggestion itself stays `suggested`. */
  amountExceedsTransaction: "amount_exceeds_transaction",
} as const;
export type PaymentErrorCode = (typeof PAYMENT_ERROR)[keyof typeof PAYMENT_ERROR];

export type MatchPaymentsInput = { workspaceId: string; trigger: MatchTrigger };
export type RunMatchingResult = { suggestionsCreated: number; autoConfirmed: number; aiCalls: number };

/** F4 (decisions/0026-platform-settlements.md): `match-settlement-lines` job's payload -
 * enqueued by `AccountsUseCases.importSettlementReport` the moment it inserts at least one new
 * settlement line for this document. */
export type MatchSettlementReportInput = { workspaceId: string; documentId: string };
export type MatchSettlementReportResult = { linesMatched: number; suggestionsCreated: number };

export type DecisionInput = { workspaceId: string; documentTransactionId: string; actingUserId: string };
export type LinkManuallyInput = {
  workspaceId: string;
  documentId: string;
  transactionId: string;
  allocatedAmountCents?: number;
  actingUserId: string;
};
export type MarkNoDocumentNeededInput = { workspaceId: string; transactionIds: string[]; forCounterparty: boolean; actingUserId: string };
export type MarkSettledWithoutPaymentInput = { workspaceId: string; documentId: string; actingUserId: string };

export interface PaymentsUseCases {
  /** decisions/0047: the counterparty names learned for one contact from confirmed payments. */
  listAliasesForContact(input: { workspaceId: string; contactId: string }): Promise<Array<{ id: string; name: string }>>;
  /** decisions/0047: forgets one learned name. */
  deleteAlias(input: { workspaceId: string; aliasId: string }): Promise<void>;
  /** decisions/0068-supplier-clearing-accounts.md: states a payment name for a contact
   * instead of waiting for a confirmation to learn one. A supplier settled through a clearing
   * account never gets a confirmation (matching proposes nothing for it, by design), so its
   * card-merchant name ("FACEBK") has no other way into `payment_aliases` - and without it a
   * charge cannot be resolved to the contact at all. Stored under the same merchant key
   * `maybeLearnAlias` uses, so both paths produce exactly one lookup key. */
  addAliasForContact(input: { workspaceId: string; contactId: string; name: string; actingUserId: string | null }): Promise<void>;
  /** decisions/0044: the workspace's current auto-confirm mode, for the finance page. */
  getAutoConfirmMode(input: { workspaceId: string }): Promise<PaymentAutoConfirmMode>;
  /** decisions/0044: schedules a workspace-wide matching run due now (one queued run per
   * workspace, decisions/0076), e.g. right after an admin changed the auto-confirm mode, so the
   * new mode also applies to the open suggestions. */
  scheduleMatching(input: { workspaceId: string }): Promise<void>;
  runMatching(input: MatchPaymentsInput): Promise<RunMatchingResult>;
  /** F4: matches one confirmed settlement report's `revenue` settlement lines against the
   * workspace's outgoing invoices (`@/modules/payments`'s `matchSettlementLinesToDocuments`),
   * writing `document_transactions` against each revenue line's own clearing-account
   * transaction - an invoice-number match is written straight to `confirmed` (deterministic,
   * per decisions/0026's product model: "outgoing invoices match revenue lines 1:1"), a
   * customer+amount+date match is left `suggested` for a human to confirm (weaker evidence,
   * never auto-confirmed). A no-op (not an error) for a document with no `revenue` lines at
   * all (Apple's own report has none matchable this way, decisions/0026's own read of the F1a
   * fixture) or none still unmatched. */
  matchSettlementReport(input: MatchSettlementReportInput): Promise<MatchSettlementReportResult>;
  confirmSuggestion(input: DecisionInput): Promise<void>;
  rejectSuggestion(input: DecisionInput): Promise<void>;
  /** "Verknüpfung aufheben" - works on a `confirmed` row (unlike `rejectSuggestion`, which
   * only ever applies to a still-`suggested` one). Recomputes the document's payment status
   * afterwards; does NOT write a rejection (a future matching run, or a fresh manual link, may
   * propose this exact pairing again). */
  unlink(input: DecisionInput): Promise<void>;
  linkManually(input: LinkManuallyInput): Promise<void>;
  markNoDocumentNeeded(input: MarkNoDocumentNeededInput): Promise<void>;
  markSettledWithoutPayment(input: MarkSettledWithoutPaymentInput): Promise<void>;
  /** decisions/0072-correcting-a-document-s-kind.md: deletes every still-`suggested` row of one
   * document (confirmed rows and `payment_rejections` are untouched), because they were computed
   * for a kind/direction/amount a human just corrected. Called by `reclassifyDocumentAction` and
   * again by the `process-document` job handler once re-extraction finished. A no-op when there
   * is nothing open. */
  discardOpenSuggestionsForDocument(input: { workspaceId: string; documentId: string }): Promise<void>;

  // Read queries - return FULL data (including amounts/counterparties); redaction for a
  // viewer without `finance.read` happens in `@/modules/payments/server/read-models.ts`,
  // never here (a use case has no notion of the caller's permissions).
  getDocumentPaymentSection(workspaceId: string, documentId: string): Promise<DocumentPaymentSectionData | null>;
  /** `range` (decisions/0066-abschluss-check-and-export.md) narrows "Zuordnung" to one
   * period by `booking_date`, the same date `TransactionRepository.countsForPeriod` scopes
   * "Buchungen ohne Beleg" by. Omitted (the ordinary visit to the page) means every
   * unmatched transaction, as before. */
  listUnmatchedTransactions(workspaceId: string, range?: DateRange): Promise<UnmatchedTransactionData[]>;
  /** `range` narrows "Offene Posten" to one period by the shared document effective date -
   * see `DocumentRepository.listInvoiceCandidates`. */
  listOpenItems(workspaceId: string, range?: DateRange): Promise<OpenItemData[]>;
  /** F4 (decisions/0026-platform-settlements.md): the active (non-`rejected`) `document_transactions`
   * decision for each of `transactionIds`, if any - `@/modules/payments/server/read-models.ts`'s
   * `getSettlementReportProjection` uses this to show a settlement report's own revenue lines
   * as matched/suggested/unmatched ("Rechnung fehlt") without a second bespoke query per line. */
  getTransactionMatchStatuses(workspaceId: string, transactionIds: string[]): Promise<Map<string, TransactionMatchStatus>>;
  /** The "Start" work-list page's "Zahlungen ohne Beleg" bucket - a plain count, so unlike
   * `listUnmatchedTransactions` above there is no amount/counterparty to redact; the page
   * itself still only calls this for a caller with `finance.read` (the same gate every other
   * "Zuordnung"/"Finanzen" surface uses). */
  countUnmatchedTransactions(workspaceId: string): Promise<number>;
  /** The "Start" work-list page's "Offene Vorschläge" bucket. */
  countOpenSuggestions(workspaceId: string): Promise<number>;
}

export type TransactionMatchStatus = { status: "confirmed" | "suggested"; documentId: string; documentTitle: string | null };

export type DocumentPaymentSectionData = {
  paymentStatus: PaymentStatus;
  paidAt: Date | null;
  matchedTransactions: DocumentTransactionWithDetails[];
  suggestions: DocumentTransactionWithDetails[];
  reminderAlreadyPaidAt: Date | null;
  possibleDuplicatePayment: boolean;
};

export type UnmatchedTransactionData = { transaction: TransactionRow; suggestions: DocumentTransactionWithDetails[] };

export type OpenItemData = { document: DocumentRow; contact: ContactRow | null; openAmountCents: number };

type PaymentsUseCaseDeps = {
  repos: Repositories;
  uow: UnitOfWork;
  paymentArbiter: PaymentArbiter;
  /** decisions/0050: booking the payout out of the platform's clearing account is
   * `src/modules/accounts`' own write (it owns `transactions`), so this use case asks for it
   * rather than writing there itself. Optional, so a test that never pairs a platform payout
   * does not have to provide it. */
  accounts?: Pick<AccountsUseCases, "recordPlatformPayout" | "bookContactClearingEntries">;
  now?: () => Date;
};

const TRANSACTION_POOL_LIMIT = 500;
const UNMATCHED_SCAN_PAGE_SIZE = 500;
const FOLLOW_UP_DELAY_MS = 6 * 60 * 60 * 1000;

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toMatchableTransaction(row: TransactionRow): MatchableTransaction {
  return {
    id: row.id,
    bookingDate: row.bookingDate,
    amountCents: row.amountCents,
    currency: row.currency ?? "EUR",
    counterpartyName: row.counterpartyName,
    counterpartyIban: row.counterpartyIban,
    remittanceText: row.remittanceText,
    endToEndId: row.endToEndId,
    accountId: row.accountId,
    // F4 (decisions/0026-platform-settlements.md): real detection, wired from
    // `@/modules/payments`'s `looksLikePlatformPayout` - a BANK transaction whose counterparty
    // name or remittance text names a known settlement platform (this pool never contains a
    // `clearing`-account transaction at all, `TransactionRepository.listForMatching`'s own
    // exclusion) is that platform's payout deposit, never a direct invoice payment; the
    // three-stage engine must not propose matching it against one.
    isPlatformPayout: looksLikePlatformPayout({ counterpartyName: row.counterpartyName, remittanceText: row.remittanceText }) !== null,
  };
}

/** The role to treat as "the" counterparty contact for a document, mirroring
 * `@/modules/documents/core/direction.ts`'s own `expectedRoleFor`: `sender` for an incoming
 * document (we owe THEM), `recipient` for an outgoing one (THEY owe us). Falls back to any
 * non-`mentioned` link, then to whatever is first, rather than `null` outright - a document
 * with exactly one linked contact almost always means that contact regardless of its exact
 * role hint. */
async function resolvePrimaryContact(deps: PaymentsUseCaseDeps, doc: Pick<DocumentRow, "id" | "workspaceId" | "direction">): Promise<ContactRow | null> {
  if (doc.direction !== "incoming" && doc.direction !== "outgoing") return null;
  const links = await deps.repos.documentContact.listForDocument(doc.workspaceId, doc.id);
  if (links.length === 0) return null;
  const expectedRole = doc.direction === "incoming" ? "sender" : "recipient";
  const link = links.find((l) => l.role === expectedRole) ?? links.find((l) => l.role !== "mentioned") ?? links[0]!;
  return deps.repos.contact.findById(doc.workspaceId, link.contactId);
}

async function buildDocumentPool(deps: PaymentsUseCaseDeps, workspaceId: string, clearingContactIds: ReadonlySet<string> = new Set()): Promise<Map<string, MatchableDocument>> {
  const rows = await deps.repos.document.listInvoiceCandidates(workspaceId);
  if (rows.length === 0) return new Map();

  const allocatedByDocument = await deps.repos.documentTransaction.sumConfirmedAllocatedByDocument(
    workspaceId,
    rows.map((r) => r.id),
  );

  const byId = new Map<string, MatchableDocument>();
  for (const row of rows) {
    if (row.direction !== "incoming" && row.direction !== "outgoing") continue;
    if (row.totalAmountCents === null) continue;
    const allocated = allocatedByDocument.get(row.id) ?? 0;
    const openAmountCents = Math.max(0, Math.abs(row.totalAmountCents) - allocated);
    if (openAmountCents <= 0) continue; // already fully settled by a confirmed link; stale `paymentStatus` will catch up

    const contact = await resolvePrimaryContact(deps, row);
    // decisions/0068-supplier-clearing-accounts.md: a supplier with a clearing account is
    // settled by that account, not document by document - proposing a pairing for one of its
    // invoices is asking a question that has no answer, which is what produced the wrong Meta
    // suggestions this feature exists to stop.
    if (contact && clearingContactIds.has(contact.id)) continue;
    byId.set(row.id, {
      id: row.id,
      direction: row.direction,
      invoiceNumber: row.invoiceNumber,
      totalAmountCents: row.totalAmountCents,
      currency: row.currency ?? "EUR",
      documentDate: row.documentDate,
      dueDate: row.dueDate,
      paymentIban: row.paymentIban,
      contactId: contact?.id ?? null,
      contactIban: contact?.iban ?? null,
      contactName: contact?.name ?? null,
      openAmountCents,
      referenceText: row.ocrText,
    });
  }
  return byId;
}

async function buildTransactionPool(deps: PaymentsUseCaseDeps, workspaceId: string): Promise<MatchableTransaction[]> {
  const rows = await deps.repos.transaction.listForMatching(workspaceId, { limit: TRANSACTION_POOL_LIMIT });
  return rows.map(toMatchableTransaction);
}

/** decisions/0068-supplier-clearing-accounts.md: the contacts this workspace settles through
 * a clearing account of their own. Matching stops proposing pairings for them in BOTH
 * directions - their documents never enter the candidate pool, and a transaction that
 * resolves to one of them is skipped (`excludeClearingContactTransactions` below). */
async function loadClearingContactIds(deps: PaymentsUseCaseDeps, workspaceId: string): Promise<Set<string>> {
  const accounts = await deps.repos.account.listForWorkspace(workspaceId);
  const ids = accounts.filter((account) => account.type === "clearing" && account.contactId !== null).map((account) => account.contactId!);
  return new Set(ids);
}

/** The transaction half of that exclusion, resolved exactly the way the clearing account's
 * own booking resolves a charge (`@/modules/payments`'s `resolveContactForCounterparty`:
 * learned payment names first, then the card-merchant name comparison), so the two can never
 * disagree about which charges belong to a clearing-account supplier. */
async function excludeClearingContactTransactions(
  deps: PaymentsUseCaseDeps,
  workspaceId: string,
  pool: MatchableTransaction[],
  clearingContactIds: ReadonlySet<string>,
): Promise<MatchableTransaction[]> {
  if (clearingContactIds.size === 0 || pool.length === 0) return pool;
  const [contacts, aliasRows] = await Promise.all([
    deps.repos.contact.listAllForWorkspace(workspaceId),
    deps.repos.paymentAlias.listForWorkspace(workspaceId),
  ]);
  const aliases: ContactAliasMap = new Map(aliasRows.map((row) => [row.counterpartyNameNormalized, row.contactId]));
  return pool.filter((tx) => {
    const contactId = resolveContactForCounterparty(tx.counterpartyName, contacts, aliases);
    return contactId === null || !clearingContactIds.has(contactId);
  });
}

/** Applies every standing "kein Beleg nötig, für diese Gegenpartei immer" rule
 * (`payment_no_document_rules`) to whatever is CURRENTLY unmatched - a rule learned after some
 * of that counterparty's transactions already arrived must still catch up on them, not only
 * future imports. */
async function applyNoDocumentRules(deps: PaymentsUseCaseDeps, workspaceId: string): Promise<void> {
  const rules = await deps.repos.paymentNoDocumentRule.listForWorkspace(workspaceId);
  if (rules.length === 0) return;
  const ruleNames = new Set(rules.map((r) => r.counterpartyNameNormalized));

  const { items } = await deps.repos.transaction.listUnmatched(workspaceId, { page: 1, pageSize: UNMATCHED_SCAN_PAGE_SIZE });
  const toMark = items.filter((tx) => tx.counterpartyName && ruleNames.has(normalizeName(tx.counterpartyName))).map((tx) => tx.id);
  if (toMark.length > 0) await deps.repos.transaction.markNoDocumentNeeded(workspaceId, toMark);
}

function isoMonthRange(documentDateIso: string): { monthStart: string; monthEnd: string } {
  const [yearStr, monthStr] = documentDateIso.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const monthStart = `${yearStr}-${monthStr}-01`;
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { monthStart, monthEnd };
}

/** F4 (decisions/0026-platform-settlements.md): "an incoming invoice whose sender is the
 * platform contact ... gets payment status `settled` (never `open`) when the fee sum of the
 * invoice's period matches within tolerance" - called from both `runMatching` (so an ordinary
 * matching pass eventually catches a fee invoice that arrived before its settlement report
 * did) and `matchSettlementReport` directly (so importing the report settles an
 * ALREADY-confirmed fee invoice immediately, not on the next cron pass). Every open
 * `incoming_invoice` document whose resolved primary contact's name names a known platform is
 * a candidate; one with no invoice period (`documentDate`), no clearing account for that
 * platform yet, or no fee lines in that period yet is simply left `open` for a later pass to
 * retry - never an error. */
async function attemptFeeInvoiceSettlement(deps: PaymentsUseCaseDeps, workspaceId: string, now: Date): Promise<number> {
  const candidates = await deps.repos.document.listInvoiceCandidates(workspaceId);
  const feeInvoiceCandidates = candidates.filter((doc) => doc.direction === "incoming" && doc.kind === "incoming_invoice" && doc.totalAmountCents !== null && doc.documentDate !== null);
  let settledCount = 0;

  for (const doc of feeInvoiceCandidates) {
    const contact = await resolvePrimaryContact(deps, doc);
    const platform: SettlementPlatform | null = detectPlatformFromText(contact?.name ?? null);
    if (!platform) continue;

    const clearingAccount = await deps.repos.account.findByPlatform(workspaceId, platform);
    if (!clearingAccount) continue;

    const { monthStart, monthEnd } = isoMonthRange(doc.documentDate!);
    const feeSumCents = await deps.repos.settlementLine.sumFeeCentsForAccountAndPeriod(clearingAccount.id, monthStart, monthEnd);
    if (feeSumCents === 0) continue;

    const reconciliation = reconcileFeeInvoice(feeSumCents, Math.abs(doc.totalAmountCents!));
    if (!reconciliation.matches) continue;

    await deps.repos.document.updatePaymentStatus(workspaceId, doc.id, { paymentStatus: PAYMENT_STATUSES.settled, paidAt: doc.paidAt ?? now });
    settledCount++;
  }

  return settledCount;
}

/** Every confirmed Apple/Google settlement report in `platform`, mapped to
 * `core/app-store-payout-matching.ts`'s own input shape, excluding one that already has ANY
 * `document_transactions` row (confirmed, suggested, or rejected) - a human decision or an
 * already-open suggestion is never silently second-guessed by this pass; a rejected report
 * needs a human ("Transaktion manuell verknüpfen") to move it forward, not another automatic
 * attempt at the exact same evidence. `intakeResult.appStorePayout` is absent for every OTHER
 * confirmed settlement report (the generic AI-mapped path, e.g. Stripe) - filtered out here,
 * never a match candidate for this deterministic pairing at all. */
async function pendingAppStoreReports(
  deps: PaymentsUseCaseDeps,
  workspaceId: string,
  platform: Extract<SettlementPlatform, "apple" | "google">,
): Promise<AppStoreReportSummary[]> {
  const rows = await deps.repos.document.listConfirmedSettlementReports(workspaceId, platform);
  const pending: AppStoreReportSummary[] = [];
  for (const row of rows) {
    const intakeResult = parseIntakeResult(row.intakeResult);
    if (intakeResult?.type !== "tabular_confirmed" || !intakeResult.appStorePayout || intakeResult.appStorePayout.platform !== platform) continue;
    const links = await deps.repos.documentTransaction.listForDocument(workspaceId, row.id);
    if (links.length > 0) continue;
    const { period, payoutAmountCents } = intakeResult.appStorePayout;
    pending.push({ documentId: row.id, platform, period, payoutAmountCents });
  }
  return pending;
}

/**
 * decisions/0048-app-store-reports.md: the owner's own actual goal for the feature - every
 * Apple/Google credit on the bank account gets its report as the document that explains it.
 * Candidates are the workspace's currently unmatched (positive) transactions
 * (`TransactionRepository.listUnmatched`, the same "Zuordnung" pool, already excluding a
 * `clearing`-account row and one already `confirmed` elsewhere); `core/app-store-payout-matching.ts`'s
 * `planApplePayoutPairing`/`planGooglePayoutPairing` do the actual exact-amount, unambiguous
 * matching, never this function itself.
 *
 * Called from both `matchSettlementReport` (a newly imported report might already have its
 * bank credit waiting) and `runMatching` (a freshly imported bank statement might be the event
 * a still-unpaired report was waiting for) - the same "both trigger points" shape
 * `attemptFeeInvoiceSettlement` above already uses.
 *
 * Deterministic, so it follows `payment_auto_confirm` exactly like every other deterministic
 * match in this module (decisions/0044): `system`/`all` write straight to `confirmed` (which
 * alone is what makes `listUnmatched`'s own `notConfirmed` check stop surfacing that credit -
 * no separate "kein Beleg nötig" write needed), `none` leaves a `suggested` row for a human.
 * `kind: "collective"` is used for BOTH Apple's always-single-document case and Google's
 * possibly-multi-document one - deliberately, not only for Google: it is the one `MatchKind`
 * `keepClosestSuggestions`' date/amount-closest pruning already skips outright (these reports
 * carry no `totalAmountCents`/`documentDate` of their own for that heuristic to reason about
 * anyway) and `applyAutoConfirmPolicy`'s own per-row scan already never touches (this function
 * decides confirm-vs-suggest itself, directly, the same bypass `matchSettlementReport`'s own
 * invoice-number branch already uses for its own equally deterministic case).
 */
async function attemptAppStorePayoutPairing(deps: PaymentsUseCaseDeps, workspaceId: string, now: Date): Promise<number> {
  const autoConfirmMode = (await deps.repos.workspace.findById(workspaceId))?.paymentAutoConfirm ?? DEFAULT_PAYMENT_AUTO_CONFIRM_MODE;

  const [applePending, googlePending, { items: unmatched }] = await Promise.all([
    pendingAppStoreReports(deps, workspaceId, "apple"),
    pendingAppStoreReports(deps, workspaceId, "google"),
    deps.repos.transaction.listUnmatched(workspaceId, { page: 1, pageSize: UNMATCHED_SCAN_PAGE_SIZE }),
  ]);
  if (applePending.length === 0 && googlePending.length === 0) return 0;

  let candidates: BankCreditCandidate[] = unmatched
    .filter((tx) => tx.amountCents > 0)
    .map((tx) => ({ transactionId: tx.id, amountCents: tx.amountCents, bookingDate: tx.bookingDate, counterpartyName: tx.counterpartyName, remittanceText: tx.remittanceText }));

  const creditById = new Map(candidates.map((candidate) => [candidate.transactionId, candidate]));

  const applePairings: AppStorePayoutPairing[] = [];
  for (const report of [...applePending].sort((a, b) => a.period.localeCompare(b.period))) {
    const pairing = planApplePayoutPairing(report, candidates);
    if (!pairing) continue;
    applePairings.push(pairing);
    candidates = candidates.filter((c) => c.transactionId !== pairing.transactionId);
  }
  const googlePairings = planGooglePayoutPairing(googlePending, candidates);

  const payoutAmountByDocumentId = new Map<string, number>();
  const platformByDocumentId = new Map<string, "apple" | "google">();
  for (const report of [...applePending, ...googlePending]) {
    payoutAmountByDocumentId.set(report.documentId, report.payoutAmountCents);
    platformByDocumentId.set(report.documentId, report.platform);
  }

  let pairedCount = 0;
  for (const pairing of [...applePairings, ...googlePairings]) {
    for (const documentId of pairing.documentIds) {
      const allocatedAmountCents = payoutAmountByDocumentId.get(documentId) ?? 0;
      const shared = {
        workspaceId,
        documentId,
        transactionId: pairing.transactionId,
        kind: MATCH_KINDS.collective,
        confidence: 1,
        reasons: [MATCH_REASON_CODES.amountExact, MATCH_REASON_CODES.platformPayoutMatched],
        explanation: null,
        allocatedAmountCents,
        arbiterCacheKey: null,
      };
      if (autoConfirmMode === "none") {
        await deps.repos.documentTransaction.upsertSuggestion({ ...shared, status: "suggested", matchedBy: "auto", decidedAt: null, decidedByUserId: null });
      } else {
        await deps.repos.documentTransaction.createConfirmed({ ...shared, status: "confirmed", matchedBy: "auto", decidedAt: now, decidedByUserId: null });
      }
    }
    // decisions/0050: a confirmed pairing also moves the money out of the platform's clearing
    // account, so its balance shows what the platform still owes. A suggestion does not: nothing
    // is booked until a human has agreed.
    if (autoConfirmMode !== "none") {
      const platform = pairing.documentIds.length > 0 ? platformByDocumentId.get(pairing.documentIds[0]!) : undefined;
      const credit = creditById.get(pairing.transactionId);
      if (platform && credit) {
        await deps.accounts?.recordPlatformPayout({
          workspaceId,
          platform,
          amountCents: pairing.totalAmountCents,
          bookingDate: credit.bookingDate,
          bankTransactionId: pairing.transactionId,
          reference: credit.remittanceText,
        });
      }
    }
    pairedCount++;
  }

  return pairedCount;
}

/** Whether ANY textual/relational signal at all corroborates `doc` for `tx` - the same "never
 * an amount-only coincidence" gate `core/rules.ts`'s `matchByRules` enforces for stage 1,
 * re-applied here for stage 2's own weaker (subset-sum solo, partial) suggestions so they do
 * not spam a human with a suggestion built from amount alone. */
function hasCorroboratingSignal(tx: MatchableTransaction, doc: MatchableDocument): { invoiceNumberFound: boolean; anySignal: boolean } {
  const invoiceNumberFound = doc.invoiceNumber !== null && findInvoiceNumbers(tx.remittanceText, [doc.invoiceNumber]).length > 0;
  // decisions/0071: the card descriptor's reference printed on the receipt corroborates the pair
  // too, but never counts as the invoice number here (stage 2 never pays it with an exact amount).
  const referenceFound = documentNamesStatementReference(doc.referenceText, extractStatementReferences(tx));
  const ibanMatches = tx.counterpartyIban !== null && doc.contactIban !== null && normalizeIban(tx.counterpartyIban) === normalizeIban(doc.contactIban);
  const nameMatches = doc.contactName !== null && tx.counterpartyName !== null && normalizeName(tx.counterpartyName) === normalizeName(doc.contactName);
  return { invoiceNumberFound, anySignal: invoiceNumberFound || referenceFound || ibanMatches || nameMatches };
}

/** Stage 1's own alias corroboration (F3a's `applyAliases`, unwired until this phase): a
 * learned counterparty-name alias resolves straight to a contact id, which is treated as
 * equivalent to a name-similarity match for a candidate document belonging to that same
 * contact - the exact scenario the alias exists for (a remittance line reading a trading name
 * too different from the contact's own registered name for `counterpartyNameSimilarity` to
 * ever catch on its own). `autoConfirm` still runs through the same `isAutoConfirmMatch`
 * predicate as every other rules-stage suggestion (an alias is never itself sufficient to
 * auto-confirm; the invoice number must still be found).
 */
function aliasBoostSuggestions(tx: MatchableTransaction, docPool: Map<string, MatchableDocument>, aliasedContactId: string): MatchSuggestion[] {
  const paidCents = Math.abs(tx.amountCents);
  const suggestions: MatchSuggestion[] = [];
  for (const doc of docPool.values()) {
    if (doc.contactId !== aliasedContactId) continue;
    if (doc.openAmountCents <= 0) continue;
    if (!directionMatches(tx, doc)) continue;
    // decisions/0033: an alias boost is still a stage-1, rules-shaped suggestion - the same
    // contradicting-invoice-number veto `core/rules.ts`'s `matchByRules` applies must hold here
    // too, since a matching alias/amount alone must never override a textual contradiction.
    if (hasContradictingInvoiceReference(tx.remittanceText, doc.invoiceNumber)) continue;

    const invoiceNumberInText = doc.invoiceNumber !== null && findInvoiceNumbers(tx.remittanceText, [doc.invoiceNumber]).length > 0;
    const exact = paidCents === doc.openAmountCents;
    const skonto = !exact && isWithinSkontoTolerance(paidCents, doc.openAmountCents, DEFAULT_SKONTO_TOLERANCE_PERCENT);
    if (!exact && !skonto) continue;
    // decisions/0071: the same exact-amount statement-reference signal `matchByRules` uses.
    const statementReferenceFound = exact && documentNamesStatementReference(doc.referenceText, extractStatementReferences(tx));
    const invoiceNumberFound = invoiceNumberInText || statementReferenceFound;

    const kind: MatchKind = exact ? MATCH_KINDS.exact : MATCH_KINDS.skonto;
    const autoConfirm = isAutoConfirmMatch({ invoiceNumberFound, amountMatchKind: exact ? "exact" : "skonto", directionOk: true });
    let confidence: number;
    if (invoiceNumberFound) confidence = exact ? 0.97 : 0.9;
    else confidence = exact ? 0.7 : 0.6;
    const reasons: MatchReasonCode[] = [MATCH_REASON_CODES.aliasLearned, exact ? MATCH_REASON_CODES.amountExact : MATCH_REASON_CODES.amountWithinSkonto];
    if (invoiceNumberInText) reasons.push(MATCH_REASON_CODES.invoiceNumberInRemittance);
    if (statementReferenceFound) reasons.push(MATCH_REASON_CODES.statementReferenceInDocument);

    suggestions.push({ documentIds: [doc.id], transactionIds: [tx.id], kind, confidence, autoConfirm, reasons });
  }
  return suggestions;
}

/** How much of `tx` confirmed links do not claim yet. */
async function unallocatedTransactionCents(deps: PaymentsUseCaseDeps, workspaceId: string, tx: { id: string; amountCents: number }): Promise<number> {
  const allocated = await deps.repos.documentTransaction.sumConfirmedAllocatedByTransaction(workspaceId, [tx.id]);
  return Math.abs(tx.amountCents) - (allocated.get(tx.id) ?? 0);
}

/** decisions/0025: a new confirmed link may not claim more of a transaction than is still
 * unallocated. Two allocations legitimately exceed the paid amount and are left alone: a skonto
 * match (the document is settled in full by a smaller payment) and a document in another
 * currency (its cents are not comparable with the transaction's, decisions/0044). */
function exceedsTransaction(unallocatedCents: number, allocationCents: number, kind: MatchKind, docCurrency: string | null, txCurrency: string | null): boolean {
  if (kind === MATCH_KINDS.skonto) return false;
  if ((docCurrency ?? "EUR").toUpperCase() !== (txCurrency ?? "EUR").toUpperCase()) return false;
  return allocationCents > unallocatedCents;
}

/** `confirmSuggestion`'s guard: the suggestion was computed against amounts that may have been
 * claimed since (another suggestion for the same transaction or document confirmed first). */
async function assertAllocationFits(
  deps: PaymentsUseCaseDeps,
  workspaceId: string,
  input: { documentId: string; transactionId: string; allocatedAmountCents: number; kind: MatchKind },
): Promise<void> {
  const [doc, tx] = await Promise.all([deps.repos.document.findById(workspaceId, input.documentId), deps.repos.transaction.findById(workspaceId, input.transactionId)]);
  if (!doc || !tx) throw new UseCaseError(PAYMENT_ERROR.notFound);
  const allocatedByDocument = await deps.repos.documentTransaction.sumConfirmedAllocatedByDocument(workspaceId, [doc.id]);
  const openAmountCents = Math.abs(doc.totalAmountCents ?? 0) - (allocatedByDocument.get(doc.id) ?? 0);
  if (input.allocatedAmountCents > openAmountCents) throw new UseCaseError(PAYMENT_ERROR.amountExceedsOpen);
  if (exceedsTransaction(await unallocatedTransactionCents(deps, workspaceId, tx), input.allocatedAmountCents, input.kind, doc.currency, tx.currency))
    throw new UseCaseError(PAYMENT_ERROR.amountExceedsTransaction);
}

/** How much of the transaction's paid amount this document's own `document_transactions` row
 * should claim - the exact-match/AI/manual cases apply the smaller of paid vs. open (they can
 * never claim more than what is actually owed); `skonto`/`collective` apply the document's own
 * FULL remaining open amount (a skonto discount, or a collective payment's own subset-sum
 * result, settles the document entirely despite the transaction paying slightly less/exactly
 * that share). */
function computeAllocation(kind: MatchKind, doc: MatchableDocument, tx: MatchableTransaction): number {
  // decisions/0044: a foreign-currency document is settled in full by its (converted) payment;
  // subtracting EUR cents from USD cents would leave a meaningless remainder open.
  if (kind === MATCH_KINDS.skonto || kind === MATCH_KINDS.collective || !sameCurrency(tx, doc)) return doc.openAmountCents;
  return Math.min(Math.abs(tx.amountCents), doc.openAmountCents);
}

async function recomputeDocumentStatus(deps: PaymentsUseCaseDeps, workspaceId: string, documentId: string, now: Date): Promise<void> {
  const doc = await deps.repos.document.findById(workspaceId, documentId);
  if (!doc || doc.totalAmountCents === null || (doc.direction !== "incoming" && doc.direction !== "outgoing")) return;

  const allocatedByDocument = await deps.repos.documentTransaction.sumConfirmedAllocatedByDocument(workspaceId, [documentId]);
  const openAmountCents = Math.max(0, Math.abs(doc.totalAmountCents) - (allocatedByDocument.get(documentId) ?? 0));
  const status = derivePaymentStatus({ totalAmountCents: doc.totalAmountCents, openAmountCents, dueDate: doc.dueDate, todayIso: toIso(now) });
  // `paidAt` is set once, the moment the document first becomes `paid` - never cleared
  // automatically by a later `unlink` reopening it (see `src/persistence/schema/documents.ts`'s
  // own header comment for why).
  const paidAt = status === PAYMENT_STATUSES.paid ? (doc.paidAt ?? now) : doc.paidAt;
  await deps.repos.document.updatePaymentStatus(workspaceId, documentId, { paymentStatus: status, paidAt });
  if (status === PAYMENT_STATUSES.paid) await dropOpenSuggestionsForDocument(deps, workspaceId, documentId);
}

/** decisions/0043: a recurring charge (IONOS 3,50 EUR every month) makes every monthly invoice
 * match every equal debit of the same vendor inside the candidate window. The right pairing is
 * the closest date, so a transaction keeps only its date-closest rules suggestion(s); a tie is
 * kept for a human. A suggestion that auto-confirms (it carries the invoice number) is never
 * filtered: that signal is stronger than any date. */
function closestByDate(tx: MatchableTransaction, suggestions: MatchSuggestion[], docPool: Map<string, MatchableDocument>): MatchSuggestion[] {
  if (suggestions.length <= 1 || suggestions.some((s) => s.autoConfirm)) return suggestions;
  // decisions/0044: an exact amount outranks any date, then the closest date wins.
  const rankOf = (s: MatchSuggestion) => {
    const doc = docPool.get(s.documentIds[0]!);
    const exact = doc !== undefined && Math.abs(tx.amountCents) === doc.openAmountCents ? 0 : 1;
    return exact * 1_000_000 + Math.min(dayDistance(doc?.documentDate ?? doc?.dueDate ?? null, tx.bookingDate), 999_999);
  };
  const best = Math.min(...suggestions.map(rankOf));
  return suggestions.filter((s) => rankOf(s) === best);
}

/** decisions/0043: the same cleanup across runs and in the other direction. Among open
 * suggestions (collective ones excluded, they link several documents on purpose), each
 * transaction keeps its date-closest document, then each document its date-closest transaction.
 * Ties survive for a human to decide. */
async function keepClosestSuggestions(deps: PaymentsUseCaseDeps, workspaceId: string): Promise<void> {
  const rows = (await deps.repos.documentTransaction.listSuggestedForWorkspace(workspaceId)).filter((row) => row.kind !== MATCH_KINDS.collective);
  if (rows.length < 2) return;
  const documents = new Map<string, { date: string | null; totalCents: number | null }>();
  for (const documentId of new Set(rows.map((row) => row.documentId))) {
    const doc = await deps.repos.document.findById(workspaceId, documentId);
    documents.set(documentId, { date: doc?.documentDate ?? doc?.dueDate ?? null, totalCents: doc?.totalAmountCents ?? null });
  }
  // decisions/0044: an exact amount outranks any date (observed: a 45,20 EUR IONOS debit kept its
  // 3,50 EUR invoice three days away and lost the 45,20 EUR one six days away), then the date.
  const distance = (row: (typeof rows)[number]) => {
    const doc = documents.get(row.documentId);
    const exact = doc?.totalCents !== null && doc?.totalCents !== undefined && Math.abs(doc.totalCents) === Math.abs(row.transactionAmountCents) ? 0 : 1;
    return exact * 1_000_000 + Math.min(dayDistance(doc?.date ?? null, row.transactionBookingDate), 999_999);
  };
  const dropped = new Set<string>();
  const keepClosestPer = (keyOf: (row: (typeof rows)[number]) => string) => {
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      if (dropped.has(row.id)) continue;
      groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const best = Math.min(...group.map(distance));
      for (const row of group) if (distance(row) > best) dropped.add(row.id);
    }
  };
  keepClosestPer((row) => row.transactionId);
  keepClosestPer((row) => row.documentId);
  for (const id of dropped) await deps.repos.documentTransaction.deleteById(workspaceId, id);
}

async function dropOpenDeterministicSuggestions(deps: PaymentsUseCaseDeps, workspaceId: string): Promise<void> {
  const rows = await deps.repos.documentTransaction.listSuggestedForWorkspace(workspaceId);
  for (const row of rows) {
    if (row.kind !== MATCH_KINDS.ai) await deps.repos.documentTransaction.deleteById(workspaceId, row.id);
  }
}

/** decisions/0044: confirms the open suggestions the workspace's mode allows, but only the
 * unambiguous ones: the only open suggestion of its transaction and of its document, for a
 * transaction not already confirmed elsewhere. "system" skips AI suggestions, "all" includes
 * them, "none" confirms nothing. Collective suggestions link several documents on purpose and
 * are never unambiguous here. Runs after the date-closest cleanup, so a recurring charge is
 * already reduced to one pairing per month. Also applies a mode an admin just switched to. */
async function applyAutoConfirmPolicy(deps: PaymentsUseCaseDeps, workspaceId: string, mode: PaymentAutoConfirmMode, now: Date): Promise<number> {
  if (mode === "none") return 0;
  const rows = await deps.repos.documentTransaction.listSuggestedForWorkspace(workspaceId);
  const perTransaction = new Map<string, number>();
  const perDocument = new Map<string, number>();
  for (const row of rows) {
    perTransaction.set(row.transactionId, (perTransaction.get(row.transactionId) ?? 0) + 1);
    perDocument.set(row.documentId, (perDocument.get(row.documentId) ?? 0) + 1);
  }
  let confirmed = 0;
  for (const row of rows) {
    if (row.kind === MATCH_KINDS.collective) continue;
    if (mode === "system" && row.kind === MATCH_KINDS.ai) continue;
    if (perTransaction.get(row.transactionId) !== 1 || perDocument.get(row.documentId) !== 1) continue;
    const links = await deps.repos.documentTransaction.listForTransaction(workspaceId, row.transactionId);
    if (links.some((link) => link.status === "confirmed")) continue;
    await deps.repos.documentTransaction.decide(workspaceId, row.id, { status: "confirmed", matchedBy: "auto", decidedByUserId: null });
    await recomputeDocumentStatus(deps, workspaceId, row.documentId, now);
    await maybeLearnAlias(deps, workspaceId, row.documentId, row.transactionId, null);
    confirmed++;
  }
  return confirmed;
}

/** decisions/0039: a fully paid document has nothing left to match, so its remaining
 * `suggested` rows are stale noise. Observed: invoice 42 kept an AI suggestion that a parallel
 * matching run created one second before its exact payment was auto-confirmed. */
async function dropOpenSuggestionsForDocument(deps: PaymentsUseCaseDeps, workspaceId: string, documentId: string): Promise<void> {
  const rows = await deps.repos.documentTransaction.listForDocument(workspaceId, documentId);
  for (const row of rows) {
    if (row.status === "suggested") await deps.repos.documentTransaction.deleteById(workspaceId, row.id);
  }
}

/** The same cleanup across the workspace, run at the end of every matching pass, because two
 * passes running in parallel can each create a suggestion after the other's confirmation.
 * `settled` counts too (decisions/0068-supplier-clearing-accounts.md): a document a clearing
 * account settles has just as little left to match as a fully paid one, including an AI
 * suggestion an earlier run left behind before the account existed. */
async function dropSuggestionsForSettledDocuments(deps: PaymentsUseCaseDeps, workspaceId: string): Promise<void> {
  const suggested = await deps.repos.documentTransaction.listSuggestedForWorkspace(workspaceId);
  for (const documentId of new Set(suggested.map((row) => row.documentId))) {
    const doc = await deps.repos.document.findById(workspaceId, documentId);
    if (doc?.paymentStatus === PAYMENT_STATUSES.paid || doc?.paymentStatus === PAYMENT_STATUSES.settled) {
      await dropOpenSuggestionsForDocument(deps, workspaceId, documentId);
    }
  }
}

/** Confirming a suggestion learns an alias when BOTH the transaction's counterparty name and
 * the document's own primary contact are known (F3b scope item 3) - never overwrites a
 * differently-learned alias silently in a way that loses information, `PaymentAliasRepository.upsert`
 * simply keeps the LATEST confirmation, which is the intended "the most recent human decision
 * wins" behavior. */
async function maybeLearnAlias(
  deps: PaymentsUseCaseDeps,
  workspaceId: string,
  documentId: string,
  transactionId: string,
  learnedFromUserId: string | null,
): Promise<void> {
  const [tx, doc] = await Promise.all([deps.repos.transaction.findById(workspaceId, transactionId), deps.repos.document.findById(workspaceId, documentId)]);
  if (!tx?.counterpartyName || !doc) return;
  const contact = await resolvePrimaryContact(deps, doc);
  if (!contact) return;
  // decisions/0047: only a name that really differs from the contact's is worth remembering;
  // the key is the stable merchant form, so next month's card debit hits it again.
  if (counterpartyNameSimilarity(tx.counterpartyName, contact.name) >= NAME_MATCH_THRESHOLD) return;
  await deps.repos.paymentAlias.upsert({
    workspaceId,
    counterpartyNameNormalized: aliasKeyForCounterparty(tx.counterpartyName),
    contactId: contact.id,
    learnedFromUserId,
  });
}

/** `runMatching`'s own idempotent-tail: as long as the workspace still has an unresolved
 * `suggested` row or an unmatched, non-excluded transaction, schedule one more pass a few
 * hours out (`trigger: "cron"`) - the existing sweep (`GET /api/cron/process-jobs`) picks it
 * up like any other due job, so this phase needs no dedicated cron route of its own
 * (decisions/0025's "AI stage caching and the cron trigger" section). Once nothing remains
 * unresolved, the chain simply stops; any future document/import event restarts it. */
async function scheduleFollowUpIfNeeded(deps: PaymentsUseCaseDeps, workspaceId: string, now: Date): Promise<void> {
  const [{ items: unmatched }, suggested] = await Promise.all([
    deps.repos.transaction.listUnmatched(workspaceId, { page: 1, pageSize: 1 }),
    deps.repos.documentTransaction.listSuggestedForWorkspace(workspaceId),
  ]);
  if (unmatched.length === 0 && suggested.length === 0) return;
  // decisions/0039: at most one follow-up per workspace. Without this every run (each upload's
  // document_done run, each follow-up) queued another one, and since almost every workspace has
  // unmatched transactions that never get a document (fees, salaries), the chains never ended:
  // 26 were queued after one bulk upload, each calling the AI arbiter every 6 hours.
  // decisions/0076: any queued run counts, also one due right now (a document finished while
  // this run was going); that run schedules its own follow-up when it finishes.
  if (await deps.repos.jobs.hasQueuedPending({ kind: JOB_KINDS.matchPayments, workspaceId, now })) return;

  await deps.repos.jobs.enqueue({
    kind: JOB_KINDS.matchPayments,
    workspaceId,
    runAt: new Date(now.getTime() + FOLLOW_UP_DELAY_MS),
    payload: { workspaceId, trigger: "cron" } satisfies MatchPaymentsInput,
  });
}

export function createPaymentsUseCases(deps: PaymentsUseCaseDeps): PaymentsUseCases {
  const now = deps.now ?? (() => new Date());

  async function persistSuggestion(workspaceId: string, tx: MatchableTransaction, suggestion: MatchSuggestion, docPool: Map<string, MatchableDocument>, allowAutoConfirm: boolean): Promise<boolean> {
    let autoConfirmedAny = false;
    for (const documentId of suggestion.documentIds) {
      const doc = docPool.get(documentId);
      if (!doc) continue;
      const allocatedAmountCents = computeAllocation(suggestion.kind, doc, tx);

      if (suggestion.autoConfirm && allowAutoConfirm) {
        await deps.repos.documentTransaction.createConfirmed({
          workspaceId,
          documentId,
          transactionId: tx.id,
          status: "confirmed",
          kind: suggestion.kind,
          confidence: suggestion.confidence,
          reasons: suggestion.reasons,
          explanation: suggestion.aiExplanation ?? null,
          matchedBy: "auto",
          allocatedAmountCents,
          arbiterCacheKey: null,
          decidedAt: now(),
          decidedByUserId: null,
        });
        doc.openAmountCents = Math.max(0, doc.openAmountCents - allocatedAmountCents);
        await recomputeDocumentStatus(deps, workspaceId, documentId, now());
        await maybeLearnAlias(deps, workspaceId, documentId, tx.id, null);
        autoConfirmedAny = true;
      } else {
        await deps.repos.documentTransaction.upsertSuggestion({
          workspaceId,
          documentId,
          transactionId: tx.id,
          status: "suggested",
          kind: suggestion.kind,
          confidence: suggestion.confidence,
          reasons: suggestion.reasons,
          explanation: suggestion.aiExplanation ?? null,
          matchedBy: suggestion.kind === MATCH_KINDS.ai ? "ai" : "auto",
          allocatedAmountCents,
          arbiterCacheKey: null,
          decidedAt: null,
          decidedByUserId: null,
        });
      }
    }
    return autoConfirmedAny;
  }

  return {
    async listAliasesForContact({ workspaceId, contactId }) {
      const rows = await deps.repos.paymentAlias.listForWorkspace(workspaceId);
      return rows.filter((row) => row.contactId === contactId).map((row) => ({ id: row.id, name: row.counterpartyNameNormalized }));
    },

    async deleteAlias({ workspaceId, aliasId }) {
      await deps.repos.paymentAlias.deleteById(workspaceId, aliasId);
    },

    async addAliasForContact({ workspaceId, contactId, name, actingUserId }) {
      const contact = await deps.repos.contact.findById(workspaceId, contactId);
      if (!contact) throw new UseCaseError(PAYMENT_ERROR.notFound);
      const trimmed = name.trim();
      if (!trimmed) return;
      await deps.repos.paymentAlias.upsert({
        workspaceId,
        counterpartyNameNormalized: aliasKeyForCounterparty(trimmed),
        contactId,
        learnedFromUserId: actingUserId,
      });
    },

    async getAutoConfirmMode({ workspaceId }) {
      return (await deps.repos.workspace.findById(workspaceId))?.paymentAutoConfirm ?? DEFAULT_PAYMENT_AUTO_CONFIRM_MODE;
    },

    async scheduleMatching({ workspaceId }) {
      await deps.repos.jobs.scheduleNow({
        kind: JOB_KINDS.matchPayments,
        workspaceId,
        payload: { workspaceId, trigger: "cron" } satisfies MatchPaymentsInput,
        now: now(),
      });
    },

    async runMatching({ workspaceId }) {
      // decisions/0044: the admin's auto-confirm mode decides what is booked without a human.
      const autoConfirmMode = (await deps.repos.workspace.findById(workspaceId))?.paymentAutoConfirm ?? DEFAULT_PAYMENT_AUTO_CONFIRM_MODE;
      // decisions/0045: open suggestions of the deterministic stages are recomputed by every run,
      // so rules that changed since (a currency guard, a date window) also retire suggestions an
      // older run left behind. AI suggestions keep their cache (decisions/0025) and stay.
      await dropOpenDeterministicSuggestions(deps, workspaceId);
      await applyNoDocumentRules(deps, workspaceId);
      // F4 (decisions/0026-platform-settlements.md): before building the candidate pools -
      // a document `attemptFeeInvoiceSettlement` just settled must never also be considered
      // an open invoice-candidate for the ordinary three-stage engine below.
      await attemptFeeInvoiceSettlement(deps, workspaceId, now());
      // decisions/0048-app-store-reports.md: a freshly imported bank statement may be exactly
      // the event a still-unpaired Apple/Google report was waiting for - retried on every run,
      // not only right after a settlement report's own import (`matchSettlementReport` below).
      await attemptAppStorePayoutPairing(deps, workspaceId, now());
      // decisions/0068-supplier-clearing-accounts.md: a supplier clearing account's two sides
      // are booked before the pools are built - a new invoice of that supplier is `settled`
      // (and so no longer an invoice candidate) and its charges are tied to the clearing
      // account (and so no longer unexplained) by the time matching looks at anything.
      // `src/modules/accounts` owns `transactions`, so this goes through its own use case.
      await deps.accounts?.bookContactClearingEntries({ workspaceId });

      const clearingContactIds = await loadClearingContactIds(deps, workspaceId);
      const docPool = await buildDocumentPool(deps, workspaceId, clearingContactIds);
      const txPool = await excludeClearingContactTransactions(deps, workspaceId, await buildTransactionPool(deps, workspaceId), clearingContactIds);

      let suggestionsCreated = 0;
      let autoConfirmed = 0;
      let aiCalls = 0;

      if (docPool.size > 0 && txPool.length > 0) {
        const aliasRows = await deps.repos.paymentAlias.listForWorkspace(workspaceId);
        const aliasMap: ContactAliasMap = new Map(aliasRows.map((a) => [a.counterpartyNameNormalized, a.contactId]));
        const rejectionRows = await deps.repos.paymentRejection.listForWorkspace(workspaceId);
        const rejectedPairs: RejectedPairSet = new Set(rejectionRows.map((r) => rejectedPairKey(r.documentId, r.transactionId)));

        for (const tx of txPool) {
          if (tx.isPlatformPayout) continue; // F4 concern, never matched directly here

          // Stage 1: deterministic rules, plus this phase's own alias corroboration.
          let ruleSuggestions = matchByRules(tx, [...docPool.values()]);
          const aliasedContactId = applyAliases(tx.counterpartyName, aliasMap);
          if (aliasedContactId) ruleSuggestions = [...ruleSuggestions, ...aliasBoostSuggestions(tx, docPool, aliasedContactId)];
          ruleSuggestions = filterRejectedPairs(ruleSuggestions, rejectedPairs);

          if (ruleSuggestions.length > 0) {
            // Highest-confidence suggestion per document (a duplicate document id can occur
            // when both the ordinary rules pass and the alias boost independently propose the
            // same pairing).
            const byDocument = new Map<string, MatchSuggestion>();
            for (const s of ruleSuggestions) {
              const key = s.documentIds[0]!;
              const existing = byDocument.get(key);
              if (!existing || s.confidence > existing.confidence) byDocument.set(key, s);
            }
            for (const suggestion of closestByDate(tx, [...byDocument.values()], docPool)) {
              const autoConfirmedThis = await persistSuggestion(workspaceId, tx, suggestion, docPool, autoConfirmMode !== "none");
              suggestionsCreated++;
              if (autoConfirmedThis) autoConfirmed++;
            }
            continue; // stage 1 found something for this transaction - stages 2/3 never run
          }

          // Stage 2: arithmetic (subset-sum, then a single partial-payment candidate).
          // decisions/0033: a document whose own invoice number contradicts a reference the
          // remittance text explicitly names is dropped from the candidate pool entirely here
          // - not merely gated at suggestion-build time below - so neither the subset-sum
          // search, the partial-payment scan, nor stage 3's AI arbiter (which reuses this same
          // `candidateDocs` list) ever sees it as a candidate for this transaction again.
          const candidateDocs = selectCandidateDocuments(tx, [...docPool.values()]).filter((doc) => !hasContradictingInvoiceReference(tx.remittanceText, doc.invoiceNumber));
          const paidCents = Math.abs(tx.amountCents);
          let stage2Suggestion: MatchSuggestion | null = null;

          // decisions/0044: arithmetic only adds up amounts of the transaction's own currency.
          const arithmeticDocs = candidateDocs.filter((doc) => sameCurrency(tx, doc));
          if (arithmeticDocs.length > 0 && paidCents > 0) {
            const subset = findSubsetSums(arithmeticDocs, paidCents, { tolerancePercent: DEFAULT_SKONTO_TOLERANCE_PERCENT });
            if (!subset.ambiguous && subset.solutions.length === 1) {
              const ids = subset.solutions[0]!;
              // decisions/0045: a collective payment comes from one payer settling several of its
              // own invoices, so every document must share the transaction's counterparty (name,
              // IBAN or invoice number). Observed: a 22,00 EUR Facebook debit "explained" as an
              // IONOS invoice plus four Meta receipts.
              const everyDocumentCorroborated = ids.every((id) => {
                const doc = docPool.get(id);
                return doc !== undefined && hasCorroboratingSignal(tx, doc).anySignal;
              });
              if (ids.length >= 2 && everyDocumentCorroborated) {
                stage2Suggestion = {
                  documentIds: ids,
                  transactionIds: [tx.id],
                  kind: MATCH_KINDS.collective,
                  confidence: 0.55,
                  autoConfirm: false,
                  reasons: [MATCH_REASON_CODES.subsetSum, MATCH_REASON_CODES.collectivePayment],
                };
              } else {
                const soloDoc = docPool.get(ids[0]!);
                if (soloDoc) {
                  const { invoiceNumberFound, anySignal } = hasCorroboratingSignal(tx, soloDoc);
                  if (anySignal) {
                    const exact = paidCents === soloDoc.openAmountCents;
                    stage2Suggestion = {
                      documentIds: ids,
                      transactionIds: [tx.id],
                      kind: exact ? MATCH_KINDS.exact : MATCH_KINDS.skonto,
                      confidence: invoiceNumberFound ? 0.6 : 0.45,
                      autoConfirm: false, // stage 2 never auto-confirms, decisions/0023 decision 3
                      reasons: [MATCH_REASON_CODES.subsetSum, exact ? MATCH_REASON_CODES.amountExact : MATCH_REASON_CODES.amountWithinSkonto],
                    };
                  }
                }
              }
            }

            if (!stage2Suggestion) {
              const partialCandidate = arithmeticDocs.find((doc) => paidCents < doc.openAmountCents && hasCorroboratingSignal(tx, doc).anySignal);
              if (partialCandidate) {
                // `partialPaymentFor(partialCandidate, tx).appliedCents` is exactly
                // `Math.min(paidCents, partialCandidate.openAmountCents)` here (`paidCents <
                // openAmountCents` by this branch's own guard) - `computeAllocation` recomputes
                // the identical value uniformly for every suggestion kind rather than carrying
                // a one-off field on `MatchSuggestion` just for this case.
                stage2Suggestion = {
                  documentIds: [partialCandidate.id],
                  transactionIds: [tx.id],
                  kind: MATCH_KINDS.partial,
                  confidence: 0.5,
                  autoConfirm: false,
                  reasons: [MATCH_REASON_CODES.partialPayment],
                };
              }
            }
          }

          if (stage2Suggestion) {
            const filtered = filterRejectedPairs([stage2Suggestion], rejectedPairs);
            if (filtered.length > 0) {
              await persistSuggestion(workspaceId, tx, filtered[0]!, docPool, autoConfirmMode !== "none");
              suggestionsCreated++;
              continue; // stage 2 found something usable - stage 3 never runs for this transaction
            }
            // The only stage-2 candidate was already rejected by a human - equivalent to
            // "stage 2 found nothing", so stage 3 still gets a chance below.
          }

          // Stage 3: the AI arbiter, only when stages 1-2 found nothing at all for this tx.
          if (candidateDocs.length === 0) continue;
          // decisions/0077-arbiter-answer-cache.md: the key covers the whole question (the
          // transaction, every candidate's fields, the arbiter's model and prompt), and an answer
          // of ANY kind is kept, so neither a later trigger nor the six-hour follow-up asks the
          // same question again; a new candidate or a changed field makes a new key.
          const cacheKey = arbiterCacheKey(tx, candidateDocs, deps.paymentArbiter.version);
          const existingAi = await deps.repos.documentTransaction.findAiSuggestionForTransaction(workspaceId, tx.id);
          if (existingAi && existingAi.arbiterCacheKey === cacheKey) continue; // this answer's suggestion is already there (or a human already decided it)

          const cachedAnswer = await deps.repos.paymentArbiterAnswer.findForTransaction(workspaceId, tx.id);
          let raw: PaymentArbiterRawResult;
          if (cachedAnswer && cachedAnswer.cacheKey === cacheKey) {
            raw = { bestDocumentId: cachedAnswer.bestDocumentId, confidence: cachedAnswer.confidence, reason: cachedAnswer.reason };
          } else {
            aiCalls++;
            raw = toCacheableArbiterAnswer(await deps.paymentArbiter.rank({ transaction: tx, candidates: candidateDocs }));
            await deps.repos.paymentArbiterAnswer.upsert({ workspaceId, transactionId: tx.id, cacheKey, ...raw });
          }
          // Validated on every use, cached or fresh: the checks are code, cost nothing, and read
          // the current data (a rejection recorded since, for example).
          const validated = validateArbiterResult(raw, { transaction: tx, candidates: candidateDocs });
          if (!validated) continue;
          const filtered = filterRejectedPairs([validated], rejectedPairs);
          if (filtered.length === 0) continue;

          const doc = docPool.get(validated.documentIds[0]!);
          if (!doc) continue;
          await deps.repos.documentTransaction.upsertSuggestion({
            workspaceId,
            documentId: doc.id,
            transactionId: tx.id,
            status: "suggested",
            kind: MATCH_KINDS.ai,
            confidence: validated.confidence,
            reasons: validated.reasons,
            explanation: validated.aiExplanation ?? null,
            matchedBy: "ai",
            allocatedAmountCents: computeAllocation(MATCH_KINDS.ai, doc, tx),
            arbiterCacheKey: cacheKey,
            decidedAt: null,
            decidedByUserId: null,
          });
          suggestionsCreated++;
        }
      }

      await dropSuggestionsForSettledDocuments(deps, workspaceId);
      await keepClosestSuggestions(deps, workspaceId);
      autoConfirmed += await applyAutoConfirmPolicy(deps, workspaceId, autoConfirmMode, now());
      await scheduleFollowUpIfNeeded(deps, workspaceId, now());
      return { suggestionsCreated, autoConfirmed, aiCalls };
    },

    async matchSettlementReport({ workspaceId, documentId }) {
      // The fee-invoice side of this same report may now be settleable too (decisions/0026):
      // run it here as well, not only from `runMatching`'s own cron cadence, so importing a
      // report settles an already-confirmed fee invoice right away.
      await attemptFeeInvoiceSettlement(deps, workspaceId, now());
      // decisions/0048-app-store-reports.md: this document itself might be an Apple/Google
      // report whose bank credit already exists (or might be exactly what a still-unpaired
      // OLDER report was waiting for, e.g. Google's multi-month case) - attempted right away,
      // not only on `runMatching`'s own later cadence.
      await attemptAppStorePayoutPairing(deps, workspaceId, now());

      const lines = await deps.repos.settlementLine.listForDocument(workspaceId, documentId);
      const revenueLines = lines.filter((line): line is SettlementLineRow & { transactionId: string } => line.type === "revenue" && line.transactionId !== null);
      if (revenueLines.length === 0) return { linesMatched: 0, suggestionsCreated: 0 };

      // Skip a revenue line whose own transaction already has a non-rejected
      // `document_transactions` row - re-running this job (a retried/duplicated job run, or a
      // second settlement-related import touching the same lines) must never re-suggest or
      // re-confirm a pairing already decided.
      const alreadyLinked = new Set<string>();
      for (const line of revenueLines) {
        const existing = await deps.repos.documentTransaction.listForTransaction(workspaceId, line.transactionId);
        if (existing.some((row) => row.status !== "rejected")) alreadyLinked.add(line.transactionId);
      }
      const pending = revenueLines.filter((line) => !alreadyLinked.has(line.transactionId));
      if (pending.length === 0) return { linesMatched: 0, suggestionsCreated: 0 };

      const docPool = await buildDocumentPool(deps, workspaceId);
      const outgoingDocs = [...docPool.values()].filter((doc) => doc.direction === "outgoing");
      if (outgoingDocs.length === 0) return { linesMatched: 0, suggestionsCreated: 0 };

      const settlementLinesForMatch: SettlementLine[] = pending.map((line) => ({
        grossCents: line.grossCents ?? 0,
        feeCents: line.feeCents ?? 0,
        netCents: line.netCents ?? 0,
        invoiceNumber: line.invoiceId,
        description: null,
        customerName: line.customerName,
        bookingDate: line.bookingDate,
      }));
      const matches = matchSettlementLinesToDocuments(settlementLinesForMatch, outgoingDocs);

      let linesMatched = 0;
      let suggestionsCreated = 0;

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i]!;
        const line = pending[i]!;
        if (!match.documentId) continue;
        const doc = docPool.get(match.documentId);
        if (!doc || doc.openAmountCents <= 0) continue;

        const paidCents = Math.abs(line.grossCents ?? 0);
        const allocatedAmountCents = Math.min(paidCents, doc.openAmountCents);
        if (allocatedAmountCents <= 0) continue;

        if (match.matchRule === "invoice_number") {
          // decisions/0026's product model: "outgoing invoices match revenue lines 1:1
          // (invoice number in metadata/description first ...)" - deterministic enough to
          // confirm directly, the same "an invoice number found is auto-confirm-worthy"
          // standard `core/rules.ts`'s `isAutoConfirmMatch` already applies to stage 1.
          await deps.repos.documentTransaction.createConfirmed({
            workspaceId,
            documentId: doc.id,
            transactionId: line.transactionId,
            status: "confirmed",
            kind: MATCH_KINDS.exact,
            confidence: 0.95,
            reasons: [MATCH_REASON_CODES.invoiceNumberInRemittance],
            explanation: null,
            matchedBy: "auto",
            allocatedAmountCents,
            arbiterCacheKey: null,
            decidedAt: now(),
            decidedByUserId: null,
          });
          doc.openAmountCents = Math.max(0, doc.openAmountCents - allocatedAmountCents);
          await recomputeDocumentStatus(deps, workspaceId, doc.id, now());
          linesMatched++;
        } else {
          // `matchRule === "customer_amount_date"` - weaker evidence (no invoice number found
          // anywhere), left for a human to confirm via the ordinary "Zuordnung"/document
          // payment-section flow rather than auto-confirmed.
          await deps.repos.documentTransaction.upsertSuggestion({
            workspaceId,
            documentId: doc.id,
            transactionId: line.transactionId,
            status: "suggested",
            kind: MATCH_KINDS.exact,
            confidence: 0.55,
            reasons: [MATCH_REASON_CODES.counterpartyNameMatch, MATCH_REASON_CODES.dateWithinWindow],
            explanation: null,
            matchedBy: "auto",
            allocatedAmountCents,
            arbiterCacheKey: null,
            decidedAt: null,
            decidedByUserId: null,
          });
          suggestionsCreated++;
        }
      }

      return { linesMatched, suggestionsCreated };
    },

    async confirmSuggestion({ workspaceId, documentTransactionId, actingUserId }) {
      const row = await deps.repos.documentTransaction.findById(workspaceId, documentTransactionId);
      if (!row) throw new UseCaseError(PAYMENT_ERROR.notFound);
      if (row.status !== "suggested") throw new UseCaseError(PAYMENT_ERROR.alreadyDecided);
      await assertAllocationFits(deps, workspaceId, { documentId: row.documentId, transactionId: row.transactionId, allocatedAmountCents: row.allocatedAmountCents, kind: row.kind as MatchKind });

      await deps.repos.documentTransaction.decide(workspaceId, documentTransactionId, { status: "confirmed", matchedBy: "user", decidedByUserId: actingUserId });
      await recomputeDocumentStatus(deps, workspaceId, row.documentId, now());
      await maybeLearnAlias(deps, workspaceId, row.documentId, row.transactionId, actingUserId);
    },

    async rejectSuggestion({ workspaceId, documentTransactionId, actingUserId }) {
      const row = await deps.repos.documentTransaction.findById(workspaceId, documentTransactionId);
      if (!row) throw new UseCaseError(PAYMENT_ERROR.notFound);
      if (row.status !== "suggested") throw new UseCaseError(PAYMENT_ERROR.alreadyDecided);

      await deps.repos.documentTransaction.decide(workspaceId, documentTransactionId, { status: "rejected", matchedBy: "user", decidedByUserId: actingUserId });
      await deps.repos.paymentRejection.create({ workspaceId, documentId: row.documentId, transactionId: row.transactionId, rejectedBy: actingUserId });
    },

    // `actingUserId` is part of `DecisionInput` for symmetry with `confirmSuggestion`/
    // `rejectSuggestion` (every decision action takes it, for a future audit log) - `unlink`
    // deletes the row outright rather than transitioning its status, so there is no
    // `decided_by_user_id` column left to write it onto.
    async unlink({ workspaceId, documentTransactionId }) {
      const row = await deps.repos.documentTransaction.findById(workspaceId, documentTransactionId);
      if (!row) throw new UseCaseError(PAYMENT_ERROR.notFound);
      if (row.status !== "confirmed") throw new UseCaseError(PAYMENT_ERROR.alreadyDecided);

      await deps.repos.documentTransaction.deleteById(workspaceId, documentTransactionId);
      await recomputeDocumentStatus(deps, workspaceId, row.documentId, now());
    },

    async linkManually({ workspaceId, documentId, transactionId, allocatedAmountCents, actingUserId }) {
      const [doc, tx] = await Promise.all([deps.repos.document.findById(workspaceId, documentId), deps.repos.transaction.findById(workspaceId, transactionId)]);
      if (!doc || !tx) throw new UseCaseError(PAYMENT_ERROR.notFound);
      if (doc.direction !== "incoming" && doc.direction !== "outgoing") throw new UseCaseError(PAYMENT_ERROR.crossDirection);
      // decisions/0069: the gate needs the sign of the total too, because a credit note is
      // money coming back without its direction changing.
      if (!directionMatches({ amountCents: tx.amountCents }, { direction: doc.direction, totalAmountCents: doc.totalAmountCents ?? 0 }))
        throw new UseCaseError(PAYMENT_ERROR.crossDirection);

      const allocatedByDocument = await deps.repos.documentTransaction.sumConfirmedAllocatedByDocument(workspaceId, [documentId]);
      const openAmountCents = Math.max(0, Math.abs(doc.totalAmountCents ?? 0) - (allocatedByDocument.get(documentId) ?? 0));
      const finalAllocation = allocatedAmountCents ?? Math.min(Math.abs(tx.amountCents), openAmountCents);
      if (finalAllocation <= 0 || finalAllocation > openAmountCents) throw new UseCaseError(PAYMENT_ERROR.amountExceedsOpen);
      if (exceedsTransaction(await unallocatedTransactionCents(deps, workspaceId, tx), finalAllocation, MATCH_KINDS.manual, doc.currency, tx.currency))
        throw new UseCaseError(PAYMENT_ERROR.amountExceedsTransaction);

      await deps.repos.documentTransaction.createConfirmed({
        workspaceId,
        documentId,
        transactionId,
        status: "confirmed",
        kind: MATCH_KINDS.manual,
        confidence: 1,
        reasons: [],
        explanation: null,
        matchedBy: "user",
        allocatedAmountCents: finalAllocation,
        arbiterCacheKey: null,
        decidedAt: now(),
        decidedByUserId: actingUserId,
      });
      await recomputeDocumentStatus(deps, workspaceId, documentId, now());
      await maybeLearnAlias(deps, workspaceId, documentId, transactionId, actingUserId);
    },

    async markNoDocumentNeeded({ workspaceId, transactionIds, forCounterparty, actingUserId }) {
      if (transactionIds.length > 0) await deps.repos.transaction.markNoDocumentNeeded(workspaceId, transactionIds);

      if (!forCounterparty) return;
      const firstId = transactionIds[0];
      if (!firstId) return;
      const tx = await deps.repos.transaction.findById(workspaceId, firstId);
      if (!tx?.counterpartyName) return;

      const normalized = normalizeName(tx.counterpartyName);
      await deps.repos.paymentNoDocumentRule.upsert({ workspaceId, counterpartyNameNormalized: normalized, createdByUserId: actingUserId });

      const { items } = await deps.repos.transaction.listUnmatched(workspaceId, { page: 1, pageSize: UNMATCHED_SCAN_PAGE_SIZE });
      const matchingIds = items.filter((t) => t.counterpartyName && normalizeName(t.counterpartyName) === normalized).map((t) => t.id);
      if (matchingIds.length > 0) await deps.repos.transaction.markNoDocumentNeeded(workspaceId, matchingIds);
    },

    async markSettledWithoutPayment({ workspaceId, documentId }) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) throw new UseCaseError(PAYMENT_ERROR.notFound);
      await deps.repos.document.updatePaymentStatus(workspaceId, documentId, { paymentStatus: PAYMENT_STATUSES.noDocumentNeeded, paidAt: doc.paidAt });
    },

    async discardOpenSuggestionsForDocument({ workspaceId, documentId }) {
      await dropOpenSuggestionsForDocument(deps, workspaceId, documentId);
    },

    async getDocumentPaymentSection(workspaceId, documentId) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) return null;

      const rows = await deps.repos.documentTransaction.listForDocument(workspaceId, documentId);
      const matchedTransactions = rows.filter((r) => r.status === "confirmed");
      const suggestions = rows.filter((r) => r.status === "suggested");
      const allocatedTotal = matchedTransactions.reduce((sum, r) => sum + r.allocatedAmountCents, 0);
      const possibleDuplicatePayment = matchedTransactions.length > 1 && doc.totalAmountCents !== null && allocatedTotal > Math.abs(doc.totalAmountCents);

      let reminderAlreadyPaidAt: Date | null = null;
      if (doc.kind === "reminder" && doc.invoiceNumber) {
        const siblings = await deps.repos.document.findPaymentStatusByInvoiceNumber(workspaceId, doc.invoiceNumber, documentId);
        const paidSibling = siblings.find((s) => s.paymentStatus === PAYMENT_STATUSES.paid && s.paidAt !== null);
        reminderAlreadyPaidAt = paidSibling?.paidAt ?? null;
      }

      return { paymentStatus: doc.paymentStatus, paidAt: doc.paidAt, matchedTransactions, suggestions, reminderAlreadyPaidAt, possibleDuplicatePayment };
    },

    async listUnmatchedTransactions(workspaceId, range) {
      const { items } = await deps.repos.transaction.listUnmatched(workspaceId, {
        page: 1,
        pageSize: UNMATCHED_SCAN_PAGE_SIZE,
        from: range?.from,
        to: range?.to,
      });
      return Promise.all(
        items.map(async (transaction) => ({
          transaction,
          suggestions: await deps.repos.documentTransaction.listForTransaction(workspaceId, transaction.id),
        })),
      );
    },

    async listOpenItems(workspaceId, range) {
      const documents = await deps.repos.document.listInvoiceCandidates(workspaceId, range);
      if (documents.length === 0) return [];
      const allocatedByDocument = await deps.repos.documentTransaction.sumConfirmedAllocatedByDocument(
        workspaceId,
        documents.map((d) => d.id),
      );
      return Promise.all(
        documents.map(async (document) => {
          const openAmountCents = Math.max(0, Math.abs(document.totalAmountCents ?? 0) - (allocatedByDocument.get(document.id) ?? 0));
          const contact = await resolvePrimaryContact(deps, document);
          return { document, contact, openAmountCents };
        }),
      );
    },

    async getTransactionMatchStatuses(workspaceId, transactionIds) {
      const map = new Map<string, TransactionMatchStatus>();
      await Promise.all(
        transactionIds.map(async (transactionId) => {
          const rows = await deps.repos.documentTransaction.listForTransaction(workspaceId, transactionId);
          const active = rows.find((r) => r.status === "confirmed") ?? rows.find((r) => r.status === "suggested");
          if (active) map.set(transactionId, { status: active.status as "confirmed" | "suggested", documentId: active.documentId, documentTitle: active.documentTitle });
        }),
      );
      return map;
    },

    async countUnmatchedTransactions(workspaceId) {
      return deps.repos.transaction.countUnmatched(workspaceId);
    },

    async countOpenSuggestions(workspaceId) {
      return deps.repos.documentTransaction.countSuggestedForWorkspace(workspaceId);
    },
  };
}
