// The two ports the processing pipeline depends on (decisions/0016-processing-pipeline-and-ai.md):
// `src/platform/mistral`'s real adapters and this module's own deterministic fakes both
// implement these interfaces, and `src/persistence/use-cases/documents-use-cases.ts`'s
// `processDocument` depends only on the interface, never on which adapter is bound (the
// composition root picks by env, WEBAPP_TEMPLATE_SPEC.md §10.2: "Drittanbieter nie direkt
// mocken, sondern hinter einem eigenen Port").
//
// Field names are camelCase; the real Mistral adapter (`src/platform/mistral`) maps the
// API's own snake_case field names into this shape - callers of this port never see a
// snake_case field.
//
// C2 (decisions/0021-extraction-direction-and-invoice-fields.md) extends `AnalysisResult`
// with `parties`/`invoice`, both produced by the SAME analyzer call as
// title/sender/documentDate/summary (never a second model call) - `DocumentAnalyzer`
// itself stays a single `analyze()` method. `ExtractedContactData`/`DocumentContactRole` come
// from `@/modules/contacts` (C1): this module imports that module's neutral entrypoint rather
// than redeclaring the same field list a second time (`modules -> modules` is an allowed
// import direction, STRUCTURE.md's `direction` rule).
import type { DocumentContactRole, ExtractedContactData } from "@/modules/contacts";
import type { DocumentKind } from "@/modules/intake";

import type { CounterpartyPlan } from "./party-roles";

/** One OCR-detected block on a page, paragraph-level, in reading order. Coordinates are in
 * the page's own pixel space (`OcrPage.dimensions`), top-left origin, matching Mistral OCR's
 * `top_left_x`/`top_left_y`/`bottom_right_x`/`bottom_right_y` (architecture brief's "Mistral
 * OCR facts"). */
export type OcrBlock = {
  type: string;
  topLeftX: number;
  topLeftY: number;
  bottomRightX: number;
  bottomRightY: number;
  content: string;
};

export type OcrPageDimensions = { width: number; height: number; dpi: number };

export type OcrPage = {
  index: number;
  /** Markdown for the whole page - the fallback source for the searchable PDF's text layer
   * when `blocks` is null/missing, and always the source for `ocrText` (joined across
   * pages). */
  markdown: string;
  /** `null` when the OCR response omitted dimensions for this page (should not happen in
   * practice, but the response is parsed leniently either way). */
  dimensions: OcrPageDimensions | null;
  /** `null` when the OCR response's `blocks` field was null/missing entirely - the
   * searchable PDF builder then falls back to distributing `markdown`'s paragraphs down the
   * page instead of positioning by block. */
  blocks: OcrBlock[] | null;
};

export type OcrResult = { pages: OcrPage[] };

export interface OcrEngine {
  /** `pdfBytes` is the original uploaded PDF; `fileName` is the original upload's file name
   * (the real Mistral adapter ignores it - only the fake adapter uses it, to deterministically
   * derive realistic German letter text from filename keywords, e.g. `rechnung-telekom.pdf`).
   * Throws on failure - the caller (the processing use case) classifies the thrown error
   * (transient vs permanent) via `instanceof`, this port itself makes no such distinction. */
  recognize(input: { pdfBytes: Uint8Array; fileName: string }): Promise<OcrResult>;
}

/** One party the analyzer found mentioned on the document - up to 3 per document (C2). `role`
 * is the model's own hint at what this party is (sender/recipient/on_behalf_of/mentioned);
 * `@/persistence/use-cases/documents-use-cases.ts`'s direction/linking logic may still
 * override it (e.g. forcing the resolved counterparty's role once `direction` is known) - see
 * decisions/0021-extraction-direction-and-invoice-fields.md. Every other field is exactly
 * `ExtractedContactData` (C1): the same shape `@/modules/contacts`'s `upsertFromExtraction`
 * takes, so a validated party can be passed straight through with no reshaping. */
export type ExtractedParty = { role: DocumentContactRole } & ExtractedContactData;

/** Invoice-shaped fields (architecture brief / C2), only meaningfully populated for an
 * invoice/reminder/receipt-like document - `null` for anything else, or when the analyzer
 * found nothing invoice-shaped. `totalAmountCents` is parsed in code from the model's raw
 * amount text (`@/modules/documents`'s `parseGermanAmountToCents`) - never the model's own
 * arithmetic (architecture brief's product decision 8). Negative for a credit note. */
export type InvoiceFields = {
  invoiceNumber: string | null;
  totalAmountCents: number | null;
  /** ISO 4217, e.g. `"EUR"` - defaults to `"EUR"` when a euro sign/word appears in the raw
   * amount text and the model gave no currency of its own. */
  currency: string | null;
  /** ISO `YYYY-MM-DD`, or `null` when absent or implausible. */
  dueDate: string | null;
  paymentIban: string | null;
  paymentReference: string | null;
  /** Free text printed on the document itself, e.g. "bezahlt per Kreditkarte" - never
   * inferred, only carried through when the source text actually says so. */
  paidNote: string | null;
};

/** The workspace's own company profile, as far as it is known, handed to the analyzer so its
 * system prompt can tell it "das sind wir" (decisions/0021-extraction-direction-and-invoice-fields.md)
 * instead of guessing which party is the workspace itself. `null` when the workspace has not
 * filled in a company profile yet (onboarding, `@/modules/workspaces`) - the analyzer still
 * runs, it simply has no "this is us" context to give the model. Deliberately not
 * `@/modules/contacts`'s `OwnCompanyProfile` (that type only carries the three fields
 * `isOwnCompany` compares on - this one carries everything worth putting in a prompt, e.g. the
 * full address). */
