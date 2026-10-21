// decisions/0059-generated-document-names.md
import { describe, expect, it } from "vitest";

import { shortenCompanyName } from "@/modules/contacts";

import { documentDisplayName, documentNameSource, type DocumentNameParts } from "../core/display-name";

function parts(overrides: Partial<DocumentNameParts> = {}): DocumentNameParts {
  return {
    typeLabel: null,
    counterpartyName: null,
    sender: null,
    direction: "incoming",
    originalFileName: "scan_0007.pdf",
    formattedDate: "24.11.2025",
    ...overrides,
  };
}

describe("shortenCompanyName", () => {
  it("drops the legal form without knowing what one is", () => {
    expect(shortenCompanyName("Bauwerk Generalbau GmbH")).toBe("Bauwerk Generalbau");
    expect(shortenCompanyName("Muster GmbH & Co. KG")).toBe("Muster");
    expect(shortenCompanyName("Beispiel e.K.")).toBe("Beispiel");
  });

  it("drops a non-German legal form too, and the separator it leaves behind", () => {
    expect(shortenCompanyName("Automattic Inc")).toBe("Automattic");
    expect(shortenCompanyName("Notion Labs, Inc.")).toBe("Notion Labs");
    expect(shortenCompanyName("IONOS SE")).toBe("IONOS");
    expect(shortenCompanyName("Express Technologies Ltd")).toBe("Express Technologies");
  });

  it("keeps a name that carries no legal form at all", () => {
    expect(shortenCompanyName("Notion Labs")).toBe("Notion Labs");
    expect(shortenCompanyName("Bauwerk Bau")).toBe("Bauwerk Bau");
  });

  it("cuts an over-long name at a word boundary", () => {
    expect(shortenCompanyName("Bauwerk Generalbau München GmbH")).toBe("Bauwerk Generalbau");
    // 22 characters exactly, so nothing is cut.
    expect(shortenCompanyName("Telekom Deutschland AG")).toBe("Telekom Deutschland");
  });

  it("never returns an empty name, even for a bare legal form", () => {
    expect(shortenCompanyName("GmbH")).toBe("GmbH");
    expect(shortenCompanyName("   ")).toBe("");
  });

  it("cuts a single over-long word rather than returning nothing", () => {
    // No space to cut at, so it is a hard cut at exactly `SHORT_COMPANY_NAME_MAX_LENGTH`.
    expect(shortenCompanyName("Donaudampfschiffahrtsgesellschaft")).toBe("Donaudampfschiffahrtsg");
  });
});

describe("documentNameSource", () => {
  it("prefers the linked counterparty", () => {
    expect(documentNameSource(parts({ counterpartyName: "Bauwerk Generalbau GmbH", sender: "musterfirma" }))).toBe("Bauwerk Generalbau");
  });

  it("falls back to the extracted sender for an incoming document", () => {
    expect(documentNameSource(parts({ sender: "IONOS SE" }))).toBe("IONOS");
  });

  // Observed: for every outgoing invoice `sender` held "musterfirma", the
  // workspace's OWN company, while the linked contact held the customer.
  it("never falls back to the sender for an outgoing document, where the sender is us", () => {
    expect(documentNameSource(parts({ direction: "outgoing", sender: "musterfirma", originalFileName: "Rn_42_Bauwerk.pdf" }))).toBe("Rn_42_Bauwerk");
  });

  it("falls back to the file name without its extension", () => {
    expect(documentNameSource(parts({ originalFileName: "financial_report (5).csv" }))).toBe("financial_report (5)");
  });

  it("keeps a dot that is not a file extension", () => {
    expect(documentNameSource(parts({ originalFileName: "Rechnung 2025.11.24" }))).toBe("Rechnung 2025.11");
  });

  it("keeps the file name when stripping the extension would leave nothing", () => {
    expect(documentNameSource(parts({ originalFileName: ".pdf" }))).toBe(".pdf");
  });
});

// decisions/0060-app-store-reports-are-named-by-their-period.md
describe("a document named by its own type", () => {
  it("is named after the platform and its period, not its file name", () => {
    expect(
      documentDisplayName(parts({ typeLabel: "Apple", originalFileName: "financial_report (5).csv", formattedDate: "November 2025" })),
    ).toBe("Apple, November 2025");
  });

  it("outranks a counterparty, which a report never has anyway", () => {
    expect(documentNameSource(parts({ typeLabel: "Google", counterpartyName: "Google Ireland Ltd" }))).toBe("Google");
  });

  // decisions/0061-a-statement-is-dated-by-its-last-booking.md
  it("names a bank statement after its kind and its last booking", () => {
    expect(
      documentDisplayName(parts({ typeLabel: "Kontoauszug", originalFileName: "Musterbank_statement_21092026.xml", formattedDate: "21.09.2026" })),
    ).toBe("Kontoauszug, 21.09.2026");
  });

  it("falls back to the file name when the period could not be read", () => {
    // The caller passes no platform label at all in that case, so nothing claims a period
    // the document does not have.
    expect(documentNameSource(parts({ typeLabel: null, originalFileName: "financial_report (5).csv" }))).toBe("financial_report (5)");
  });
});

describe("documentDisplayName", () => {
  it("is the counterparty and the date", () => {
    expect(documentDisplayName(parts({ counterpartyName: "Bauwerk Generalbau GmbH" }))).toBe("Bauwerk Generalbau, 24.11.2025");
  });

  it("carries whatever prefix the caller put on the date", () => {
    expect(documentDisplayName(parts({ originalFileName: "financial_report.csv", formattedDate: "Eingang 23.09.2026" }))).toBe(
      "financial_report, Eingang 23.09.2026",
    );
  });

  it("is just the name when there is no date at all", () => {
    expect(documentDisplayName(parts({ counterpartyName: "IONOS SE", formattedDate: "" }))).toBe("IONOS");
  });
});
