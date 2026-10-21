// Deterministic `IntakeClassifier` (no randomness, no clock, no network) - same spirit as
// `src/modules/documents/core/fake-document-analyzer.ts`: an ordered table of rules, most
// specific first, so every unit test and this repository's fixtures classify identically on
// every run without ever touching Mistral. `AI_PROVIDER=fake` binds this in production-shaped
// code paths too (`docker/compose.test.yml` sets it explicitly).
import type {
  AmountSign,
  ColumnMapping,
  DocumentKind,
  IntakeClassification,
  IntakeClassifier,
  IntakeClassifierInput,
  SettlementPlatform,
} from "./classification";
import { parseIntakeClassification } from "./classification";
import type { TabularSample } from "./tabular-sample";

type TabularRule = {
  name: string;
  matches: (header: string[]) => boolean;
  documentKind: DocumentKind;
  platform: SettlementPlatform | null;
  reason: string;
  columnMapping: (header: string[]) => ColumnMapping;
  amountSign: (header: string[]) => AmountSign | null;
};

function has(header: string[], column: string): boolean {
  return header.includes(column);
}

/** Only includes a mapping entry when the referenced column actually exists in this sample's
 * header - a fixture that has been trimmed down for a test should not produce a mapping
 * pointing at a column that is not there. */
function mapping(header: string[], entries: ColumnMapping): ColumnMapping {
  const result: ColumnMapping = {};
  for (const [field, column] of Object.entries(entries)) {
    if (column && has(header, column)) result[field as keyof ColumnMapping] = column;
  }
  return result;
}

const TABULAR_RULES: TabularRule[] = [
  {
    name: "stripe-payout",
    matches: (header) => has(header, "balance_transaction_id") && has(header, "automatic_payout_id"),
    documentKind: "payout_report",
    platform: "stripe",
    reason: "Die Spalten balance_transaction_id und automatic_payout_id sind eindeutige Kennzeichen eines Stripe-Auszahlungsberichts.",
    columnMapping: (header) =>
      mapping(header, {
        bookingDate: "created_utc",
        valueDate: "available_on_utc",
        currency: "currency",
        gross: "gross",
        fee: "fee",
        net: "net",
        payoutId: "automatic_payout_id",
        customerEmail: "customer_email",
        customerName: "customer_name",
        invoiceNumber: "payment_metadata[invoice_number]",
        chargeId: "charge_id",
        reference: "source_id",
        description: "description",
      }),
    amountSign: (header) => (has(header, "net") ? { mode: "signed_column", column: "net" } : null),
  },
  {
    name: "apple-financial-report",
    matches: (header) => has(header, "Vendor Identifier") && has(header, "Partner Share"),
    documentKind: "platform_settlement",
    platform: "apple",
    reason: "Die Spalten Vendor Identifier und Partner Share sind typisch für einen Apple App Store Financial Report.",
    columnMapping: (header) =>
      mapping(header, {
        valueDate: "End Date",
        productName: "Title",
        quantity: "Quantity",
        countryOfSale: "Country Of Sale",
        gross: "Customer Price",
        net: "Extended Partner Share",
        currency: "Partner Share Currency",
      }),
    amountSign: (header) =>
      has(header, "Extended Partner Share") && has(header, "Sales or Return")
        ? { mode: "indicator_column", amountColumn: "Extended Partner Share", indicatorColumn: "Sales or Return", creditValue: "S", debitValue: "R" }
        : null,
  },
  {
    name: "sparkasse-bank-statement",
    matches: (header) => has(header, "Auftragskonto") && has(header, "Glaeubiger ID"),
    documentKind: "bank_statement",
    platform: null,
    reason: "Die Spalten Auftragskonto und Glaeubiger ID entsprechen dem Sparkassen-CSV-Exportformat.",
    columnMapping: (header) =>
      mapping(header, {
        bookingDate: "Buchungstag",
        valueDate: "Valutadatum",
        amount: "Betrag",
        currency: "Waehrung",
        counterpartyName: "Beguenstigter/Zahlungspflichtiger",
        counterpartyIban: "Kontonummer/IBAN",
        reference: "Verwendungszweck",
        endToEndId: "Kundenreferenz (End-to-End)",
      }),
    amountSign: (header) => (has(header, "Betrag") ? { mode: "signed_column", column: "Betrag" } : null),
  },
  {
    name: "musterbank-bank-statement",
    matches: (header) => has(header, "Buchungsdatum") && has(header, "IBAN") && has(header, "Verwendungszweck"),
    documentKind: "bank_statement",
    platform: null,
    reason: "Die Spalten Buchungsdatum, IBAN und Verwendungszweck entsprechen einem gängigen Bank-CSV-Export (z. B. Musterbank).",
    columnMapping: (header) =>
      mapping(header, {
        bookingDate: "Buchungsdatum",
        valueDate: "Wertstellung",
        amount: "Betrag",
        currency: "Währung",
        counterpartyName: "Empfänger/Auftraggeber",
        counterpartyIban: "IBAN",
        reference: "Verwendungszweck",
      }),
    amountSign: (header) => (has(header, "Betrag") ? { mode: "signed_column", column: "Betrag" } : null),
  },
];

