// Shared validation for a `DocumentAnalyzer`'s raw output (architecture brief's product
// decision 8, requirement 5 of decisions/0016-processing-pipeline-and-ai.md,
// decisions/0021-extraction-direction-and-invoice-fields.md for `parties`/`invoice`): both the
// real Mistral adapter (`src/platform/mistral/server/mistral-analyzer.ts`, after parsing the
// chat completion's JSON content) and this module's own deterministic fake
// (`core/fake-document-analyzer.ts`) call this so every `AnalysisResult` this application
// ever sees, regardless of provider, obeys the exact same guarantees - all LLM output is
// untrusted (architecture brief's product decision 8).
import { z } from "zod";

import { DOCUMENT_CONTACT_ROLES, type DocumentContactRole, type ExtractedContactData } from "@/modules/contacts";

import { inferCurrency, parseGermanAmountToCents } from "./amount-parsing";
import type { CounterpartyPlan } from "./party-roles";
import type { AnalysisResult, ExtractedParty, GuidedAnalysisResult, InvoiceFields } from "./ports";

const TITLE_MAX_LENGTH = 120;
const SUMMARY_MAX_LENGTH = 300;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Field length caps for a per-party extraction - the same caps
 * `@/modules/contacts`'s `manualContactCreateSchema` enforces for a human-entered contact
 * (`src/modules/contacts/core/schemas.ts`), reused here so an over-long model value is
 * truncated rather than rejected (extraction must never fail on a malformed field). */
const PARTY_FIELD_MAX_LENGTHS = {
  name: 200,
  legalForm: 60,
  addressLine1: 200,
  addressLine2: 200,
  postalCode: 20,
  city: 120,
  country: 2,
  vatId: 20,
  taxNumber: 30,
  registerCourt: 120,
  registerNumber: 30,
  leitwegId: 60,
  iban: 34,
  bic: 11,
  bankName: 120,
  accountHolder: 200,
  sepaCreditorId: 35,
  phone: 40,
  email: 320,
  website: 200,
  contactPerson: 120,
  customerNumber: 60,
  supplierNumber: 60,
  notes: 2000,
} as const;

const MAX_PARTIES = 3;

/** The guided `"open"` prompt's own cap (H-contract.md section 4: "höchstens 2", down from
 * today's 3) - a separate constant rather than reusing `MAX_PARTIES` so a future change to
 * either cap cannot silently change the other. */
export const MAX_GUIDED_PARTIES = 2;

/** Lenient shape: every field is optional/nullable/any-string, since this is exactly the
 * boundary where an LLM's (or an attacker's prompt-injected) JSON first meets a schema - the
 * point of this file is to never let a malformed or hostile field crash processing, only
 * fall back to a safe default. */
const rawAnalysisSchema = z.object({
  title: z.unknown().optional(),
  sender: z.unknown().optional(),
  documentDate: z.unknown().optional(),
  summary: z.unknown().optional(),
  parties: z.unknown().optional(),
  invoice: z.unknown().optional(),
});

function isPlausibleIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toTruncatedStringOrNull(value: unknown, maxLength: number): string | null {
  const str = toStringOrNull(value);
  if (!str) return null;
  return str.length > maxLength ? str.slice(0, maxLength) : str;
}

function toClampedOrNull(value: unknown, maxLength: number): string | null {
  return toTruncatedStringOrNull(value, maxLength);
}

/** One raw party/counterparty object -> a validated `ExtractedContactData`, or `null` when it
 * has no usable `name` at all (a party with no name is not a party - mirrors
 * `upsertFromExtraction`'s own `invalid_input` rule for a blank name, but here "invalid" just
 * means "drop this entry" rather than failing the whole extraction). Every field-mapping rule
 * `toExtractedParty` and the guided analyzer's `counterparty` field share (H-contract.md
 * section 2's `GuidedCounterparty`, `./ports.ts`) lives here exactly once. */
