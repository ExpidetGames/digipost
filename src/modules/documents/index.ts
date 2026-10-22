// Neutral entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2): the processing pipeline's ports, pure
// helpers, and deterministic fakes (decisions/0016-processing-pipeline-and-ai.md). This is
// what lets both `src/persistence/use-cases/documents-use-cases.ts` (a use case must never
// import a module's own `server.ts`/`client.ts` - only a neutral entrypoint, WEBAPP_TEMPLATE_SPEC.md
// §5.4) and `src/platform/mistral` (a platform owner implementing this module's ports, allowed
// to import modules per the direction matrix) reach this module's `core/` without crossing the
// owner boundary anywhere but here. No `server-only`, no `"use client"`, no I/O.
export type {
  AnalysisResult,
  DocumentAnalyzer,
  ExtractedParty,
  GuidedAnalysisResult,
  GuidedCounterparty,
  InvoiceFields,
  OcrBlock,
  OcrEngine,
  OcrPage,
  OcrPageDimensions,
  OcrResult,
  OwnCompanyContext,
} from "./core/ports";
export { documentDisplayName, documentNameSource, type DocumentNameParts } from "./core/display-name";
export { MAX_GUIDED_PARTIES, validateAnalysisResult, validateGuidedAnalysisResult } from "./core/analysis-validation";
export { inferCurrency, parseGermanAmountToCents } from "./core/amount-parsing";
// C2 (decisions/0021-extraction-direction-and-invoice-fields.md): pure direction decision and
// linking-role resolution, used by `src/persistence/use-cases/documents-use-cases.ts`'s
// `processDocument` and unit-tested independently of any database.
export { decideDirection, nonOwnParties, resolveLinkRoles } from "./core/direction";
// decisions/0036-guided-extraction.md: `planCounterparty` derives a document's
// counterparty-extraction plan from `documents.kind` alone, before the analyzer ever runs;
// `isDerivedCounterpartyKind` is the small predicate `ui/document-detail-client.tsx`'s
// unclear-direction hint keys off (wave 2); `resolveReminderDirection` is the payment-IBAN
// override that has the final say over a reminder's direction once the guided analyzer has
// made its own guess. `isCounterpartySelf` is wave 2's self-counterparty guard, used by
// `src/persistence/use-cases/documents-use-cases.ts`'s `processOcrDocument`.
export { isDerivedCounterpartyKind, planCounterparty, type CounterpartyPlan } from "./core/party-roles";
export { extractValidIbans, resolvePaymentIban } from "./core/payment-iban";
export { resolveReminderDirection } from "./core/reminder-direction";
export { isCounterpartySelf } from "./core/self-counterparty-check";
// decisions/0072-correcting-a-document-s-kind.md: the kinds a human may assign to a processed
// PDF, checked again by `documents-use-cases.ts`'s `reclassifyDocument`.
export { isReclassifiableKind, RECLASSIFIABLE_KINDS, type ReclassifiableKind } from "./core/reclassification";
export { createFakeDocumentAnalyzer } from "./core/fake-document-analyzer";
export { createFakeOcrEngine } from "./core/fake-ocr-engine";
export { joinOcrText, truncateForAnalysis } from "./core/ocr-text";
export { buildSearchablePdf, mapBlockToPdfRect } from "./core/searchable-pdf";
export { sanitizeWinAnsi } from "./core/winansi";
// F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the processing
// pipeline's branching decision and the embedded-ZUGFeRD invoice field reader, both pure and
// used by `src/persistence/use-cases/documents-use-cases.ts`'s `processDocument`.
export { decideIntakeBranch, INTAKE_BRANCHES, type IntakeBranch, type IntakeBranchInput } from "./core/intake-branch";
export { extractZugferdInvoiceFields, type ZugferdExtraction } from "./core/zugferd-extraction";
export { findSemanticDuplicate, type InvoiceLikeDocument } from "./core/semantic-duplicate";
export {
  buildBankStatementIntakeResult,
  buildTabularConfirmedIntakeResult,
  MAX_EMBEDDED_ROWS,
  parseIntakeResult,
  type AppStorePayoutSummary,
  type BankStatementIntakeResult,
  type IntakeResult,
  type TabularConfirmedIntakeResult,
  type TabularProposalIntakeResult,
  type TabularRejectedIntakeResult,
} from "./core/intake-result";
// decisions/0075-email-intake.md: the mail-intake use case turns each mail attachment into a
// document through the very same byte sniffing and PDF assembly the upload route uses (pure,
// `pdf-lib` only, no I/O), so it needs them from this neutral entrypoint rather than
// `server.ts`, which a use case must never import.
export { processIntakeUpload, type ProcessedIntakeUpload, type ProcessIntakeUploadResult } from "./core/intake-upload-processing";
export { MAX_UPLOAD_PAGES } from "./core/upload-limits";
