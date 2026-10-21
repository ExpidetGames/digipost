// The composition root (WEBAPP_TEMPLATE_SPEC.md §5.5). The only file under
// `src/persistence/` allowed to bind concrete adapters from `src/platform/*/server` to use
// cases. Builds the request-scoped dependency graph (the runtime `AppDb`, its
// `Repositories`, and its `UnitOfWork`) and hands each owner area's use-case
// factory its `{ repos, uow }`.
//
// `workspaces` (P1, decisions/0014-workspaces-and-access.md) is the tenancy owner area:
// `createWorkspaceUseCases({ repos, uow })` below. `billing` and `documents` (P2a,
// decisions/0015-documents-and-quotas.md) are wired the same way, with one addition:
// `documents` is handed the already-built `billing` use case object (not just `repos`/`uow`)
// so `documents.createFromUpload` can call `billing.recordDocumentsCreated` inside its own
// transaction (see `src/persistence/use-cases/documents-use-cases.ts`'s header comment for
// why that is not a "documents writes billing's table" violation). `documents` is also the
// first use case to receive a `src/platform/*` port directly (`getObjectStorage()`) - this
// composition root is the one place allowed to bind that.
//
// `system` (T5) has no owner and no table: it only exists so `GET /api/health`
// reaches the runtime connection through this same "one door in" composition root
// instead of calling `src/persistence/foundation/client.ts` directly
// (`src/persistence/repositories/contracts/system-repository.ts`'s header comment).
//
// `contacts` (C1, decisions/0019-contacts.md) is wired the same plain way as `workspaces` -
// it needs only `{ repos, uow }`, no platform port, since matching/normalization are pure
// functions from `@/modules/contacts` called directly by the use case.
import "server-only";

import { createJobHandlers } from "@/persistence/composition/job-handlers";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createAccountsUseCases } from "@/persistence/use-cases/accounts-use-cases";
import { createBillingUseCases } from "@/persistence/use-cases/billing-use-cases";
import { createClosingUseCases } from "@/persistence/use-cases/closing-use-cases";
import { createContactUseCases } from "@/persistence/use-cases/contacts-use-cases";
import { createDocumentUseCases } from "@/persistence/use-cases/documents-use-cases";
import { createJobsUseCases } from "@/persistence/use-cases/jobs-use-cases";
import { createPaymentsUseCases } from "@/persistence/use-cases/payments-use-cases";
import { createSystemUseCases } from "@/persistence/use-cases/system-use-cases";
import { createWorkspaceUseCases } from "@/persistence/use-cases/workspaces-use-cases";
import { getPaymentProvider } from "@/modules/billing/server";
import { createSmtpMailer } from "@/platform/mailer/server";
import { getDocumentAnalyzer, getIntakeClassifier, getOcrEngine, getPaymentArbiter } from "@/platform/mistral/server";
import { getObjectStorage } from "@/platform/object-storage/server";

export function createRequestServices() {
  const db = getDb();
  const repos = createDrizzleRepositories(db);
  const uow = createDrizzleUnitOfWork(db);
  const objectStorage = getObjectStorage();
  const mailer = createSmtpMailer();

  const billing = createBillingUseCases({ repos, uow, paymentProvider: getPaymentProvider() });
  const workspaces = createWorkspaceUseCases({ repos, uow });
  // Built before `documents` (C2, decisions/0021-extraction-direction-and-invoice-fields.md):
  // `documents.processDocument` calls `contacts.upsertFromExtraction` directly, the same
  // "hand the already-built use case object to the one that needs it" pattern `billing` above
  // already established for `documents.createFromUpload`.
  const contacts = createContactUseCases({ repos, uow });
  const documents = createDocumentUseCases({
    repos,
    uow,
    objectStorage,
    billing,
    contacts,
    ocrEngine: getOcrEngine(),
    analyzer: getDocumentAnalyzer(),
    // F1b (decisions/0020-universal-intake.md): the same env-driven getter F1a's own
    // composition entry point (`src/platform/mistral/server/get-intake-classifier.ts`)
    // already exposes, bound here alongside the other AI adapters.
    intakeClassifier: getIntakeClassifier(),
  });
  // F2 (decisions/0024-accounts-and-transactions.md): only needs `{ repos, uow,
  // objectStorage }`, same plain wiring `contacts` above already gets - the import service
  // reads/writes its own tables directly and re-reads a document's original bytes via the
  // already-bound `objectStorage`, no other module's use case needed.
  const accounts = createAccountsUseCases({ repos, uow, objectStorage });
  // F3b (decisions/0025-payment-matching-wiring.md): only needs `{ repos, uow, paymentArbiter
  // }`, the same plain wiring `contacts`/`accounts` above already get - the matching
  // orchestration reads/writes its own tables directly and calls F3a's pure functions, no
  // other module's use case needed. `getPaymentArbiter()` binds the real Mistral adapter or
  // `createFakePaymentArbiter()` by env, exactly like `getIntakeClassifier()` above.
  const payments = createPaymentsUseCases({ repos, uow, paymentArbiter: getPaymentArbiter(), accounts });

  // "Handlers registered where they belong" (decisions/0016-processing-pipeline-and-ai.md):
  // `src/platform/jobs`'s generic runner never sees `documents`/`billing`/`workspaces`/
  // `accounts`/`payments`/`mailer` directly, only this kind -> handler map, built once here
  // from the use cases this same function already constructed.
  const jobHandlers = createJobHandlers({ documents, billing, workspaces, accounts, payments, mailer, objectStorage });

  // decisions/0066-abschluss-check-and-export.md: the Abschluss owns no table and needs no
  // port - only period-scoped reads over repositories other owners already own, so it gets
  // the plainest wiring of all (`{ repos }`, no `uow`: it never writes).
  const closing = createClosingUseCases({ repos });

  return {
    system: createSystemUseCases({ repos }),
    workspaces,
    billing,
    documents,
    contacts,
    accounts,
    payments,
    closing,
    jobs: createJobsUseCases({ repos, uow, handlers: jobHandlers }),
  };
}

export type RequestServices = ReturnType<typeof createRequestServices>;
