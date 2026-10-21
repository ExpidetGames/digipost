// The recognizer port and its output contract (decisions/0020-universal-intake.md): "the AI
// proposes, the code verifies". `IntakeClassifier` is implemented by
// `src/platform/mistral/server/mistral-intake-classifier.ts` (the real adapter) and
// `fake-intake-classifier.ts` (the deterministic test double); both funnel their raw output
// through `parseIntakeClassification` here, so every caller gets the identical guarantee
// regardless of which adapter produced the answer - the same shape
// `src/modules/documents/core/analysis-validation.ts`'s `validateAnalysisResult` already
// established for OCR document analysis.
import { z } from "zod";

import type { TabularSample } from "./tabular-sample";

export const DOCUMENT_KINDS = [
  "letter",
  "incoming_invoice",
  "outgoing_invoice",
  "reminder",
  "receipt",
  "bank_statement",
  "payout_report",
  "platform_settlement",
  "contract",
  "authority_letter",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const SETTLEMENT_PLATFORMS = ["stripe", "apple", "google", "paypal", "amazon", "other"] as const;
export type SettlementPlatform = (typeof SETTLEMENT_PLATFORMS)[number];

/** Our own semantic fields a tabular source's columns can map onto. Deliberately a flat,
 * fixed list covering bank statements (bookingDate..reference) and payout/settlement reports
 * (fee..countryOfSale) alike, rather than a per-documentKind schema - one small, closed
 * vocabulary is easier for both the model and `validateMapping` to reason about than a
 * different shape per report type. */
export const SEMANTIC_FIELDS = [
  "bookingDate",
  "valueDate",
  "amount",
  "currency",
  "creditDebit",
  "counterpartyName",
  "counterpartyIban",
  "reference",
  "description",
  "endToEndId",
  "fee",
  "gross",
  "net",
  "payoutId",
  "customerName",
  "customerEmail",
  "invoiceNumber",
  "chargeId",
  "productName",
  "quantity",
  "countryOfSale",
] as const;
export type SemanticField = (typeof SEMANTIC_FIELDS)[number];

export type ColumnMapping = Partial<Record<SemanticField, string>>;

/** How a tabular source encodes a transaction's sign. A model must pick exactly one shape;
 * `validateMapping` checks the referenced column(s) actually behave consistently with it. */
export type AmountSign =
  | { mode: "signed_column"; column: string }
  | { mode: "separate_credit_debit_columns"; creditColumn: string; debitColumn: string }
  | { mode: "indicator_column"; amountColumn: string; indicatorColumn: string; creditValue: string; debitValue: string };

/** decisions/0043: who the user's company is, so incoming and outgoing invoices can be told
 * apart. Every invoice is "outgoing" from its issuer's point of view; without this the classifier
 * can only guess, and it classified supplier invoices (IONOS, a city fee) as the user's own. */
export type IntakeOwnCompany = {
  name: string;
  aliases: readonly string[];
  address: string | null;
  ibans: readonly string[];
  domains: readonly string[];
  profileText: string | null;
};
export type IntakeClassifierTextInput = { kind: "text"; text: string; ownCompany?: IntakeOwnCompany | null };
export type IntakeClassifierTabularInput = { kind: "tabular"; sample: TabularSample };
export type IntakeClassifierInput = IntakeClassifierTextInput | IntakeClassifierTabularInput;

export type IntakeClassification = {
  documentKind: DocumentKind;
  confidence: number;
  /** One German sentence explaining the classification - shown to the user at confirmation
   * time, never silently trusted (decisions/0020-universal-intake.md's "verify-then-confirm"
   * flow). */
  reason: string;
  platform: SettlementPlatform | null;
  columnMapping: ColumnMapping | null;
  amountSign: AmountSign | null;
};

/** The port every AI adapter (real or fake) implements. `classify` must never throw for a
 * merely-odd input; a genuine provider failure (network, auth, rate limit) is the adapter's
 * own concern (`MistralRequestError` for the real one). */
export type IntakeClassifier = {
  classify(input: IntakeClassifierInput): Promise<IntakeClassification>;
};

// --- lenient parsing of a raw model response, mirroring
// `src/platform/mistral/core/schemas.ts`'s style: every field a real response could
// plausibly omit or get wrong is optional/nullable here, and `parseIntakeClassification`
// (below) degrades to a safe fallback rather than ever throwing. ---

const columnMappingSchema = z.record(z.string(), z.string());

const amountSignSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("signed_column"), column: z.string() }),
  z.object({ mode: z.literal("separate_credit_debit_columns"), creditColumn: z.string(), debitColumn: z.string() }),
  z.object({
    mode: z.literal("indicator_column"),
    amountColumn: z.string(),
    indicatorColumn: z.string(),
    creditValue: z.string(),
    debitValue: z.string(),
  }),
]);

