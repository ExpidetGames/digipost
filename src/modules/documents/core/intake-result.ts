// The shape stored in `documents.intake_result` (decisions/0020-universal-intake.md,
// decisions/0022-intake-wiring.md) - one discriminated payload per non-OCR intake branch
// (`@/modules/documents`'s `decideIntakeBranch`). This is the contract F2/F4 (and this
// phase's own confirmation UI/read models) consume: normalized bank transactions or
// settlement lines live directly on a confirmed payload; an unconfirmed proposal instead
// carries everything the confirmation UI needs to render the mapping table and validation
// problems without re-reading the original file.
//
// Kept deliberately small for a large source (decisions/0022-intake-wiring.md's own scope
// note "or a compact summary if too large"): `MAX_EMBEDDED_ROWS` caps how many normalized
// rows/transactions are embedded directly; a larger result keeps only the count and a
// `truncated: true` marker, on the assumption a later phase (F2/F4) re-derives the full row
// set from the stored original file rather than round-tripping arbitrarily large JSON through
// this column.
import { z } from "zod";

import {
  DOCUMENT_KINDS,
  SEMANTIC_FIELDS,
  SETTLEMENT_PLATFORMS,
  type AmountSign,
  type ColumnMapping,
  type DocumentKind,
  type SettlementPlatform,
} from "@/modules/intake";
import type { MappingProblem, NormalizedBankTransactionFromMapping, NormalizedSettlementLine, NormalizedTransaction } from "@/modules/intake";

/** Above this many rows, a confirmed tabular/CAMT result keeps only the count, not every
 * normalized row - keeps `intake_result` bounded for a large yearly export
 * (decisions/0020-universal-intake.md's own "or a compact summary if too large" scope note). */
export const MAX_EMBEDDED_ROWS = 500;

export type BankStatementIntakeResult = {
  type: "bank_statement";
  statementCount: number;
  transactionCount: number;
  /** `true` only when every statement's own opening/closing balance reconciles against its
   * transactions (`@/modules/intake`'s `camt053StatementReconciles`) - a data-quality signal,
   * never a reason to reject the import (a camt.053 statement is always self-identifying and
   * therefore always `confirmed`, decisions/0020, decision 1). */
  allStatementsReconcile: boolean;
  truncated: boolean;
  /** decisions/0061-a-statement-is-dated-by-its-last-booking.md: the latest `bookingDate` in
   * the file, which is the date the inbox gives the statement. Computed over EVERY parsed
   * transaction, before `truncated` can drop any of them, so it stays right for a statement
   * with more than `MAX_EMBEDDED_ROWS` bookings. `null` only for a statement with no
   * transactions at all, or one imported before this field existed. */
  lastBookingDate: string | null;
  /** From `@/modules/intake`'s `parseCamt053` directly - the camt.053 statement's own
   * transaction shape, distinct from `NormalizedBankTransactionFromMapping` (the
   * mapping-validator's output for a CSV/TSV source): a self-identifying XML statement is
   * never routed through `validateMapping` at all. */
  transactions: NormalizedTransaction[];
};

/** decisions/0048-app-store-reports.md: only set for Apple's payment-summary or Google Play's
 * earnings deterministic readers - the report's own stated (Apple, from its footer, or the
 * sum of proceeds when the footer is missing) or derived (Google, the sum of every row's own
 * amount) payout/net total, for `PaymentsUseCases`'s app-store payout-to-bank-credit pairing.
 * `undefined` for every other tabular/confirmed source (the generic AI-mapped path has no
 * comparably reliable "this report's own stated total" signal to carry). */
export type AppStorePayoutSummary = {
  platform: Extract<SettlementPlatform, "apple" | "google">;
  /** ISO `YYYY-MM`. */
  period: string;
  payoutAmountCents: number;
  payoutCurrency: string;
};

export type TabularConfirmedIntakeResult = {
  type: "tabular_confirmed";
  documentKind: DocumentKind;
  platform: SettlementPlatform | null;
  rowCount: number;
  truncated: boolean;
  rows: NormalizedBankTransactionFromMapping[] | NormalizedSettlementLine[];
  appStorePayout?: AppStorePayoutSummary;
};

export type TabularProposalIntakeResult = {
  type: "tabular_proposal";
  documentKind: DocumentKind;
  platform: SettlementPlatform | null;
  reason: string;
  columnMapping: ColumnMapping;
  amountSign: AmountSign | null;
  sampleHeader: string[];
  sampleRows: string[][];
  rowCount: number;
  validation: { ok: true } | { ok: false; problems: MappingProblem[] };
};

export type TabularRejectedIntakeResult = { type: "tabular_rejected"; documentKind: DocumentKind };

