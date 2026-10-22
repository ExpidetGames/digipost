// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Inputs are
// normalized and re-checked here even though the Server Action layer already validated them:
// use cases are the last line of defense (WEBAPP_TEMPLATE_SPEC.md §5.4). No `next/*`, `react`,
// `src/platform/*/client`, or a module's own `server.ts`/`client.ts` - only
// `Repositories`/`UnitOfWork` from `src/persistence/repositories/contracts`, the injected
// `ObjectStorage` port, and pure logic from `@/modules/accounts`/`@/modules/contacts`/
// `@/modules/documents`/`@/modules/intake`.
//
// `importFromDocument` is this file's one method worth reading closely first: triggered by the
// `import-account-transactions` job (enqueued by `documents-use-cases.ts`'s intake-confirmation
// hook, decisions/0024's "Trigger" section) and re-runnable directly from the UI. It ALWAYS
// re-reads and re-parses the document's original stored bytes - never trusts
// `documents.intake_result` for the transaction data itself (that column is capped at
// `MAX_EMBEDDED_ROWS` and, for a camt.053 statement, never carried balance/date-range data at
// all) - the same "re-read the original, never trust the summary" discipline
// `documents-use-cases.ts`'s own `confirmIntake` already established.
import {
  buildSettlementLineDrafts,
  findCoverageGaps,
  mapCamt053StatementsToImportable,
  mapTabularRowsToImportable,
  resolveAccountByIban,
  summarizeStatementsForBatch,
  type ImportableStatement,
  type ImportOutcome,
  type SettlementLineDraft,
} from "@/modules/accounts";
import { normalizeIban } from "@/modules/contacts";
import { parseIntakeResult } from "@/modules/documents";
import { PAYMENT_STATUSES, resolveContactForCounterparty, type ContactAliasMap } from "@/modules/payments";
import { isDbError } from "@/persistence/foundation/db-errors";
import {
  decodeTextBytes,
  detectApplePaymentSummary,
  detectGooglePlayEarnings,
  MT940_MIME_TYPE,
  parseApplePaymentSummary,
  parseCamt053,
  parseGooglePlayEarnings,
  parseMt940,
  parseTabularRows,
  sampleTabular,
  validateMapping,
  type AmountSign,
  type ColumnMapping,
  type NormalizedBankTransactionFromMapping,
  type NormalizedSettlementLine,
  type SettlementPlatform,
} from "@/modules/intake";
import type {
  AccountRow,
  AccountType,
  CreateSettlementLineRow,
  CreateTransactionRow,
  ImportBatchRow,
  Repositories,
  SettlementLineRow,
  TransactionListFilter,
  TransactionRow,
  UnitOfWork,
} from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { MatchPaymentsInput, MatchSettlementReportInput } from "@/persistence/use-cases/payments-use-cases";
import { JOB_KINDS } from "@/platform/jobs";
import type { ObjectStorage } from "@/platform/object-storage";

export const ACCOUNT_ERROR = {
  notFound: "not_found",
  /** A manual create/update whose (normalized) IBAN already belongs to another account in this
   * workspace - the schema's own partial unique index is the authoritative guard; this is the
   * pre-check that turns the resulting constraint violation into a stable code instead of a
   * raw database error surfacing to the UI. */
  duplicateIban: "duplicate_iban",
  /** `importFromDocument` on a document that is not a confirmed `bank_statement` (wrong kind,
   * not yet confirmed, rejected, or - for the tabular re-derivation fallback - a confirmed
   * mapping that can no longer be reconstructed from either a matching fingerprint or a
   * non-truncated `intake_result`). */
  notImportable: "not_importable",
  /** F5 review finding (F2 #2, decisions/0027-hardening-and-deletion.md): `updateAccount`
   * changing the IBAN of an account that already has at least one import batch - blocked
   * outright, never silently accepted. Editing the IBAN after imports exist desynchronizes
   * auto-resolution (a later camt.053 statement for the OLD IBAN would no longer match this
   * account by `resolveAccountByIban`, auto-creating a duplicate account instead) and leaves
   * every already-imported transaction attributed to an account whose IBAN no longer matches
   * where the money actually came from - a silent ledger-integrity break, not a cosmetic
   * rename. There is no re-confirmation escape hatch: an account with a wrong IBAN and no
   * imports yet can still be corrected freely; once it has real imported history, create a new
   * account for the corrected IBAN instead. */
  ibanLockedByImports: "iban_locked_by_imports",
  /** F5 review finding (F2 #4, decisions/0027-hardening-and-deletion.md): `importFromDocument`
   * with an explicit `accountId` (the "Konto zuordnen" pending-account resolution, or
   * re-importing against a chosen account) that resolves to a `type: "clearing"` account - a
   * platform's own clearing ledger (F4, decisions/0026-platform-settlements.md), never a valid
   * target for a plain bank statement's transactions. */
  notBankAccount: "not_bank_account",
  /** decisions/0068-supplier-clearing-accounts.md: `createContactClearingAccount` for a
   * contact that already has one ("at most one clearing account per contact per workspace",
   * enforced by `accounts_workspace_contact_clearing_key`; this is the pre-check that turns
   * both the found row and a lost creation race into one stable code). */
  clearingAccountExists: "clearing_account_exists",
} as const;
export type AccountErrorCode = (typeof ACCOUNT_ERROR)[keyof typeof ACCOUNT_ERROR];

export type Account = AccountRow;
export type ImportBatch = ImportBatchRow;
export type Transaction = TransactionRow;

