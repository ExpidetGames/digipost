// Bundles every owner area's Drizzle repository into one `Repositories` object
// (WEBAPP_TEMPLATE_SPEC.md §5.3). The only place that imports every individual
// `repositories/drizzle/*-repository.ts` file; a new owner area adds one line here.
import type { DbExecutor } from "@/persistence/foundation/db-types";
import type { Repositories } from "@/persistence/repositories/contracts";

import {
  createDrizzleAccountRepository,
  createDrizzleImportBatchRepository,
  createDrizzleSettlementLineRepository,
  createDrizzleTransactionRepository,
} from "./accounts-repository";
import { createDrizzleBillingRepository } from "./billing-repository";
import {
  createDrizzleContactProposalRepository,
  createDrizzleContactRepository,
  createDrizzleDocumentContactRepository,
} from "./contacts-repository";
import { createDrizzleDocumentRepository } from "./documents-repository";
import { createDrizzleIntakeFingerprintRepository } from "./intake-fingerprints-repository";
import { createDrizzleJobsRepository } from "./jobs-repository";
import {
  createDrizzleDocumentTransactionRepository,
  createDrizzlePaymentAliasRepository,
  createDrizzlePaymentNoDocumentRuleRepository,
  createDrizzlePaymentRejectionRepository,
} from "./payments-repository";
import { createDrizzleSystemRepository } from "./system-repository";
import {
  createDrizzleWorkspaceInvitationRepository,
  createDrizzleWorkspaceMemberRepository,
  createDrizzleWorkspaceRepository,
} from "./workspaces-repository";

export function createDrizzleRepositories(db: DbExecutor): Repositories {
  return {
    system: createDrizzleSystemRepository(db),
    workspace: createDrizzleWorkspaceRepository(db),
    workspaceMember: createDrizzleWorkspaceMemberRepository(db),
    workspaceInvitation: createDrizzleWorkspaceInvitationRepository(db),
    document: createDrizzleDocumentRepository(db),
    billing: createDrizzleBillingRepository(db),
    jobs: createDrizzleJobsRepository(db),
    contact: createDrizzleContactRepository(db),
    documentContact: createDrizzleDocumentContactRepository(db),
    contactProposal: createDrizzleContactProposalRepository(db),
    intakeFingerprint: createDrizzleIntakeFingerprintRepository(db),
    account: createDrizzleAccountRepository(db),
    transaction: createDrizzleTransactionRepository(db),
    importBatch: createDrizzleImportBatchRepository(db),
    settlementLine: createDrizzleSettlementLineRepository(db),
    documentTransaction: createDrizzleDocumentTransactionRepository(db),
    paymentAlias: createDrizzlePaymentAliasRepository(db),
    paymentRejection: createDrizzlePaymentRejectionRepository(db),
    paymentNoDocumentRule: createDrizzlePaymentNoDocumentRuleRepository(db),
  };
}
