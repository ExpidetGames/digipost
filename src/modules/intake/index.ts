// Neutral entrypoint of src/modules/intake (WEBAPP_TEMPLATE_SPEC.md §4.2): pure domain logic
// only (no I/O, no `server-only`, no `"use client"`) - safe to import from
// `src/platform/mistral` (the real `IntakeClassifier` adapter, `IntakeClassifier`/
// `parseIntakeClassification`/`TabularSample`) and later from F1b/F2's persistence and
// upload-route code alike, the same role `src/modules/documents/index.ts` and
// `src/modules/contacts/index.ts` already play for their own owners.
export { decodeTextBytes, detectEncoding, FILE_KINDS, sniffFileKind, type FileKind } from "./core/file-kind";
export { assertSafeXml, createSafeXmlParser, parseXmlSafely, UnsafeXmlError } from "./core/xml-safety";
export { detectCamt053, type Camt053Detection } from "./core/camt053-detect";
export { extractEmbeddedXml } from "./core/embedded-xml";
export {
  camt053StatementReconciles,
  parseCamt053,
  type Camt053Balance,
  type Camt053ParseResult,
  type Camt053Statement,
  type CreditDebitIndicator,
  type NormalizedTransaction,
} from "./core/camt053-parser";
export {
  MT940_ERROR,
  MT940_MIME_TYPE,
  Mt940ParseError,
  mt940StatementReconciles,
  parseMt940,
  type Mt940ErrorCode,
  type Mt940ParseResult,
  type Mt940Statement,
} from "./core/mt940-parser";
export {
  detectAmountFormat,
  GERMAN_AMOUNT_FORMAT,
  parseAmountToCents,
  PLAIN_COMMA_AMOUNT_FORMAT,
  PLAIN_POINT_AMOUNT_FORMAT,
  US_AMOUNT_FORMAT,
  type AmountFormat,
  type DecimalSeparator,
  type ThousandsSeparator,
} from "./core/amount-parsing";
export {
  parseTabularRows,
  sampleTabular,
  type ColumnInference,
  type ColumnType,
  type DelimiterChar,
  type SampleTabularOptions,
  type TabularSample,
} from "./core/tabular-sample";
export {
  DOCUMENT_KINDS,
  parseIntakeClassification,
  SEMANTIC_FIELDS,
  SETTLEMENT_PLATFORMS,
  type AmountSign,
  type ColumnMapping,
  type DocumentKind,
  type IntakeClassification,
  type IntakeClassifier,
  type IntakeClassifierInput,
  type IntakeClassifierTabularInput,
  type IntakeClassifierTextInput,
  type IntakeOwnCompany,
  type SemanticField,
  type SettlementPlatform,
} from "./core/classification";
export { createFakeIntakeClassifier } from "./core/fake-intake-classifier";
export {
  validateMapping,
  type MappingProblem,
  type MappingProblemCode,
  type NormalizedBankTransactionFromMapping,
  type NormalizedSettlementLine,
  type ValidateMappingOptions,
  type ValidateMappingResult,
} from "./core/mapping-validator";
export { fileHash, semanticInvoiceKey, type SemanticInvoiceKeyInput } from "./core/duplicate";
export { computeIdempotencyKeyV2, normalizeReference, OccurrenceCounter } from "./core/idempotency-key";
export {
  APPLE_PAYMENT_SUMMARY_ERROR,
  ApplePaymentSummaryParseError,
  detectApplePaymentSummary,
  parseApplePaymentSummary,
  type ApplePaymentSummaryErrorCode,
  type ApplePaymentSummaryResult,
} from "./core/apple-payment-summary";
export {
  detectGooglePlayEarnings,
  GOOGLE_PLAY_EARNINGS_ERROR,
  GooglePlayEarningsParseError,
  parseGooglePlayEarnings,
  type GooglePlayEarningsErrorCode,
  type GooglePlayEarningsResult,
} from "./core/google-play-earnings";