export type AccountOverview = Account & {
  /** The closing balance of the account's most recently dated import batch, or (for an
   * account whose only imports carry no balance data at all - every tabular/CSV source) the
   * running sum of every transaction's signed amount, labelled differently by the UI
   * (`balanceIsExact: false`). `null` when the account has no transactions at all yet. */
  latestBalanceCents: number | null;
  balanceIsExact: boolean;
  coverageGaps: { from: string; to: string }[];
  /** F5 review finding (F2 #3, decisions/0027-hardening-and-deletion.md): `true` when at
   * least one transaction on this account carries a `currency` different from the account's
   * own - only ever computed for the `balanceIsExact: false` fallback-sum path (a batch's own
   * closing balance is authoritative regardless), and always `false` otherwise. The UI shows
   * this as a data-quality warning: `latestBalanceCents` in that case excludes the
   * differently-currencied rows rather than nonsensically summing amounts across currencies. */
  hasMixedCurrencyTransactions: boolean;
};

/** decisions/0068-supplier-clearing-accounts.md: what one booking pass actually wrote -
 * reported by the Server Action and used by tests/the probe to prove idempotency (a second
 * pass books zero of both). */
export type ContactClearingBookingResult = { invoicesBooked: number; chargesBooked: number };

export type CreateAccountInput = {
  workspaceId: string;
  type: AccountType;
  name: string;
  iban: string | null;
  bic: string | null;
  currency: string;
  holder: string | null;
  platform: string | null;
};

export type UpdateAccountInput = CreateAccountInput & { accountId: string };

export type ImportFromDocumentInput = { workspaceId: string; documentId: string; accountId?: string };

export interface AccountsUseCases {
  /** decisions/0050: books a platform payout out of the platform's clearing account and ties it
   * to the bank credit that received it (same `transferGroupId`). Apple's and Google's reports
   * carry no payout id of their own, so the payout only becomes known when the credit is paired
   * (`payments-use-cases.ts`); without this the clearing account would keep growing with every
   * report and never show what is still owed. Idempotent per bank transaction. */
  recordPlatformPayout(input: { workspaceId: string; platform: SettlementPlatform; amountCents: number; bookingDate: string; bankTransactionId: string; reference: string | null }): Promise<void>;

  /** decisions/0068-supplier-clearing-accounts.md: creates the ONE clearing account a
   * supplier whose invoices and bank charges can never pair one to one gets, and books its
   * history in the same call (the contact's own invoices and the charges already imported) -
   * "or the balance would start as a lie". Throws `clearingAccountExists` when the contact
   * already has one, `notFound` for a contact outside this workspace. */
  createContactClearingAccount(input: { workspaceId: string; contactId: string }): Promise<Account>;
  /** decisions/0068: this contact's clearing account, or `null` - the contact detail page's
   * own "has one already?" read. */
  getContactClearingAccount(workspaceId: string, contactId: string): Promise<Account | null>;
  /** decisions/0068: books whatever is not booked yet onto EVERY contact-owned clearing
   * account of the workspace (a newly uploaded invoice of that supplier, a charge from a
   * freshly imported bank statement). Idempotent per document and per bank transaction, so
   * running it twice changes nothing. Called by `PaymentsUseCases.runMatching` (which runs
   * after every import and every document event) through the same narrow port
   * `recordPlatformPayout` already uses - `src/modules/accounts` stays the only writer of
   * `accounts`/`transactions`. */
  bookContactClearingEntries(input: { workspaceId: string }): Promise<ContactClearingBookingResult>;

  listAccounts(workspaceId: string): Promise<AccountOverview[]>;
  getAccount(workspaceId: string, accountId: string): Promise<Account | null>;
  /** The same overview row `listAccounts` builds, for one account - the account detail page
   * needs the balance to explain a contact-owned clearing account's residue
   * (decisions/0068). `null` for an account outside this workspace. */
  getAccountOverview(workspaceId: string, accountId: string): Promise<AccountOverview | null>;
  createAccount(input: CreateAccountInput): Promise<Account>;
  updateAccount(input: UpdateAccountInput): Promise<Account>;
  listTransactions(workspaceId: string, accountId: string, filter: TransactionListFilter): Promise<{ items: Transaction[]; hasMore: boolean }>;
  listImportBatches(workspaceId: string, accountId: string): Promise<ImportBatch[]>;
  /** Every confirmed `bank_statement` document with no import batch yet - the "Konto
   * zuordnen" list on `/dashboard/finance` (decisions/0024's "Pending account" section). */
  listPendingAccountDocuments(workspaceId: string): Promise<{ id: string; originalFileName: string; createdAt: Date }[]>;
  /** F4 (decisions/0026-platform-settlements.md): every settlement line a confirmed
   * `payout_report`/`platform_settlement` document produced - the document detail page's own
   * decomposition (revenue/fee/refund/payout) and "Rechnung fehlt" list. A plain read, not a
   * business decision (WEBAPP_TEMPLATE_SPEC.md §5.3) - `@/modules/payments/server/read-models.ts`'s
   * `getSettlementReportProjection` is what actually decides what a viewer sees. */
  listSettlementLinesForDocument(workspaceId: string, documentId: string): Promise<SettlementLineRow[]>;
  /** The import service (decisions/0024-accounts-and-transactions.md's "Import service"
   * section). `accountId` is only needed when the source carries no own-account IBAN at all
   * (every tabular/CSV bank statement) or the caller wants to override auto-resolution;
   * omitted, a camt.053 statement resolves (or creates) the account by its own declared IBAN.
   * Idempotent: re-running for the same document inserts zero new rows for a transaction
   * already known and upserts the same import-batch row rather than creating a second one. */
  importFromDocument(input: ImportFromDocumentInput): Promise<ImportOutcome>;
}

type AccountsUseCaseDeps = {
  repos: Repositories;
  uow: UnitOfWork;
  objectStorage: ObjectStorage;
};

function toAccountName(iban: string): string {
  const last4 = iban.slice(-4);
  return `Bankkonto ${last4}`;
}