function toExtractedContactFields(raw: unknown): ExtractedContactData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const name = toClampedOrNull(record.name, PARTY_FIELD_MAX_LENGTHS.name);
  if (!name) return null;

  const countryRaw = toClampedOrNull(record.country, PARTY_FIELD_MAX_LENGTHS.country);
  const paymentTermsCandidate = record.paymentTermsDays;
  const paymentTermsDays =
    typeof paymentTermsCandidate === "number" && Number.isFinite(paymentTermsCandidate) && paymentTermsCandidate >= 0
      ? Math.round(paymentTermsCandidate)
      : null;

  return {
    name,
    legalForm: toClampedOrNull(record.legalForm, PARTY_FIELD_MAX_LENGTHS.legalForm),
    addressLine1: toClampedOrNull(record.addressLine1, PARTY_FIELD_MAX_LENGTHS.addressLine1),
    addressLine2: toClampedOrNull(record.addressLine2, PARTY_FIELD_MAX_LENGTHS.addressLine2),
    postalCode: toClampedOrNull(record.postalCode, PARTY_FIELD_MAX_LENGTHS.postalCode),
    city: toClampedOrNull(record.city, PARTY_FIELD_MAX_LENGTHS.city),
    country: countryRaw ? countryRaw.toUpperCase() : null,
    vatId: toClampedOrNull(record.vatId, PARTY_FIELD_MAX_LENGTHS.vatId),
    taxNumber: toClampedOrNull(record.taxNumber, PARTY_FIELD_MAX_LENGTHS.taxNumber),
    registerCourt: toClampedOrNull(record.registerCourt, PARTY_FIELD_MAX_LENGTHS.registerCourt),
    registerNumber: toClampedOrNull(record.registerNumber, PARTY_FIELD_MAX_LENGTHS.registerNumber),
    leitwegId: toClampedOrNull(record.leitwegId, PARTY_FIELD_MAX_LENGTHS.leitwegId),
    // `iban`/`vatId` are kept as extracted text even when malformed (never rejected here) -
    // decisions/0019-contacts.md's "Manual input validation vs. extraction leniency":
    // `@/modules/contacts`'s `checkContactFormats` exists precisely so a future UI can flag a
    // malformed value non-blockingly, without this extraction path ever failing on it.
    iban: toClampedOrNull(record.iban, PARTY_FIELD_MAX_LENGTHS.iban),
    bic: toClampedOrNull(record.bic, PARTY_FIELD_MAX_LENGTHS.bic),
    bankName: toClampedOrNull(record.bankName, PARTY_FIELD_MAX_LENGTHS.bankName),
    accountHolder: toClampedOrNull(record.accountHolder, PARTY_FIELD_MAX_LENGTHS.accountHolder),
    sepaCreditorId: toClampedOrNull(record.sepaCreditorId, PARTY_FIELD_MAX_LENGTHS.sepaCreditorId),
    phone: toClampedOrNull(record.phone, PARTY_FIELD_MAX_LENGTHS.phone),
    email: toClampedOrNull(record.email, PARTY_FIELD_MAX_LENGTHS.email),
    website: toClampedOrNull(record.website, PARTY_FIELD_MAX_LENGTHS.website),
    contactPerson: toClampedOrNull(record.contactPerson, PARTY_FIELD_MAX_LENGTHS.contactPerson),
    customerNumber: toClampedOrNull(record.customerNumber, PARTY_FIELD_MAX_LENGTHS.customerNumber),
    supplierNumber: toClampedOrNull(record.supplierNumber, PARTY_FIELD_MAX_LENGTHS.supplierNumber),
    paymentTermsDays,
    notes: null,
  };
}

/** `role` falls back to `"mentioned"` for anything that is not one of `DOCUMENT_CONTACT_ROLES`
 * - the least consequential role a mislabeled party could get (never auto-treated as the
 * direction-deciding sender/recipient). */
function toExtractedParty(raw: unknown): ExtractedParty | null {
  const fields = toExtractedContactFields(raw);
  if (!fields) return null;

  const record = raw as Record<string, unknown>;
  const roleCandidate = typeof record.role === "string" ? record.role : "";
  const role: DocumentContactRole = (DOCUMENT_CONTACT_ROLES as readonly string[]).includes(roleCandidate)
    ? (roleCandidate as DocumentContactRole)
    : "mentioned";

  return { role, ...fields };
}

function toExtractedPartiesList(raw: unknown, max: number): ExtractedParty[] {
  if (!Array.isArray(raw)) return [];
  const parties: ExtractedParty[] = [];
  for (const entry of raw) {
    const party = toExtractedParty(entry);
    if (party) parties.push(party);
    if (parties.length >= max) break;
  }
  return parties;
}

function toExtractedParties(raw: unknown): ExtractedParty[] {
  return toExtractedPartiesList(raw, MAX_PARTIES);
}

/** `null` when every field would end up `null` (no invoice-shaped data at all) - a document
 * that is not an invoice/reminder/receipt is expected to produce exactly this. */
function toInvoiceFields(raw: unknown): InvoiceFields | null {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const rawAmountText = typeof record.totalAmount === "string" ? record.totalAmount : null;
  const dueDateCandidate = toStringOrNull(record.dueDate);

  const invoice: InvoiceFields = {
    invoiceNumber: toClampedOrNull(record.invoiceNumber, 60),
    totalAmountCents: parseGermanAmountToCents(rawAmountText),
    currency: inferCurrency(rawAmountText, record.currency),
    dueDate: dueDateCandidate && isPlausibleIsoDate(dueDateCandidate) ? dueDateCandidate : null,
    paymentIban: toClampedOrNull(record.paymentIban, 34),
    paymentReference: toClampedOrNull(record.paymentReference, 140),
    paidNote: toClampedOrNull(record.paidNote, 200),
  };

  const hasAnyValue = Object.values(invoice).some((value) => value !== null);
  return hasAnyValue ? invoice : null;
}