export type OwnCompanyContext = {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  /** Wave 1 (H-contract.md section 1, decisions/0036-guided-extraction.md): the workspace's
   * other names, own bank accounts, and own web/email domains - all already normalized
   * (`normalizeName`/`normalizeIban`, lowercased host-only) by the caller that builds this
   * context. OPTIONAL for now so `src/persistence/use-cases/documents-use-cases.ts`'s
   * `toOwnCompanyContext` keeps compiling before the `workspaces.company_aliases`/
   * `company_ibans`/`company_domains` columns exist (H1's wave-1 migration lands on a
   * different branch); wave 2 fills all three from those columns and the guided prompts
   * (`src/platform/mistral/server/prompts.ts`) start relying on them being present whenever
   * `ownCompany` itself is non-null. */
  aliases?: string[];
  ibans?: string[];
  domains?: string[];
  /** Wave 1: the free-text company description an admin may have filled in
   * (`workspaces.company_profile_text`, H1). Optional for the same compile-before-the-column-
   * exists reason as the three arrays above. Never a source of truth for `isOwnCompany` or any
   * other code-side decision (H-contract.md section 1: "Free profile text only helps the model
   * find things, it never decides anything on its own") - it only ever reaches the guided
   * prompt's system message, defensively capped at 1000 characters there
   * (`buildGuidedDerivedSystemPrompt`/`buildGuidedOpenSystemPrompt`) even though H1 already
   * validates that length on input.
   */
  profileText?: string | null;
} | null;

/** One party the guided analyzer extracted about the counterparty it was explicitly asked
 * for (`CounterpartyPlan`'s `"derived"` mode, H-contract.md section 2) - every
 * `ExtractedContactData` field, but never a `role`: the role is `CounterpartyPlan.counterpartyRole`,
 * decided in code from `documents.kind`, never asked of the model. */
export type GuidedCounterparty = ExtractedContactData;

/** The new analyzer method's result shape (H-contract.md section 2, wave 1 additive - `analyze`
 * above is untouched and still what `src/persistence/use-cases/documents-use-cases.ts` actually
 * calls until wave 2 switches `processOcrDocument` over). Every field except `counterparty`/
 * `parties`/`reminderDirection` mirrors `AnalysisResult` exactly (same title/sender/
 * documentDate/summary/invoice guarantees, via `validateGuidedAnalysisResult`,
 * `core/analysis-validation.ts`). */
export type GuidedAnalysisResult = {
  title: string | null;
  sender: string | null;
  documentDate: string | null;
  summary: string | null;
  /** Only ever populated in `"derived"` mode (`null` in `"open"`/`"none"` mode, or when the
   * model found no counterparty at all even though one was asked for). */
  counterparty: GuidedCounterparty | null;
  /** Only ever populated in `"open"` mode (always `[]` in `"derived"`/`"none"` mode) - at most
   * 2 entries (H-contract.md section 4's "open" prompt change from today's 3), each keeping its
   * own `role` hint exactly like `AnalysisResult.parties` does today. */
  parties: ExtractedParty[];
  invoice: InvoiceFields | null;
  /** Only meaningful for a `reminder` (the one kind whose `"open"` prompt asks this question,
   * H-contract.md section 5) - the model's own guess at whether the workspace received this
   * reminder or sent it itself, BEFORE `core/reminder-direction.ts`'s `resolveReminderDirection`
   * applies the payment-IBAN override that has the final say. `null` for every other kind, or
   * when the model gave no answer. */
  reminderDirection: "received" | "sent" | null;
};

export type AnalysisResult = {
  title: string | null;
  sender: string | null;
  /** ISO `YYYY-MM-DD`, or `null` when absent or implausible. */
  documentDate: string | null;
  summary: string | null;
  /** Up to 3 entries (C2) - already clamped/validated, never a raw model array. */
  parties: ExtractedParty[];
  invoice: InvoiceFields | null;
};

export interface DocumentAnalyzer {
  /** `text` is the OCR markdown (already truncated to a sane size by the caller);
   * `fileName` is the original upload's file name, used only by the fake analyzer's
   * deterministic keyword matching (the real Mistral analyzer ignores it - the document's
   * own text is what it classifies). `ownCompany` (C2) is passed through untouched into the
   * real adapter's system prompt; the fake analyzer ignores it (its fixtures are
   * self-contained). */
  analyze(input: { text: string; fileName: string; ownCompany: OwnCompanyContext }): Promise<AnalysisResult>;

  /** Wave 1 addition (H-contract.md section 2, decisions/0036-guided-extraction.md), NOT yet
   * called by `processDocument` - built additively beside `analyze` so this branch keeps
   * compiling without switching `main`'s pipeline behaviour over (wave 2 does that). `kind` is
   * `documents.kind` as already classified BEFORE this call (the whole point of guided
   * extraction: classify first, then ask one narrow, kind-specific question) and `plan` is
   * `planCounterparty(kind)`'s result (`./party-roles.ts`) - passed in rather than recomputed
   * here so the port itself never needs to import the classifier. `fileName` is accepted for
   * symmetry with `analyze` (the fake adapter's deterministic keyword matching uses it); the
   * real adapter ignores it exactly like `analyze` does. */
  analyzeGuided(input: {
    text: string;
    fileName: string;
    ownCompany: OwnCompanyContext;
    kind: DocumentKind;
    plan: CounterpartyPlan;
  }): Promise<GuidedAnalysisResult>;
}