async function loadImportableStatements(
  deps: AccountsUseCaseDeps,
  doc: { workspaceId: string; mimeType: string; storageKey: string; intakeResult: unknown },
): Promise<ImportableStatement[]> {
  const bytes = await deps.objectStorage.getObject(doc.storageKey);
  const text = decodeTextBytes(bytes);

  if (doc.mimeType === "application/xml") {
    const parsed = parseCamt053(text);
    return mapCamt053StatementsToImportable(parsed.statements);
  }

  if (doc.mimeType === MT940_MIME_TYPE) {
    // `Mt940Statement` is a plain alias of `Camt053Statement` (decisions/0028-mt940-support.md,
    // `@/modules/intake`'s own header comment) - the exact same mapper works unmodified.
    const parsed = parseMt940(text);
    return mapCamt053StatementsToImportable(parsed.statements);
  }

  // text/csv or text/tab-separated-values - a confirmed tabular bank-statement mapping. Always
  // prefer re-deriving from the original bytes via the workspace's confirmed fingerprint (the
  // same source `confirmIntake` itself always writes one to): correct beyond
  // `MAX_EMBEDDED_ROWS` and independent of whatever is or is not embedded in `intake_result`.
  const delimiter = doc.mimeType === "text/tab-separated-values" ? ("\t" as const) : undefined;
  const sample = sampleTabular(text, { delimiter });
  const fullRows = parseTabularRows(text, { delimiter: sample.delimiter, quoteChar: sample.quoteChar });

  const fingerprint = await deps.repos.intakeFingerprint.findByFingerprint(doc.workspaceId, sample.fingerprint);
  if (fingerprint) {
    const validated = validateMapping(sample, fullRows, fingerprint.columnMapping as ColumnMapping, fingerprint.amountSign as AmountSign | null);
    if (validated.ok && validated.kind === "bank_transactions") {
      return [mapTabularRowsToImportable(validated.transactions)];
    }
  }

  // Fallback (no matching fingerprint - e.g. reset via "Zuordnung zurücksetzen" after this
  // document was confirmed): the embedded rows, only when not truncated (a truncated summary
  // would silently under-import).
  const intakeResult = parseIntakeResult(doc.intakeResult);
  if (intakeResult?.type === "tabular_confirmed" && !intakeResult.truncated) {
    return [mapTabularRowsToImportable(intakeResult.rows as NormalizedBankTransactionFromMapping[])];
  }

  throw new UseCaseError(ACCOUNT_ERROR.notImportable);
}

// --- F4 (decisions/0026-platform-settlements.md): payout/settlement report import ---

const PLATFORM_ACCOUNT_NAMES: Record<SettlementPlatform, string> = {
  stripe: "Stripe",
  apple: "Apple",
  google: "Google",
  paypal: "PayPal",
  amazon: "Amazon",
  other: "Plattform",
};

function clearingAccountName(platform: SettlementPlatform): string {
  return `${PLATFORM_ACCOUNT_NAMES[platform]} (Verrechnungskonto)`;
}

/** Mirrors `loadImportableStatements`'s own "always re-read the original bytes, prefer the
 * confirmed fingerprint over the possibly-truncated `intake_result`" discipline, for a
 * `payout_report`/`platform_settlement` document instead of a `bank_statement` one. A
 * settlement report is always tabular (CSV/TSV) in this phase - there is no camt.053-shaped
 * settlement report - so this loader has no XML branch. */
async function loadSettlementRows(
  deps: AccountsUseCaseDeps,
  doc: { workspaceId: string; mimeType: string; storageKey: string; intakeResult: unknown },
): Promise<NormalizedSettlementLine[]> {
  const bytes = await deps.objectStorage.getObject(doc.storageKey);
  const text = decodeTextBytes(bytes);

  // decisions/0048-app-store-reports.md: Apple's payment summary and Google Play's earnings
  // report are both self-identifying (like camt.053/MT940) despite sharing `text/csv` with
  // every AI-mapped tabular source - re-detected here from the re-read bytes, the same
  // "always re-derive from the original, never only from a fingerprint or intake_result"
  // discipline this function's own header comment already states, rather than falling through
  // to the generic fingerprint/`intake_result` fallback below (which would work for these two
  // real fixtures, both well under `MAX_EMBEDDED_ROWS`, but silently under-import a future
  // report large enough to have been truncated).
  if (detectApplePaymentSummary(text)) return parseApplePaymentSummary(text).lines;
  if (detectGooglePlayEarnings(text)) return parseGooglePlayEarnings(text).lines;

  const delimiter = doc.mimeType === "text/tab-separated-values" ? ("\t" as const) : undefined;
  const sample = sampleTabular(text, { delimiter });
  const fullRows = parseTabularRows(text, { delimiter: sample.delimiter, quoteChar: sample.quoteChar });

  const fingerprint = await deps.repos.intakeFingerprint.findByFingerprint(doc.workspaceId, sample.fingerprint);
  if (fingerprint) {
    const validated = validateMapping(sample, fullRows, fingerprint.columnMapping as ColumnMapping, fingerprint.amountSign as AmountSign | null);
    if (validated.ok && validated.kind === "settlement_lines") return validated.lines;
  }

  const intakeResult = parseIntakeResult(doc.intakeResult);
  if (intakeResult?.type === "tabular_confirmed" && !intakeResult.truncated) {
    return intakeResult.rows as NormalizedSettlementLine[];
  }

  throw new UseCaseError(ACCOUNT_ERROR.notImportable);
}

