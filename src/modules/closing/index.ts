// Neutral entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2) of src/modules/closing
// (decisions/0066-abschluss-check-and-export.md): the period, the completeness check's pure
// shape, the export's naming rules, and the generated-name composition. No `server-only`, no
// `"use client"`, no I/O - everything here is a pure function over its arguments, which is
// what makes the whole Abschluss unit-testable without a database.
//
// This module owns no table. Its reads live behind `server.ts`.
export {
  CLOSING_PERIOD_KINDS,
  closingPeriodOptions,
  currentClosingPeriod,
  parseClosingPeriod,
  type ClosingPeriod,
  type ClosingPeriodKind,
} from "./core/period";
export { closingQuerySchema, readClosingPeriod } from "./core/schemas";
export {
  buildClosingReport,
  CLOSING_CHECK_KEYS,
  type ClosingCheckCounts,
  type ClosingCheckItem,
  type ClosingCheckKey,
  type ClosingPeriodTotals,
  type ClosingReport,
} from "./core/report";
export {
  assignBelegFileNames,
  AUSGANGSRECHNUNGEN_DIRECTORY,
  belegFileName,
  BELEGE_DIRECTORY,
  closingDirectoryFor,
  fileExtensionFor,
  OVERVIEW_FILE_NAME,
  slugifyFileNamePart,
  type BelegFileNameInput,
} from "./core/file-names";
export {
  buildClosingCrossReferences,
  closingReference,
  DOCUMENT_REFERENCE_PREFIX,
  TRANSACTION_REFERENCE_PREFIX,
  type ClosingAssignment,
  type ClosingCrossReferences,
  type ClosingReferenceLabels,
  type CrossReferenceCounterpart,
} from "./core/cross-references";
export {
  closingDocumentName,
  closingDocumentNameSource,
  type ClosingNameableDocument,
  type ClosingNameLabels,
} from "./core/document-name";
export type { ClosingAssignmentSheetRow, ClosingDocumentSheetRow, ClosingTransactionSheetRow } from "./core/types";