function classifyTabular(sample: TabularSample): IntakeClassification {
  for (const rule of TABULAR_RULES) {
    if (!rule.matches(sample.header)) continue;
    const raw = {
      documentKind: rule.documentKind,
      confidence: 0.92,
      reason: rule.reason,
      platform: rule.platform,
      columnMapping: rule.columnMapping(sample.header),
      amountSign: rule.amountSign(sample.header),
    };
    return parseIntakeClassification(raw, sample.header);
  }
  return parseIntakeClassification(
    {
      documentKind: "other",
      confidence: 0.2,
      reason: "Das Tabellenformat wurde von keiner bekannten Regel erkannt.",
      platform: null,
      columnMapping: null,
      amountSign: null,
    },
    sample.header,
  );
}

type TextRule = { name: string; matches: (lowerText: string) => boolean; documentKind: DocumentKind; reason: string };

const TEXT_RULES: TextRule[] = [
  { name: "reminder", matches: (t) => t.includes("mahnung") || t.includes("zahlungserinnerung"), documentKind: "reminder", reason: "Der Text enthält den Begriff \"Mahnung\" bzw. \"Zahlungserinnerung\"." },
  { name: "outgoing-invoice", matches: (t) => t.includes("ausgangsrechnung") || t.includes("unsere rechnung"), documentKind: "outgoing_invoice", reason: "Der Text bezeichnet sich selbst als Ausgangsrechnung." },
  { name: "incoming-invoice", matches: (t) => t.includes("rechnung") || t.includes("rechnungsnummer"), documentKind: "incoming_invoice", reason: "Der Text enthält den Begriff \"Rechnung\"." },
  { name: "receipt", matches: (t) => t.includes("kassenbon") || t.includes("quittung") || t.includes("beleg"), documentKind: "receipt", reason: "Der Text enthält den Begriff \"Kassenbon\", \"Quittung\" oder \"Beleg\"." },
  { name: "contract", matches: (t) => t.includes("vertrag"), documentKind: "contract", reason: "Der Text enthält den Begriff \"Vertrag\"." },
  { name: "authority", matches: (t) => t.includes("finanzamt") || t.includes("behörde") || t.includes("amtsgericht"), documentKind: "authority_letter", reason: "Der Text nennt eine Behörde (z. B. Finanzamt, Amtsgericht)." },
];

function classifyText(text: string): IntakeClassification {
  const lowerText = text.toLowerCase();
  for (const rule of TEXT_RULES) {
    if (!rule.matches(lowerText)) continue;
    return parseIntakeClassification({ documentKind: rule.documentKind, confidence: 0.85, reason: rule.reason, platform: null, columnMapping: null, amountSign: null });
  }
  return parseIntakeClassification({
    documentKind: "letter",
    confidence: 0.4,
    reason: "Kein spezifisches Schlüsselwort erkannt; Standardannahme ist ein allgemeiner Brief.",
    platform: null,
    columnMapping: null,
    amountSign: null,
  });
}

export function createFakeIntakeClassifier(): IntakeClassifier {
  return {
    async classify(input: IntakeClassifierInput): Promise<IntakeClassification> {
      return input.kind === "tabular" ? classifyTabular(input.sample) : classifyText(input.text);
    },
  };
}
