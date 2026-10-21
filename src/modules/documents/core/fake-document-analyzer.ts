// The deterministic fake `DocumentAnalyzer` (decisions/0016-processing-pipeline-and-ai.md,
// decisions/0021-extraction-direction-and-invoice-fields.md for `parties`/`invoice`): a plain
// keyword classifier over the OCR text (and the file name), no network, no randomness. Bound
// alongside `core/fake-ocr-engine.ts` whenever the fake AI provider is active. Runs its
// output through `validateAnalysisResult` exactly like the real Mistral adapter does, so both
// providers give every caller the identical guarantees.
//
// decisions/0036-guided-extraction.md adds `analyzeGuided` beside `analyze` (wired into
// `processOcrDocument` since wave 2): it reuses `analyze`'s own keyword-based extraction
// (`buildRawAnalysis` below) and reshapes the ALREADY-VALIDATED result per `CounterpartyPlan`
// mode - `"derived"` picks out the single party matching `plan.counterpartyRole` as
// `counterparty` (dropping its `role`, exactly like the real adapter's prompt never asks for
// one), `"open"`/`"none"` keep/drop the `parties` array, and a `reminder`'s `reminderDirection`
// is guessed from whether the extracted payment IBAN is one of the caller's own. Built directly
// from `base`'s already-typed fields (`AnalysisResult`, e.g. `invoice.totalAmountCents: number`)
// rather than routed back through `validateGuidedAnalysisResult`'s RAW-model-JSON parsing (which
// expects an untyped `invoice.totalAmount: string` field and would silently null out an
// already-parsed `totalAmountCents` it does not recognize) - that validator's job is the real
// adapter's own raw-JSON boundary, already done once for the fake by `validateAnalysisResult`.
import { normalizeIban, type ExtractedContactData } from "@/modules/contacts";

import { MAX_GUIDED_PARTIES, validateAnalysisResult } from "./analysis-validation";
import type { AnalysisResult, DocumentAnalyzer, ExtractedParty, GuidedAnalysisResult, OwnCompanyContext } from "./ports";

/** Builds one `ExtractedParty` with every field defaulted to `null` except `role`/`name` and
 * whatever `overrides` supplies - avoids repeating all 24 `ExtractedContactData` fields twice
 * for the two fixture shapes below (an incoming letter's single sender, an outgoing letter's
 * sender+recipient pair). */
function blankParty(overrides: Pick<ExtractedParty, "role" | "name"> & Partial<ExtractedParty>): ExtractedParty {
  return {
    legalForm: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    country: null,
    vatId: null,
    taxNumber: null,
    registerCourt: null,
    registerNumber: null,
    leitwegId: null,
    iban: null,
    bic: null,
    bankName: null,
    accountHolder: null,
    sepaCreditorId: null,
    phone: null,
    email: null,
    website: null,
    contactPerson: null,
    customerNumber: null,
    supplierNumber: null,
    paymentTermsDays: null,
    notes: null,
    ...overrides,
  };
}

/** The fake letters' own deterministic keyword -> fixture shape mapping. `id` is purely
 * internal to this file (it used to double as the now-removed document category) - it only
 * drives which fixture shape (`label` for the summary sentence, whether invoice fields get
 * filled in via `INVOICE_LIKE_FIXTURE_IDS`) a keyword match produces. */
type FixtureRuleId = "invoice" | "reminder" | "tax" | "authority" | "contract" | "insurance" | "bank" | "personnel" | "advertising" | "other";

const FIXTURE_RULES: Array<{ keywords: string[]; id: FixtureRuleId; label: string }> = [
  { keywords: ["rechnung", "invoice"], id: "invoice", label: "Rechnung" },
  { keywords: ["mahnung", "erinnerung", "reminder"], id: "reminder", label: "Zahlungserinnerung" },
  { keywords: ["finanzamt", "steuer", "tax"], id: "tax", label: "Steuerbescheid" },
  { keywords: ["amt", "behoerde", "gericht", "authority"], id: "authority", label: "Behördliches Schreiben" },
  { keywords: ["vertrag", "contract"], id: "contract", label: "Vertrag" },
  { keywords: ["versicherung", "insurance"], id: "insurance", label: "Versicherungsschreiben" },
  { keywords: ["bank", "sparkasse", "konto"], id: "bank", label: "Bankschreiben" },
  { keywords: ["lohn", "personal", "gehalt"], id: "personnel", label: "Personalschreiben" },
  { keywords: ["werbung", "advertising", "flyer"], id: "advertising", label: "Werbeschreiben" },
];