export type IntakeResult = BankStatementIntakeResult | TabularConfirmedIntakeResult | TabularProposalIntakeResult | TabularRejectedIntakeResult;

// `z.partialRecord`, not `z.record`: see `core/schemas.ts`'s identical note - an enum-keyed
// `z.record` in this Zod version requires every enum key present, which a real column mapping
// never has.
const columnMappingSchema = z.partialRecord(z.enum(SEMANTIC_FIELDS), z.string()) as z.ZodType<ColumnMapping>;
const amountSignSchema = z.custom<AmountSign>((value) => typeof value === "object" && value !== null && "mode" in value);
const mappingProblemSchema = z.object({
  rowNumber: z.number(),
  field: z.string(),
  code: z.string(),
  message: z.string(),
}) as z.ZodType<MappingProblem>;

const intakeResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bank_statement"),
    statementCount: z.number(),
    transactionCount: z.number(),
    allStatementsReconcile: z.boolean(),
    truncated: z.boolean(),
    // Optional so a statement stored before decisions/0061 still parses; the reader always
    // writes it now.
    lastBookingDate: z.string().nullable().optional(),
    transactions: z.array(z.any()),
  }),
  z.object({
    type: z.literal("tabular_confirmed"),
    documentKind: z.enum(DOCUMENT_KINDS),
    platform: z.enum(SETTLEMENT_PLATFORMS).nullable(),
    rowCount: z.number(),
    truncated: z.boolean(),
    rows: z.array(z.any()),
    appStorePayout: z
      .object({
        platform: z.enum(["apple", "google"]),
        period: z.string(),
        payoutAmountCents: z.number(),
        payoutCurrency: z.string(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("tabular_proposal"),
    documentKind: z.enum(DOCUMENT_KINDS),
    platform: z.enum(SETTLEMENT_PLATFORMS).nullable(),
    reason: z.string(),
    columnMapping: columnMappingSchema,
    amountSign: amountSignSchema.nullable(),
    sampleHeader: z.array(z.string()),
    sampleRows: z.array(z.array(z.string())),
    rowCount: z.number(),
    validation: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), problems: z.array(mappingProblemSchema) })]),
  }),
  z.object({ type: z.literal("tabular_rejected"), documentKind: z.enum(DOCUMENT_KINDS) }),
]) as z.ZodType<IntakeResult>;

/** Safely reads back whatever is stored in a `documents.intake_result` jsonb column - `null`
 * for `not_applicable`/never-processed documents, or when the stored value somehow no longer
 * matches this shape (never throws; a read model degrades to "nothing to show" rather than a
 * 500). */
export function parseIntakeResult(raw: unknown): IntakeResult | null {
  if (raw === null || raw === undefined) return null;
  const parsed = intakeResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function capRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length <= MAX_EMBEDDED_ROWS) return { rows, truncated: false };
  return { rows: rows.slice(0, MAX_EMBEDDED_ROWS), truncated: true };
}

export function buildBankStatementIntakeResult(input: {
  statementCount: number;
  allStatementsReconcile: boolean;
  transactions: NormalizedTransaction[];
}): BankStatementIntakeResult {
  const { rows, truncated } = capRows(input.transactions);
  // Over the FULL input, never over `rows`: capping must not move a statement's date
  // (decisions/0061-a-statement-is-dated-by-its-last-booking.md).
  const lastBookingDate = input.transactions.reduce<string | null>(
    (latest, tx) => (latest === null || tx.bookingDate > latest ? tx.bookingDate : latest),
    null,
  );
  return {
    type: "bank_statement",
    statementCount: input.statementCount,
    transactionCount: input.transactions.length,
    allStatementsReconcile: input.allStatementsReconcile,
    truncated,
    lastBookingDate,
    transactions: rows,
  };
}

export function buildTabularConfirmedIntakeResult(input: {
  documentKind: DocumentKind;
  platform: SettlementPlatform | null;
  rows: NormalizedBankTransactionFromMapping[] | NormalizedSettlementLine[];
  appStorePayout?: AppStorePayoutSummary;
}): TabularConfirmedIntakeResult {
  const truncated = input.rows.length > MAX_EMBEDDED_ROWS;
  // `capRows` is deliberately not reused here: it is generic over a single element type `T`,
  // and TypeScript cannot narrow a `T[] | U[]` union argument through a `T[]` generic
  // parameter without erasing which branch it came from - slicing directly keeps the
  // caller's own union type intact instead.
  const rows = truncated ? input.rows.slice(0, MAX_EMBEDDED_ROWS) : input.rows;
  return {
    type: "tabular_confirmed",
    documentKind: input.documentKind,
    platform: input.platform,
    rowCount: input.rows.length,
    truncated,
    rows,
    ...(input.appStorePayout ? { appStorePayout: input.appStorePayout } : {}),
  };
}