function toCreateTransactionRow(input: {
  workspaceId: string;
  accountId: string;
  documentId: string;
  draft: SettlementLineDraft;
  idempotencyKey: string;
}): CreateTransactionRow {
  const { workspaceId, accountId, documentId, draft, idempotencyKey } = input;
  return {
    workspaceId,
    accountId,
    bookingDate: draft.bookingDate ?? new Date().toISOString().slice(0, 10),
    valueDate: null,
    amountCents: draft.transactionAmountCents,
    currency: draft.currency,
    creditDebit: draft.transactionAmountCents >= 0 ? "credit" : "debit",
    counterpartyName: draft.customerName,
    counterpartyIban: null,
    counterpartyBic: null,
    remittanceText: draft.remittanceText,
    endToEndId: null,
    mandateId: null,
    creditorId: null,
    bankTxCode: null,
    bankReference: null,
    idempotencyKey,
    importBatchId: null,
    sourceDocumentId: documentId,
    raw: draft,
  };
}

/**
 * Payout-to-bank-deposit pairing (decisions/0026): tries to find the bank transaction that
 * actually paid out `payoutTx` (a `payout`-type debit on a clearing account) - by the payout id
 * appearing in the bank line's own remittance text first, else amount-and-date proximity
 * (`TransactionRepository.findUnpairedBankMatch`, both rules fixed by the product owner). Sets
 * the same `transferGroupId` on both sides when found; a no-op (not an error) when nothing
 * matches yet - "the bank payout stays 'unzugeordnet: Auszahlungsbericht fehlt'" is the
 * unpaired state's own UI treatment, not a failure of this function.
 */
async function tryPairPayout(
  repos: Repositories,
  workspaceId: string,
  payoutTx: { id: string; amountCents: number; bookingDate: string; payoutId: string | null },
): Promise<void> {
  const bankMatch = await repos.transaction.findUnpairedBankMatch(workspaceId, {
    amountCents: Math.abs(payoutTx.amountCents),
    bookingDate: payoutTx.bookingDate,
    payoutId: payoutTx.payoutId,
  });
  if (!bankMatch) return;
  await repos.transaction.setTransferGroup([payoutTx.id, bankMatch.id], crypto.randomUUID());
}

/**
 * F4's own import path (decisions/0026-platform-settlements.md's "Import" scope item):
 * resolves (or creates) the platform's ONE clearing account, builds every settlement-line
 * draft the report's rows imply (`buildSettlementLineDrafts`), inserts the corresponding
 * ledger transactions idempotently, inserts the settlement lines themselves idempotently
 * (pointing at those transactions), attempts payout-to-bank pairing for every `payout` draft,
 * and finally enqueues `PaymentsUseCases.matchSettlementReport` (never called directly - this
 * file never depends on `payments`' own use case, only on the job queue, the same
 * "handlers registered where they belong" discipline `importFromDocument`'s own
 * `match-payments` enqueue already follows).
 */
async function importSettlementReportDocument(
  deps: AccountsUseCaseDeps,
  input: { workspaceId: string; documentId: string; doc: { platform: string | null; mimeType: string; storageKey: string; intakeResult: unknown } },
): Promise<ImportOutcome> {
  const { workspaceId, documentId, doc } = input;
  const platform = doc.platform as SettlementPlatform | null;
  if (!platform) throw new UseCaseError(ACCOUNT_ERROR.notImportable);

  const rows = await loadSettlementRows(deps, { workspaceId, mimeType: doc.mimeType, storageKey: doc.storageKey, intakeResult: doc.intakeResult });
  const drafts = buildSettlementLineDrafts(rows);

  let clearingAccount = await deps.repos.account.findByPlatform(workspaceId, platform);
  let accountCreated = false;
  if (!clearingAccount) {
    try {
      clearingAccount = await deps.repos.account.create({
        workspaceId,
        type: "clearing",
        name: clearingAccountName(platform),
        iban: null,
        bic: null,
        // `NormalizedSettlementLine` carries no `currency` field at all (F1a/F1b's own mapping
        // never captured `SEMANTIC_FIELDS`' `currency` for a settlement-line row) - every fixture
        // this application recognizes today (Stripe, Apple) settles in EUR, and a clearing
        // account's own `currency` is editable afterwards like any manually created account.
        currency: "EUR",
        holder: null,
        platform,
      });
      accountCreated = true;
    } catch (err) {
      // F5 review finding (F4 leftover (c), decisions/0027-hardening-and-deletion.md): two
      // concurrent settlement-report imports for the same never-seen-before platform can both
      // observe "no clearing account yet" above and both attempt to create one - the new
      // partial unique index (`accounts_workspace_platform_clearing_key`, schema/accounts.ts)
      // lets exactly one succeed; this re-fetches the winner's row instead of surfacing the
      // constraint violation as a failure, the same "retry once, now it matches" shape
      // `workspaces-use-cases.ts`'s `createForUser` and `contacts-use-cases.ts`'s
      // `upsertFromExtraction` already use for their own analogous races.
      if (!isDbError(err, "unique")) throw err;
      const winner = await deps.repos.account.findByPlatform(workspaceId, platform);
      if (!winner) throw err;
      clearingAccount = winner;
    }
  }
  const clearingAccountId = clearingAccount.id;

  const draftIdempotencyKeys = drafts.map((draft) => `settlement:${documentId}:${draft.externalLineId}`);
  const transactionRows: CreateTransactionRow[] = drafts.map((draft, index) =>
    toCreateTransactionRow({ workspaceId, accountId: clearingAccountId, documentId, draft, idempotencyKey: draftIdempotencyKeys[index]! }),
  );

  const linesTotal = drafts.length;
  let linesImported = 0;

  await deps.uow.transaction(async (repos) => {
    await repos.transaction.insertManyIdempotent(transactionRows);
    // `insertManyIdempotent` only returns rows it actually inserted - a settlement line's own
    // `transactionId` must resolve regardless of whether this run inserted it or a previous
    // run already did, so every transaction for this account/these keys is re-fetched fresh.
    const allTransactions = await repos.transaction.findByIdempotencyKeys(clearingAccountId, draftIdempotencyKeys);
    const transactionByKey = new Map(allTransactions.map((tx) => [tx.idempotencyKey, tx]));

    const settlementLineRows: CreateSettlementLineRow[] = drafts.map((draft, index) => ({
      workspaceId,
      clearingAccountId,
      sourceDocumentId: documentId,
      transactionId: transactionByKey.get(draftIdempotencyKeys[index]!)?.id ?? null,
      type: draft.type,
      externalLineId: draft.externalLineId,
      grossCents: draft.grossCents,
      feeCents: draft.feeCents,
      netCents: draft.netCents,
      currency: draft.currency,
      bookingDate: draft.bookingDate,
      payoutId: draft.payoutId,
      chargeId: draft.chargeId,
      invoiceId: draft.invoiceId,
      customerName: draft.customerName,
      customerEmail: draft.customerEmail,
      productName: draft.productName,
      countryOfSale: draft.countryOfSale,
    }));

    const insertedLines = await repos.settlementLine.insertManyIdempotent(settlementLineRows);
    linesImported = insertedLines.length;

    // Payout pairing: only for a `payout` draft this run's own transaction insert resolved (a
    // previously-paired one already has a `transferGroupId` and `findUnpairedBankMatch`
    // itself only ever considers the BANK side's own `transferGroupId`, but there is no point
    // re-querying a payout that already has a group - `listUnpairedPayoutLines` below, called
    // from the bank-import side, is what re-tries an older still-unpaired one).
    for (const draft of drafts) {
      if (draft.type !== "payout") continue;
      const tx = transactionByKey.get(`settlement:${documentId}:${draft.externalLineId}`);
      if (!tx || tx.transferGroupId) continue;
      await tryPairPayout(repos, workspaceId, { id: tx.id, amountCents: tx.amountCents, bookingDate: tx.bookingDate, payoutId: draft.payoutId });
    }

    if (insertedLines.length > 0) {
      await repos.jobs.enqueue({
        kind: JOB_KINDS.matchSettlementLines,
        workspaceId,
        payload: { workspaceId, documentId } satisfies MatchSettlementReportInput,
      });
    }
  });

  return { status: "settlement_imported", accountId: clearingAccountId, accountCreated, linesTotal, linesImported, linesDuplicate: linesTotal - linesImported };
}