/** German `DD.MM.YYYY` (the fake OCR letters' own date format) -> ISO `YYYY-MM-DD`. */
function extractGermanDate(text: string): string | null {
  const match = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

/** The first capture group of `pattern` against `text`, trimmed - `null` if `pattern` does
 * not match. Used to pull the "USt-IdNr.: ...", "IBAN: ...", "Rechnungsnummer ..." etc. labels
 * `core/fake-ocr-engine.ts`'s invoice-shaped fixtures print, the exact same way a real OCR'd
 * letter's labelled fields would be read off the page by the real analyzer. */
function extractLabeled(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

const INVOICE_LIKE_FIXTURE_IDS: readonly FixtureRuleId[] = ["invoice", "reminder"];

/** The raw (pre-`validateAnalysisResult`) shape both `analyze` and `analyzeGuided` build from -
 * extracted here once so `analyzeGuided` can reshape the SAME keyword-driven extraction per
 * `CounterpartyPlan` mode instead of re-deriving it independently (and risking the two methods
 * disagreeing on a fixture). */
function buildRawAnalysis(text: string, fileName: string, ownCompany: OwnCompanyContext) {
  const haystack = `${fileName} ${text}`.toLowerCase();
  const rule = FIXTURE_RULES.find((r) => r.keywords.some((keyword) => haystack.includes(keyword)));

  // No recognized keyword at all: there is no real signal to extract a title/sender from
  // (the fake OCR's own fallback letter is explicitly a placeholder, "Kein Stichwort im
  // Dateinamen erkannt.") - every field null, same as a genuinely unrecognizable document
  // would get from the real analyzer.
  if (!rule) {
    return { title: null, sender: null, documentDate: null, summary: null, parties: [] as ExtractedParty[], invoice: null };
  }

  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sender = lines[0] ?? null;
  const title = lines[1] ?? sender;
  const documentDate = extractGermanDate(text);
  const summary = sender ? `${rule.label} von ${sender}.` : `${rule.label}.`;

  const vatId = extractLabeled(text, /USt-IdNr\.?:\s*([A-Z0-9]+)/i);
  // Value group uses a literal space, not `\s` (which also matches the newline between this
  // fixture's lines) - otherwise a greedy match absorbs the start of the next labelled line
  // too (P6-style regression this test file's own case caught).
  const iban = extractLabeled(text, /IBAN:\s*([A-Z0-9 ]+)/i)?.replace(/\s+/g, "") ?? null;
  const invoiceNumber = extractLabeled(text, /Rechnungsnummer\s+(\S+)/i);
  const totalAmount = extractLabeled(text, /(?:Rechnungsbetrag|Offener Betrag):\s*([\d.,]+\s*EUR)/i);
  const dueDateGerman = extractLabeled(text, /(?:Fälligkeitsdatum|Zahlungsziel):\s*(\d{2}\.\d{2}\.\d{4})/i);
  const dueDate = dueDateGerman ? extractGermanDate(dueDateGerman) : null;

  // "ausgangsrechnung" (`core/fake-ocr-engine.ts`'s own outgoing fixture): the sender party
  // is built from the CALLER's own company profile, not from this letter's text -
  // deterministically exercises the "we are the sender" direction (C2,
  // decisions/0021-extraction-direction-and-invoice-fields.md) without a second real OCR
  // fixture per workspace. Falls back to the ordinary incoming shape when no company profile
  // has been filled in yet (onboarding not completed).
  const isOutgoingFixture = haystack.includes("ausgangsrechnung") && ownCompany !== null;

  let parties: ExtractedParty[] = [];
  if (isOutgoingFixture) {
    parties = [
      blankParty({
        role: "sender",
        name: ownCompany.name,
        addressLine1: ownCompany.addressLine1,
        addressLine2: ownCompany.addressLine2,
        postalCode: ownCompany.postalCode,
        city: ownCompany.city,
        country: ownCompany.country,
        vatId: ownCompany.vatId,
      }),
      blankParty({ role: "recipient", name: sender ?? "Unbekannter Kunde" }),
    ];
  } else if (sender) {
    parties = [blankParty({ role: "sender", name: sender, vatId, iban })];
  }

  const invoice = INVOICE_LIKE_FIXTURE_IDS.includes(rule.id)
    ? {
        invoiceNumber,
        totalAmount,
        currency: null,
        dueDate,
        paymentIban: iban,
        paymentReference: invoiceNumber,
        paidNote: /\bbezahlt\b/i.test(text) ? "Bereits bezahlt" : null,
      }
    : null;

  return { title, sender, documentDate, summary, parties, invoice };
}

/** `{ role, ...rest }` - the only way to drop `ExtractedParty.role` down to plain
 * `ExtractedContactData` without duplicating its 24-field list a second time. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to exclude it from `rest`
function stripRole({ role: _role, ...rest }: ExtractedParty): ExtractedContactData {
  return rest;
}

/** Deterministic stand-in for the model's own `reminderDirection` guess (H-contract.md
 * section 5): an extracted payment IBAN that normalizes to one of `ownCompany.ibans` reads as
 * "we sent this reminder ourselves" (`"sent"`), any other extracted IBAN as "someone sent it to
 * us" (`"received"`), and no IBAN at all as "cannot tell" (`null`) - exactly the same signal
 * `core/reminder-direction.ts`'s `resolveReminderDirection` later re-derives independently in
 * code (the fake analyzer is only simulating what a real model might guess; the code-side
 * override still has the final say once wave 2 wires this up).
 */
function guessReminderDirection(paymentIban: string | null, ownCompany: OwnCompanyContext): "received" | "sent" | null {
  if (!paymentIban) return null;
  const ownIbans = ownCompany?.ibans ?? [];
  const normalizedPaymentIban = normalizeIban(paymentIban);
  const isOwn = ownIbans.some((ownIban) => normalizeIban(ownIban) === normalizedPaymentIban);
  return isOwn ? "sent" : "received";
}

export function createFakeDocumentAnalyzer(): DocumentAnalyzer {
  return {
    async analyze({ text, fileName, ownCompany }): Promise<AnalysisResult> {
      return validateAnalysisResult(buildRawAnalysis(text, fileName, ownCompany));
    },

    // Wave 1 of decisions/0036-guided-extraction.md (H-contract.md section 2), NOT yet called
    // by `processDocument` - reshapes `analyze`'s own keyword-driven extraction per
    // `CounterpartyPlan` mode rather than re-deriving it independently.
    async analyzeGuided({ text, fileName, ownCompany, kind, plan }): Promise<GuidedAnalysisResult> {
      const base = validateAnalysisResult(buildRawAnalysis(text, fileName, ownCompany));

      const counterpartyParty =
        plan.mode === "derived" ? (base.parties.find((party) => party.role === plan.counterpartyRole) ?? null) : null;
      const parties = plan.mode === "open" ? base.parties.slice(0, MAX_GUIDED_PARTIES) : [];
      const reminderDirection = plan.mode === "open" && kind === "reminder" ? guessReminderDirection(base.invoice?.paymentIban ?? null, ownCompany) : null;

      // Built directly from `base`'s already-typed/clamped fields - see this file's header
      // comment for why this must NOT go back through `validateGuidedAnalysisResult`'s raw-JSON
      // parsing (it would silently null out `invoice.totalAmountCents`, which is already a
      // number here, not the raw printed-amount string that parser looks for).
      return {
        title: base.title,
        sender: base.sender,
        documentDate: base.documentDate,
        summary: base.summary,
        counterparty: counterpartyParty ? stripRole(counterpartyParty) : null,
        parties,
        invoice: base.invoice,
        reminderDirection,
      };
    },
  };
}
