// The processing pipeline's branching decision (decisions/0020-universal-intake.md,
// decisions/0022-intake-wiring.md): pure and dependency-free so the decision table itself is
// unit-testable without a database, storage, or an AI adapter. `processDocument`
// (`src/persistence/use-cases/documents-use-cases.ts`) computes each `IntakeBranchInput` field
// (from the document's own `mimeType`, `@/modules/intake`'s `detectCamt053`, and a fingerprint
// repository lookup) and calls `decideIntakeBranch` once to pick the actual code path.
export const INTAKE_BRANCHES = [
  "ocr",
  "camt053",
  "mt940",
  "apple_payment_summary",
  "google_play_earnings",
  "tabular_known_source",
  "tabular_unknown_source",
] as const;
export type IntakeBranch = (typeof INTAKE_BRANCHES)[number];

export type IntakeBranchInput = {
  /** The stored `original.<ext>` object's MIME type - "application/pdf" for every scanned
   * letter/invoice (a direct PDF upload, or an image assembled into one); anything else is a
   * structured intake file. */
  mimeType: string;
  /** Only meaningful when `mimeType` is an XML type: whether `detectCamt053` recognized the
   * document's own namespace (the ISO 20022 self-identifying exception,
   * decisions/0020-universal-intake.md, decision 1). */
  isCamt053: boolean;
  /** Whether this document is a recognized MT940 statement (decisions/0028-mt940-support.md) -
   * the second self-identifying, deterministic bank-statement format, alongside camt.053.
   * Computed by the caller from the document's own stored MIME type
   * (`@/modules/intake`'s `MT940_MIME_TYPE`), kept as an opaque boolean here the same way
   * `isCamt053` already is, rather than hardcoding a concrete MIME string in this
   * otherwise dependency-free decision table. */
  isMt940: boolean;
  /** Only meaningful for a CSV `mimeType`: whether `detectApplePaymentSummary` recognized
   * Apple's own "iTunes Connect - Zahlungen und Finanzberichte" title cell and header
   * (decisions/0048-app-store-reports.md) - the third self-identifying, deterministic format,
   * alongside camt.053/MT940. */
  isApplePaymentSummary: boolean;
  /** Only meaningful for a CSV `mimeType`: whether `detectGooglePlayEarnings` recognized
   * Google Play's own earnings-report header (decisions/0048-app-store-reports.md) - the
   * fourth self-identifying, deterministic format. */
  isGooglePlayEarnings: boolean;
  /** Only meaningful for a CSV/TSV `mimeType`: whether this workspace has already confirmed a
   * source with the same `TabularSample.fingerprint` (decisions/0020, decision 4's "confirm
   * once" flow). */
  hasKnownFingerprint: boolean;
};

/**
 * `"ocr"` - every PDF/image document (a scanned letter, invoice, ...): the existing OCR +
 * analysis pipeline (decisions/0016-processing-pipeline-and-ai.md), extended by F1b to
 * also set `documents.kind` (via `IntakeClassifier` on the OCR text, or self-identified from an
 * embedded ZUGFeRD/Factur-X/XRechnung invoice XML when present).
 *
 * `"camt053"` - a self-identifying bank statement: deterministic parse, no model call, always
 * `intake_status: "confirmed"` (decisions/0020, decision 1).
 *
 * `"mt940"` - a self-identifying SWIFT MT940 bank statement: deterministic parse, no model
 * call, always `intake_status: "confirmed"`, treated exactly like `"camt053"` from here on
 * (decisions/0028-mt940-support.md).
 *
 * `"apple_payment_summary"` - Apple's own monthly "iTunes Connect - Zahlungen und
 * Finanzberichte" payment summary: deterministic parse, no model call, always
 * `intake_status: "confirmed"`, `kind: "payout_report"` (decisions/0048-app-store-reports.md).
 *
 * `"google_play_earnings"` - Google Play's own monthly earnings report: deterministic parse,
 * no model call, always `intake_status: "confirmed"`, `kind: "platform_settlement"`
 * (decisions/0048-app-store-reports.md).
 *
 * `"tabular_known_source"` - a CSV/TSV whose column layout this workspace has already
 * confirmed: apply the stored mapping, validate, `confirmed` without a model call.
 *
 * `"tabular_unknown_source"` - a CSV/TSV never seen before (by fingerprint): the classifier
 * proposes a kind/mapping, `validateMapping` checks it against every row, and the result is
 * stored as a `pending_confirmation` proposal regardless of whether validation passed - a
 * human reviews and confirms/rejects it once per source layout (decisions/0020, decision 4).
 */
export function decideIntakeBranch(input: IntakeBranchInput): IntakeBranch {
  if (input.mimeType === "application/pdf") return "ocr";
  if (input.isCamt053) return "camt053";
  if (input.isMt940) return "mt940";
  if (input.isApplePaymentSummary) return "apple_payment_summary";
  if (input.isGooglePlayEarnings) return "google_play_earnings";
  return input.hasKnownFingerprint ? "tabular_known_source" : "tabular_unknown_source";
}
