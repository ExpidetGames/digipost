import { describe, expect, it } from "vitest";

import { closingDocumentName, closingDocumentNameSource, type ClosingNameableDocument, type ClosingNameLabels } from "../core/document-name";

const labels: ClosingNameLabels = {
  platformLabel: (platform) => ({ apple: "Apple", google: "Google", stripe: "Stripe" })[platform] ?? platform,
  bankStatementLabel: "Kontoauszug",
  receivedOnLabel: (formattedDate) => `Eingang ${formattedDate}`,
  formatDate: (isoDate) => isoDate.split("-").reverse().join("."),
  formatMonth: (isoMonth) => `Monat ${isoMonth}`,
};

function document(overrides: Partial<ClosingNameableDocument> = {}): ClosingNameableDocument {
  return {
    kind: "incoming_invoice",
    platform: null,
    direction: "incoming",
    counterpartyName: null,
    sender: null,
    originalFileName: "scan_0007.pdf",
    documentDate: null,
    reportPeriod: null,
    statementLastBooking: null,
    effectiveDate: "2026-01-14",
    ...overrides,
  };
}

describe("closingDocumentName", () => {
  it("names a letter after its counterparty and its own date", () => {
    expect(closingDocumentName(document({ counterpartyName: "Bauwerk Generalbau GmbH", documentDate: "2025-11-24" }), labels)).toBe(
      "Bauwerk Generalbau, 24.11.2025",
    );
  });

  it("names an app-store report after its platform and the month it covers (decisions/0060)", () => {
    const report = document({ kind: "payout_report", platform: "apple", reportPeriod: "2025-11", direction: null, effectiveDate: "2025-11-30" });
    expect(closingDocumentName(report, labels)).toBe("Apple, Monat 2025-11");
  });

  it("names a bank statement after its kind and its last booking (decisions/0061)", () => {
    const statement = document({ kind: "bank_statement", statementLastBooking: "2026-09-21", direction: null, effectiveDate: "2026-09-21" });
    expect(closingDocumentName(statement, labels)).toBe("Kontoauszug, 21.09.2026");
  });

  it("falls back to the extracted sender, but never for an outgoing document", () => {
    expect(closingDocumentName(document({ sender: "Stadtwerke Köln GmbH", documentDate: "2026-01-14" }), labels)).toBe("Stadtwerke Köln, 14.01.2026");
    expect(closingDocumentName(document({ sender: "Unsere Firma GmbH", direction: "outgoing", documentDate: "2026-01-14" }), labels)).toBe(
      "scan_0007, 14.01.2026",
    );
  });

  it("dates a document with no own date by when it arrived, using the shared effective date", () => {
    expect(closingDocumentName(document({ counterpartyName: "Telekom" }), labels)).toBe("Telekom, Eingang 14.01.2026");
  });
});

describe("closingDocumentNameSource", () => {
  it("is the name without its date half - what the ZIP file name is built from", () => {
    expect(closingDocumentNameSource(document({ counterpartyName: "Bauwerk Generalbau GmbH", documentDate: "2025-11-24" }), labels)).toBe(
      "Bauwerk Generalbau",
    );
    expect(closingDocumentNameSource(document({ kind: "bank_statement", statementLastBooking: "2026-09-21" }), labels)).toBe("Kontoauszug");
    expect(closingDocumentNameSource(document({ kind: "payout_report", platform: "google", reportPeriod: "2025-11" }), labels)).toBe("Google");
    expect(closingDocumentNameSource(document(), labels)).toBe("scan_0007");
  });
});