/**
 * Never throws: an input that fails `rawAnalysisSchema.safeParse` (not even an object) is
 * treated the same as an object with every field missing - every field `null`. This is
 * deliberate: a malformed or adversarial model response degrades to "no extracted fields",
 * never a processing failure.
 */
export function validateAnalysisResult(raw: unknown): AnalysisResult {
  const parsed = rawAnalysisSchema.safeParse(raw);
  const fields = parsed.success ? parsed.data : {};

  const dateCandidate = toStringOrNull(fields.documentDate);
  const documentDate = dateCandidate && isPlausibleIsoDate(dateCandidate) ? dateCandidate : null;

  return {
    title: toTruncatedStringOrNull(fields.title, TITLE_MAX_LENGTH),
    sender: toTruncatedStringOrNull(fields.sender, TITLE_MAX_LENGTH),
    documentDate,
    summary: toTruncatedStringOrNull(fields.summary, SUMMARY_MAX_LENGTH),
    parties: toExtractedParties(fields.parties),
    invoice: toInvoiceFields(fields.invoice),
  };
}

/** Same lenient-boundary shape as `rawAnalysisSchema` above, extended with the guided
 * analyzer's own three fields (H-contract.md section 2/5) - every field optional/unknown for
 * the exact same reason: this is where an LLM's (or an attacker's prompt-injected) JSON first
 * meets a schema. */
const rawGuidedAnalysisSchema = z.object({
  title: z.unknown().optional(),
  sender: z.unknown().optional(),
  documentDate: z.unknown().optional(),
  summary: z.unknown().optional(),
  counterparty: z.unknown().optional(),
  parties: z.unknown().optional(),
  invoice: z.unknown().optional(),
  reminderDirection: z.unknown().optional(),
});

/** `"received"`/`"sent"` only - anything else (missing, wrong type, a hallucinated third
 * value) becomes `null`, exactly like every other guided field's lenient degradation. Fed into
 * `core/reminder-direction.ts`'s `resolveReminderDirection` as `modelDirection`, never used to
 * decide anything by itself. */
function toReminderDirectionAnswer(value: unknown): "received" | "sent" | null {
  return value === "received" || value === "sent" ? value : null;
}

/**
 * `analyzeGuided`'s own validator (H-contract.md section 2, decisions/0036-guided-extraction.md) -
 * the same "never throws, degrades to safe defaults" guarantee `validateAnalysisResult` gives
 * every caller, called by both the real Mistral adapter (`src/platform/mistral/server/mistral-analyzer.ts`)
 * and the fake analyzer (`./fake-document-analyzer.ts`).
 *
 * `plan` (`CounterpartyPlan`, `./party-roles.ts`) decides which of `counterparty`/`parties` the
 * raw answer is even allowed to populate - the analyzer method's OWN mode, never the model's
 * own JSON shape, is authoritative: a `"derived"`-mode answer's `parties` array is ignored even
 * if the model sent one anyway (and vice versa for a `"open"`/`"none"`-mode answer's
 * `counterparty`), and `reminderDirection` is only ever read in `"open"` mode (the only mode
 * whose prompt ever asks for it, H-contract.md section 5). `parties` is capped at
 * `MAX_GUIDED_PARTIES` (2), tighter than `validateAnalysisResult`'s `MAX_PARTIES` (3,
 * H-contract.md section 4).
 */
export function validateGuidedAnalysisResult(raw: unknown, plan: CounterpartyPlan): GuidedAnalysisResult {
  const parsed = rawGuidedAnalysisSchema.safeParse(raw);
  const fields = parsed.success ? parsed.data : {};

  const dateCandidate = toStringOrNull(fields.documentDate);
  const documentDate = dateCandidate && isPlausibleIsoDate(dateCandidate) ? dateCandidate : null;

  const counterparty = plan.mode === "derived" ? toExtractedContactFields(fields.counterparty) : null;
  const parties = plan.mode === "open" ? toExtractedPartiesList(fields.parties, MAX_GUIDED_PARTIES) : [];
  const reminderDirection = plan.mode === "open" ? toReminderDirectionAnswer(fields.reminderDirection) : null;

  return {
    title: toTruncatedStringOrNull(fields.title, TITLE_MAX_LENGTH),
    sender: toTruncatedStringOrNull(fields.sender, TITLE_MAX_LENGTH),
    documentDate,
    summary: toTruncatedStringOrNull(fields.summary, SUMMARY_MAX_LENGTH),
    counterparty,
    parties,
    invoice: toInvoiceFields(fields.invoice),
    reminderDirection,
  };
}