// --- decisions/0068-supplier-clearing-accounts.md: a clearing account owned by a CONTACT ---

/** How many unexplained bank transactions one booking pass looks at - the same bound
 * `PaymentsUseCases`' own unmatched scan uses, for the same reason (a workspace-wide scan
 * must not load everything into memory at once). */
const CONTACT_CLEARING_SCAN_PAGE_SIZE = 500;

/** Both idempotency keys are per (clearing account, document / bank transaction), which is
 * exactly what `transactions_account_idempotency_key` makes unique - booking the same invoice
 * or the same charge twice inserts nothing the second time. */
function contactClearingInvoiceKey(documentId: string): string {
  return `contact-clearing:invoice:${documentId}`;
}

function contactClearingChargeKey(bankTransactionId: string): string {
  return `contact-clearing:charge:${bankTransactionId}`;
}

function contactClearingAccountName(contactName: string): string {
  return `${contactName} (Verrechnungskonto)`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The two sides of decisions/0068, for ONE contact-owned clearing account:
 *
 * - **The invoice side.** Every incoming invoice of that contact books a NEGATIVE amount (the
 *   liability grows) and the document's own payment status becomes `settled`, never `open`:
 *   it is settled, just not by a payment of its own. An invoice a human already settled by a
 *   real transaction (a confirmed `document_transactions` row), or marked paid/"ohne Zahlung
 *   erledigt", is left completely alone - this account explains what no single payment can.
 * - **The charge side.** Every still-unexplained bank transaction whose counterparty resolves
 *   to that contact (`@/modules/payments`'s `resolveContactForCounterparty`: learned payment
 *   names first, then the card-merchant name comparison) books the OPPOSITE sign and is tied
 *   to the bank row by a shared `transferGroupId`, exactly as `recordPlatformPayout` does for
 *   an app-store payout. No confident resolution means the charge stays unexplained and
 *   visible, which is the safe failure.
 *
 * The balance is therefore what is still owed across the period the workspace actually holds
 * (decisions/0068's "Consequences": the UI says "unexplained", never "owed", because a charge
 * older than the first invoice in the system settles a period nobody uploaded).
 */
async function bookContactClearingAccount(
  deps: AccountsUseCaseDeps,
  input: { workspaceId: string; account: AccountRow; contact: { id: string; name: string } },
): Promise<ContactClearingBookingResult> {
  const { workspaceId, account, contact } = input;
  let invoicesBooked = 0;
  let chargesBooked = 0;

  const links = await deps.repos.documentContact.listForContact(workspaceId, contact.id);
  for (const link of links) {
    // `sender` is the role an INCOMING document's counterparty holds (the same role
    // `payments-use-cases.ts`'s `resolvePrimaryContact` expects for an incoming document).
    if (link.role !== "sender") continue;
    const doc = await deps.repos.document.findById(workspaceId, link.documentId);
    if (!doc || doc.direction !== "incoming" || doc.kind !== "incoming_invoice" || doc.totalAmountCents === null) continue;
    if (doc.paymentStatus === PAYMENT_STATUSES.paid || doc.paymentStatus === PAYMENT_STATUSES.noDocumentNeeded) continue;
    const existingLinks = await deps.repos.documentTransaction.listForDocument(workspaceId, doc.id);
    if (existingLinks.some((row) => row.status === "confirmed")) continue;

    const [inserted] = await deps.repos.transaction.insertManyIdempotent([
      {
        workspaceId,
        accountId: account.id,
        bookingDate: doc.documentDate ?? isoDate(doc.createdAt),
        valueDate: doc.documentDate,
        amountCents: -Math.abs(doc.totalAmountCents),
        currency: doc.currency ?? account.currency,
        creditDebit: "debit",
        counterpartyName: contact.name,
        counterpartyIban: null,
        counterpartyBic: null,
        remittanceText: doc.invoiceNumber,
        endToEndId: null,
        mandateId: null,
        creditorId: null,
        bankTxCode: null,
        bankReference: null,
        idempotencyKey: contactClearingInvoiceKey(doc.id),
        importBatchId: null,
        sourceDocumentId: doc.id,
        raw: null,
      },
    ]);
    if (inserted) invoicesBooked++;
    if (doc.paymentStatus !== PAYMENT_STATUSES.settled) {
      await deps.repos.document.updatePaymentStatus(workspaceId, doc.id, { paymentStatus: PAYMENT_STATUSES.settled, paidAt: doc.paidAt });
    }
  }

  // `listUnmatched` is exactly the "Buchungen ohne Beleg" pool: no confirmed document link,
  // not "kein Beleg nötig", not itself on a clearing account, and not already tied into one
  // by a `transferGroupId`.
  const { items: unexplained } = await deps.repos.transaction.listUnmatched(workspaceId, { page: 1, pageSize: CONTACT_CLEARING_SCAN_PAGE_SIZE });
  if (unexplained.length > 0) {
    // Resolution runs against EVERY contact of the workspace, not only this one: a charge
    // that looks more like another contact must not be claimed here.
    const contacts = await deps.repos.contact.listAllForWorkspace(workspaceId);
    const aliasRows = await deps.repos.paymentAlias.listForWorkspace(workspaceId);
    const aliases: ContactAliasMap = new Map(aliasRows.map((row) => [row.counterpartyNameNormalized, row.contactId]));

    for (const tx of unexplained) {
      if (resolveContactForCounterparty(tx.counterpartyName, contacts, aliases) !== contact.id) continue;
      const [booked] = await deps.repos.transaction.insertManyIdempotent([
        {
          workspaceId,
          accountId: account.id,
          bookingDate: tx.bookingDate,
          valueDate: tx.valueDate,
          // The opposite sign of the bank row: a charge (a debit on the bank account) pays
          // the supplier, so it reduces the liability on the clearing account.
          amountCents: -tx.amountCents,
          currency: tx.currency ?? account.currency,
          creditDebit: tx.amountCents <= 0 ? "credit" : "debit",
          counterpartyName: contact.name,
          counterpartyIban: null,
          counterpartyBic: null,
          remittanceText: tx.remittanceText ?? tx.counterpartyName,
          endToEndId: null,
          mandateId: null,
          creditorId: null,
          bankTxCode: null,
          bankReference: null,
          idempotencyKey: contactClearingChargeKey(tx.id),
          importBatchId: null,
          sourceDocumentId: null,
          raw: null,
        },
      ]);
      if (!booked) continue; // already booked by an earlier run (idempotency key hit)
      await deps.repos.transaction.setTransferGroup([booked.id, tx.id], crypto.randomUUID());
      chargesBooked++;
    }
  }

  return { invoicesBooked, chargesBooked };
}

/** One account's overview row (balance, coverage gaps, the mixed-currency warning) - shared
 * by `listAccounts` and `getAccountOverview` so the account detail page cannot drift from the
 * overview list it was reached from. */
async function toAccountOverview(deps: AccountsUseCaseDeps, workspaceId: string, account: AccountRow): Promise<AccountOverview> {
  const batches = await deps.repos.importBatch.listForAccount(workspaceId, account.id);
  const withClosingBalance = batches.find((b) => b.closingBalanceCents !== null);
  let latestBalanceCents: number | null;
  let balanceIsExact: boolean;
  let hasMixedCurrencyTransactions = false;
  if (withClosingBalance) {
    latestBalanceCents = withClosingBalance.closingBalanceCents;
    balanceIsExact = true;
  } else {
    const { amountCents: sum, hasMixedCurrency } = await deps.repos.transaction.sumAmountCents(workspaceId, account.id, account.currency);
    // decisions/0050: a clearing account never has statements - its own bookings ARE its
    // balance ("Guthaben bei der Plattform": imported report lines minus paid-out
    // payouts), so it is shown and counts as exact. A bank account without any import
    // batch shows nothing rather than a sum of transactions nobody vouched for.
    const isClearing = account.type === "clearing";
    const hasAnyBatch = batches.length > 0;
    latestBalanceCents = hasAnyBatch || isClearing ? sum : null;
    balanceIsExact = isClearing;
    hasMixedCurrencyTransactions = hasMixedCurrency;
  }
  const coverageGaps = findCoverageGaps(batches.map((b) => ({ statementFrom: b.statementFrom, statementTo: b.statementTo })));
  return { ...account, latestBalanceCents, balanceIsExact, coverageGaps, hasMixedCurrencyTransactions };
}

export function createAccountsUseCases(deps: AccountsUseCaseDeps): AccountsUseCases {
  return {
    async listAccounts(workspaceId) {
      const accounts = await deps.repos.account.listForWorkspace(workspaceId);
      return Promise.all(accounts.map((account) => toAccountOverview(deps, workspaceId, account)));
    },

    async getAccountOverview(workspaceId, accountId) {
      const account = await deps.repos.account.findById(workspaceId, accountId);
      if (!account) return null;
      return toAccountOverview(deps, workspaceId, account);
    },

    async createContactClearingAccount({ workspaceId, contactId }) {
      const contact = await deps.repos.contact.findById(workspaceId, contactId);
      if (!contact) throw new UseCaseError(ACCOUNT_ERROR.notFound);
      const existing = await deps.repos.account.findByContact(workspaceId, contactId);
      if (existing) throw new UseCaseError(ACCOUNT_ERROR.clearingAccountExists);

      let account: AccountRow;
      try {
        account = await deps.repos.account.create({
          workspaceId,
          type: "clearing",
          name: contactClearingAccountName(contact.name),
          iban: null,
          bic: null,
          // decisions/0068: a supplier's clearing account settles in the workspace's own
          // currency; like every other manually created account it stays editable afterwards.
          currency: "EUR",
          holder: null,
          platform: null,
          contactId,
        });
      } catch (err) {
        // Two admins clicking at the same time: the partial unique index
        // (`accounts_workspace_contact_clearing_key`) lets exactly one through, and the loser
        // gets the same stable code as the pre-check above rather than a raw database error.
        if (!isDbError(err, "unique")) throw err;
        throw new UseCaseError(ACCOUNT_ERROR.clearingAccountExists);
      }

      // "Creating the account books the history" (decisions/0068) - the contact's existing
      // invoices and the charges already imported, or the balance starts as a lie.
      await bookContactClearingAccount(deps, { workspaceId, account, contact });
      return account;
    },

    async getContactClearingAccount(workspaceId, contactId) {
      return deps.repos.account.findByContact(workspaceId, contactId);
    },

    async bookContactClearingEntries({ workspaceId }) {
      const accounts = await deps.repos.account.listForWorkspace(workspaceId);
      const contactClearingAccounts = accounts.filter((account) => account.type === "clearing" && account.contactId !== null);
      let invoicesBooked = 0;
      let chargesBooked = 0;
      for (const account of contactClearingAccounts) {
        const contact = await deps.repos.contact.findById(workspaceId, account.contactId!);
        // The contact was deleted (`on delete set null` keeps the ledger, see
        // `src/persistence/schema/accounts.ts`) - nothing new is booked onto an account whose
        // owner is gone, and nothing already booked is touched.
        if (!contact) continue;
        const result = await bookContactClearingAccount(deps, { workspaceId, account, contact });
        invoicesBooked += result.invoicesBooked;
        chargesBooked += result.chargesBooked;
      }
      return { invoicesBooked, chargesBooked };
    },

    async getAccount(workspaceId, accountId) {
      return deps.repos.account.findById(workspaceId, accountId);
    },

    async createAccount(input) {
      if (input.iban) {
        const existing = await deps.repos.account.findByIban(input.workspaceId, input.iban);
        if (existing) throw new UseCaseError(ACCOUNT_ERROR.duplicateIban);
      }
      return deps.repos.account.create({ ...input, contactId: null });
    },

    async updateAccount(input) {
      const current = await deps.repos.account.findById(input.workspaceId, input.accountId);
      if (!current) throw new UseCaseError(ACCOUNT_ERROR.notFound);

      // F5 review finding (F2 #2): block an IBAN change on an account that already has
      // imported history, checked BEFORE the duplicate-IBAN check below (a locked-IBAN error
      // is more specific and more actionable than "this IBAN belongs to another account").
      if (input.iban !== current.iban) {
        const existingBatches = await deps.repos.importBatch.listForAccount(input.workspaceId, input.accountId);
        if (existingBatches.length > 0) throw new UseCaseError(ACCOUNT_ERROR.ibanLockedByImports);
      }

      if (input.iban) {
        const existing = await deps.repos.account.findByIban(input.workspaceId, input.iban);
        if (existing && existing.id !== input.accountId) throw new UseCaseError(ACCOUNT_ERROR.duplicateIban);
      }
      const updated = await deps.repos.account.update(input.workspaceId, input.accountId, input);
      if (!updated) throw new UseCaseError(ACCOUNT_ERROR.notFound);
      return updated;
    },

    async listTransactions(workspaceId, accountId, filter) {
      return deps.repos.transaction.list(workspaceId, accountId, filter);
    },

    async listImportBatches(workspaceId, accountId) {
      return deps.repos.importBatch.listForAccount(workspaceId, accountId);
    },

    async listPendingAccountDocuments(workspaceId) {
      return deps.repos.importBatch.listPendingAccountDocuments(workspaceId);
    },

    async listSettlementLinesForDocument(workspaceId, documentId): Promise<SettlementLineRow[]> {
      return deps.repos.settlementLine.listForDocument(workspaceId, documentId);
    },

    async recordPlatformPayout({ workspaceId, platform, amountCents, bookingDate, bankTransactionId, reference }) {
      const clearingAccount = await deps.repos.account.findByPlatform(workspaceId, platform);
      if (!clearingAccount) return; // no clearing account yet: nothing was imported for this platform
      const bankTransaction = await deps.repos.transaction.findById(workspaceId, bankTransactionId);
      if (!bankTransaction || bankTransaction.transferGroupId) return; // already paired

      const [payoutTx] = await deps.repos.transaction.insertManyIdempotent([
        {
          workspaceId,
          accountId: clearingAccount.id,
          bookingDate,
          valueDate: bookingDate,
          amountCents: -Math.abs(amountCents),
          currency: bankTransaction.currency ?? clearingAccount.currency,
          creditDebit: "debit",
          counterpartyName: clearingAccountName(platform),
          counterpartyIban: null,
          counterpartyBic: null,
          remittanceText: reference,
          endToEndId: null,
          mandateId: null,
          creditorId: null,
          bankTxCode: null,
          bankReference: null,
          idempotencyKey: `app-store-payout:${bankTransactionId}`,
          importBatchId: null,
          sourceDocumentId: null,
          raw: null,
        },
      ]);
      if (!payoutTx) return; // already booked by an earlier run (idempotency key hit)
      await deps.repos.transaction.setTransferGroup([payoutTx.id, bankTransactionId], crypto.randomUUID());
    },

    async importFromDocument({ workspaceId, documentId, accountId }) {
      const doc = await deps.repos.document.findById(workspaceId, documentId);
      if (!doc) throw new UseCaseError(ACCOUNT_ERROR.notFound);
      const importableKinds = new Set(["bank_statement", "payout_report", "platform_settlement"]);
      if (doc.intakeStatus !== "confirmed" || !importableKinds.has(doc.kind)) {
        throw new UseCaseError(ACCOUNT_ERROR.notImportable);
      }

      // F4 (decisions/0026-platform-settlements.md): a payout/settlement report never has an
      // own-account IBAN or a bank-statement shape at all - it goes through its own,
      // completely separate import path (a clearing account, not a bank account; settlement
      // lines, not plain transactions).
      if (doc.kind === "payout_report" || doc.kind === "platform_settlement") {
        return importSettlementReportDocument(deps, { workspaceId, documentId, doc });
      }

      const statements = await loadImportableStatements(deps, doc);

      let resolvedAccountId = accountId ?? null;
      let accountCreated = false;

      if (resolvedAccountId) {
        const account = await deps.repos.account.findById(workspaceId, resolvedAccountId);
        if (!account) throw new UseCaseError(ACCOUNT_ERROR.notFound);
        // F5 review finding (F2 #4): a bank statement's transactions must never land on a
        // platform's own clearing account (F4) - that ledger is populated exclusively by
        // `importSettlementReportDocument` above, from a payout/settlement report's own rows.
        if (account.type !== "bank") throw new UseCaseError(ACCOUNT_ERROR.notBankAccount);
      } else {
        const primaryIban = statements.find((s) => s.accountIban)?.accountIban ?? null;
        const existingAccounts = await deps.repos.account.listForWorkspace(workspaceId);
        const matchedId = resolveAccountByIban(existingAccounts, primaryIban);
        if (matchedId) {
          resolvedAccountId = matchedId;
        } else if (primaryIban) {
          const normalized = normalizeIban(primaryIban);
          const created = await deps.repos.account.create({
            workspaceId,
            type: "bank",
            name: toAccountName(normalized),
            iban: normalized,
            bic: null,
            currency: statements.find((s) => s.currency)?.currency ?? "EUR",
            holder: null,
            platform: null,
          });
          resolvedAccountId = created.id;
          accountCreated = true;
        } else {
          // decisions/0024-accounts-and-transactions.md's "Pending account" section: no
          // own-account IBAN anywhere in this document and no explicit `accountId` given -
          // nothing is imported, the caller (the pipeline hook, or the UI) surfaces this
          // document in the pending-account list instead.
          return { status: "pending_account", reason: "missing_iban" };
        }
      }

      const finalAccountId = resolvedAccountId;
      const rows: CreateTransactionRow[] = statements.flatMap((statement) =>
        statement.transactions.map(
          (tx): CreateTransactionRow => ({
            workspaceId,
            accountId: finalAccountId,
            bookingDate: tx.bookingDate,
            valueDate: tx.valueDate,
            amountCents: tx.amountCents,
            currency: tx.currency,
            creditDebit: tx.creditDebit,
            counterpartyName: tx.counterpartyName,
            counterpartyIban: tx.counterpartyIban,
            counterpartyBic: tx.counterpartyBic,
            remittanceText: tx.remittanceText,
            endToEndId: tx.endToEndId,
            mandateId: tx.mandateId,
            creditorId: tx.creditorId,
            bankTxCode: tx.bankTxCode,
            bankReference: tx.bankReference,
            idempotencyKey: tx.idempotencyKey,
            importBatchId: null,
            sourceDocumentId: documentId,
            raw: tx.raw,
          }),
        ),
      );

      const summary = summarizeStatementsForBatch(statements);

      const batch = await deps.uow.transaction(async (repos) => {
        const inserted = await repos.transaction.insertManyIdempotent(rows);
        const batchRow = await repos.importBatch.upsertForDocument({
          workspaceId,
          accountId: finalAccountId,
          sourceDocumentId: documentId,
          statementFrom: summary.statementFrom,
          statementTo: summary.statementTo,
          openingBalanceCents: summary.openingBalanceCents,
          closingBalanceCents: summary.closingBalanceCents,
          rowsTotal: rows.length,
          rowsImported: inserted.length,
          rowsDuplicate: rows.length - inserted.length,
          balanceMismatch: summary.balanceMismatch,
        });
        await repos.transaction.assignBatch(
          inserted.map((r) => r.id),
          batchRow.id,
        );
        // F3b (decisions/0025-payment-matching-wiring.md): "after every successful import
        // batch" - only when this import actually inserted a NEW transaction (a re-import
        // that inserted zero new rows cannot possibly change any matching conclusion, since
        // every transaction it saw was already known before).
        // decisions/0076: due immediately, so the job runner that ran this import also runs
        // matching right after it, deduplicated to one queued run per workspace.
        if (inserted.length > 0) {
          await repos.jobs.scheduleNow({
            kind: JOB_KINDS.matchPayments,
            workspaceId,
            payload: { workspaceId, trigger: "import_batch" } satisfies MatchPaymentsInput,
            now: new Date(),
          });
          // F4 (decisions/0026-platform-settlements.md): "if the bank line arrives later, F2's
          // import hook must call back into this pairing" - a bank import may be exactly the
          // event a still-unpaired platform payout (from an EARLIER settlement-report import)
          // was waiting for, so every unpaired payout in the workspace gets one more pairing
          // attempt here, not only ones from this specific import.
          const unpaired = await repos.settlementLine.listUnpairedPayoutLines(workspaceId);
          for (const payout of unpaired) {
            await tryPairPayout(repos, workspaceId, { id: payout.transactionId, amountCents: payout.amountCents, bookingDate: payout.bookingDate ?? summary.statementFrom ?? "", payoutId: payout.payoutId });
          }
        }
        return batchRow;
      });

      return {
        status: "imported",
        accountId: finalAccountId,
        accountCreated,
        batchId: batch.id,
        rowsTotal: batch.rowsTotal,
        rowsImported: batch.rowsImported,
        rowsDuplicate: batch.rowsDuplicate,
        balanceMismatch: batch.balanceMismatch,
      };
    },
  };
}
