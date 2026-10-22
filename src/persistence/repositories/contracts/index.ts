// The `Repositories` bundle and the `UnitOfWork` interface (WEBAPP_TEMPLATE_SPEC.md
// §5.3). Use cases (src/persistence/use-cases/**) import ONLY from here, never from
// src/persistence/repositories/drizzle/**: that keeps them free of Drizzle types and
// trivially testable with a fake (WEBAPP_TEMPLATE_SPEC.md §10.2's
// `createFakeRepositories` pattern, src/persistence/tests/support/fake-workspaces-repositories.ts).
//
// `Repositories` grows one field per owner area as its repositories land
// (`src/platform/auth` does not get a slot here: Better Auth owns its own tables
// through its own adapter, not through this Unit of Work; see
// src/persistence/schema/auth.ts's header comment).
//
// This template runs decisions/0004-three-database-roles.md's TARGET model
// directly: one runtime connection (`app_runtime`, real grants, no role switching),
// so `UnitOfWork` has exactly the one `transaction(work)` method WEBAPP_TEMPLATE_SPEC.md
// §5.3 describes. Unauthenticated public paths get their own narrow seam instead
// (`src/persistence/composition/public-services.ts`, backed by `getPublicDb()`), not a
// second `UnitOfWork` method.
import type { AccountRepository, ImportBatchRepository, SettlementLineRepository, TransactionRepository } from "./accounts-repository";
import type { BillingRepository } from "./billing-repository";
import type { ContactProposalRepository, ContactRepository, DocumentContactRepository } from "./contacts-repository";
import type { DocumentRepository } from "./documents-repository";
import type { IntakeFingerprintRepository } from "./intake-fingerprints-repository";
import type { JobsRepository } from "./jobs-repository";
import type { MailIntakeRepository } from "./mail-intake-repository";
import type {
  DocumentTransactionRepository,
  PaymentAliasRepository,
  PaymentArbiterAnswerRepository,
  PaymentNoDocumentRuleRepository,
  PaymentRejectionRepository,
} from "./payments-repository";
import type { SystemRepository } from "./system-repository";
import type {
  WorkspaceInvitationRepository,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from "./workspaces-repository";

export type { SystemRepository } from "./system-repository";
export type {
  CompanyProfileFields,
  CreateInvitationRow,
  CreateMembershipRow,
  CreateWorkspaceRow,
  WorkspaceInvitationRepository,
  WorkspaceInvitationRow,
  WorkspaceInvitationWithDetails,
  WorkspaceMemberRepository,
  WorkspaceMemberRow,
  WorkspaceMemberWithUser,
  WorkspaceRepository,
  WorkspaceRow,
} from "./workspaces-repository";
export { DOCUMENT_DIRECTIONS, DOCUMENT_INTAKE_STATUSES, DOCUMENT_KINDS, DOCUMENT_STATUSES } from "./documents-repository";
export type {
  ClosingDocumentCounts,
  ClosingDocumentRow,
  ClosingLinkedTransaction,
  CreateDocumentRow,
  DocumentDirection,
  DocumentIntakeStatus,
  DocumentKind,
  DocumentRepository,
  DocumentRow,
  DocumentStatus,
  DocumentWithRelations,
  ListDocumentsFilter,
  ListDocumentsResult,
  MarkDocumentDoneInput,
  MarkIntakeResultInput,
} from "./documents-repository";
export type {
  IntakeFingerprintRepository,
  IntakeFingerprintRow,
  UpsertConfirmedFingerprintInput,
} from "./intake-fingerprints-repository";
export type {
  BillingRepository,
  CreatePurchaseRow,
  CreateTierChangeRow,
  QuotaPackagePurchaseRow,
  WarningMarkers,
  WorkspaceMonthlyUsageRow,
  WorkspaceTierChangeRow,
} from "./billing-repository";
export { JOB_STATUSES } from "./jobs-repository";
export type { ClaimDueJobsInput, EnqueueJobInput, JobRow, JobsRepository, JobStatus } from "./jobs-repository";
export type {
  ContactChangeProposalRow,
  ContactFieldsPatch,
  ContactProposalRepository,
  ContactRepository,
  ContactRow,
  CreateContactRow,
  CreateProposalRow,
  DocumentContactRepository,
  DocumentContactRow,
  DocumentContactWithContact,
  DocumentContactWithDocument,
  ListContactsFilter,
  ListContactsResult,
} from "./contacts-repository";
export { ACCOUNT_TYPES, CREDIT_DEBIT_INDICATORS, SETTLEMENT_LINE_TYPES } from "./accounts-repository";
export type {
  AccountRepository,
  AccountRow,
  AccountType,
  ClosingLinkedDocument,
  ClosingTransactionCounts,
  ClosingTransactionRow,
  CreateAccountRow,
  CreateSettlementLineRow,
  CreateTransactionRow,
  CreditDebitIndicator,
  ImportBatchRepository,
  ImportBatchRow,
  SettlementLineRepository,
  SettlementLineRow,
  SettlementLineType,
  TransactionListFilter,
  TransactionListResult,
  TransactionMatchFilter,
  TransactionRepository,
  TransactionRow,
  TransactionUnmatchedFilter,
  UpdateAccountRow,
  UpsertImportBatchRow,
} from "./accounts-repository";
export type {
  CreateInboundEmailRow,
  InboundEmailRow,
  MailIntakeAllowedSenderRow,
  MailIntakeRepository,
  MailIntakeSettingsRow,
  UpdateInboundEmailPatch,
} from "./mail-intake-repository";
export type {
  CreateDocumentTransactionRow,
  DecideDocumentTransactionInput,
  DocumentTransactionRepository,
  DocumentTransactionRow,
  DocumentTransactionWithDetails,
  PaymentAliasRepository,
  PaymentAliasRow,
  PaymentArbiterAnswerRepository,
  PaymentArbiterAnswerRow,
  PaymentNoDocumentRuleRepository,
  PaymentNoDocumentRuleRow,
  PaymentRejectionRepository,
  PaymentRejectionRow,
} from "./payments-repository";

export type Repositories = {
  system: SystemRepository;
  workspace: WorkspaceRepository;
  workspaceMember: WorkspaceMemberRepository;
  workspaceInvitation: WorkspaceInvitationRepository;
  document: DocumentRepository;
  billing: BillingRepository;
  jobs: JobsRepository;
  contact: ContactRepository;
  documentContact: DocumentContactRepository;
  contactProposal: ContactProposalRepository;
  intakeFingerprint: IntakeFingerprintRepository;
  account: AccountRepository;
  transaction: TransactionRepository;
  importBatch: ImportBatchRepository;
  settlementLine: SettlementLineRepository;
  documentTransaction: DocumentTransactionRepository;
  paymentAlias: PaymentAliasRepository;
  paymentRejection: PaymentRejectionRepository;
  paymentNoDocumentRule: PaymentNoDocumentRuleRepository;
  /** decisions/0077-arbiter-answer-cache.md, owner `src/modules/payments`. */
  paymentArbiterAnswer: PaymentArbiterAnswerRepository;
  /** decisions/0075-email-intake.md, owner `src/modules/mail-intake`. */
  mailIntake: MailIntakeRepository;
  // … one entry per repository
};

/**
 * Hands out `Repositories` bound to one transaction. `transaction` runs `work` in
 * EXACTLY one transaction and returns whatever `work` returns; use cases never see
 * a `tx`/`DbExecutor` directly (WEBAPP_TEMPLATE_SPEC.md §5.1).
 */
export interface UnitOfWork {
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