const rawIntakeClassificationSchema = z.object({
  documentKind: z.enum(DOCUMENT_KINDS),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  platform: z.enum(SETTLEMENT_PLATFORMS).nullish(),
  columnMapping: columnMappingSchema.nullish(),
  amountSign: amountSignSchema.nullish(),
});

const FALLBACK_CLASSIFICATION: IntakeClassification = {
  documentKind: "other",
  confidence: 0,
  reason: "Die Antwort des Modells konnte nicht ausgewertet werden.",
  platform: null,
  columnMapping: null,
  amountSign: null,
};

/** Every semantic field name a mapping/amount-sign reference must resolve to something in
 * `header` (case-sensitive, exact match) - a name the model invented that is not an actual
 * column in the sample is dropped, never trusted (decisions/0020-universal-intake.md: "the
 * AI proposes, the code verifies"). */
function columnExists(header: readonly string[] | null, name: string): boolean {
  return header === null || header.includes(name);
}

function sanitizeColumnMapping(mapping: Record<string, string> | null | undefined, header: readonly string[] | null): ColumnMapping | null {
  if (!mapping) return null;
  const cleaned: ColumnMapping = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (!SEMANTIC_FIELDS.includes(field as SemanticField)) continue;
    if (!columnExists(header, column)) continue;
    cleaned[field as SemanticField] = column;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function sanitizeAmountSign(amountSign: z.infer<typeof amountSignSchema> | null | undefined, header: readonly string[] | null): AmountSign | null {
  if (!amountSign) return null;
  let columns: string[];
  if (amountSign.mode === "signed_column") columns = [amountSign.column];
  else if (amountSign.mode === "separate_credit_debit_columns") columns = [amountSign.creditColumn, amountSign.debitColumn];
  else columns = [amountSign.amountColumn, amountSign.indicatorColumn];
  return columns.every((column) => columnExists(header, column)) ? amountSign : null;
}

/**
 * Parses a raw model response into a safe `IntakeClassification`. Never throws: a response
 * that fails even this lenient shape check degrades to `FALLBACK_CLASSIFICATION`
 * (`documentKind: "other"`, `confidence: 0`), exactly like
 * `src/modules/documents/core/analysis-validation.ts`'s `validateAnalysisResult` does for the
 * document-analysis pipeline. When `header` is given (tabular input), every
 * `columnMapping`/`amountSign` column reference not actually present in that header is
 * dropped rather than trusted - this is the "code verifies" half of decisions/0020's
 * "AI proposes, code verifies" principle.
 */
export function parseIntakeClassification(raw: unknown, header: readonly string[] | null = null): IntakeClassification {
  const parsed = rawIntakeClassificationSchema.safeParse(raw);
  if (!parsed.success) return FALLBACK_CLASSIFICATION;

  return {
    documentKind: parsed.data.documentKind,
    confidence: parsed.data.confidence,
    reason: parsed.data.reason,
    platform: parsed.data.platform ?? null,
    columnMapping: sanitizeColumnMapping(parsed.data.columnMapping, header),
    amountSign: sanitizeAmountSign(parsed.data.amountSign, header),
  };
}
