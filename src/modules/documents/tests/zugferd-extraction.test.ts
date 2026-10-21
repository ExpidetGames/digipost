// Best-effort ZUGFeRD/Factur-X CII invoice field extraction (decisions/0020-universal-intake.md,
// decisions/0022-intake-wiring.md). No fixture file exists for this (F1a's own fixtures are
// camt.053/CSV/TSV only), so this test builds a minimal synthetic CII document directly -
// enough structure to exercise every field this reader knows how to extract.
import { describe, expect, it } from "vitest";

import { extractZugferdInvoiceFields } from "../core/zugferd-extraction";

const MINIMAL_CII_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>4711</ram:ID>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Telekom Deutschland GmbH</ram:Name>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Muster GmbH</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>DE89370400440532013000</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20260415</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:GrandTotalAmount>83.68</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

describe("extractZugferdInvoiceFields", () => {
  it("extracts invoice number, amount, currency, due date, IBAN, and both party names", () => {
    const result = extractZugferdInvoiceFields(MINIMAL_CII_INVOICE);
    expect(result).toEqual({
      invoiceNumber: "4711",
      totalAmountCents: 8368,
      currency: "EUR",
      dueDate: "2026-04-15",
      paymentIban: "DE89370400440532013000",
      sellerName: "Telekom Deutschland GmbH",
      buyerName: "Muster GmbH",
    });
  });

  it("returns null for a document with no recognizable CII root", () => {
    expect(extractZugferdInvoiceFields("<Document><Foo>bar</Foo></Document>")).toBeNull();
  });

  it("returns null (never throws) for a malformed-but-not-malicious XML", () => {
    expect(extractZugferdInvoiceFields("<rsm:CrossIndustryInvoice><unterminated")).toBeNull();
  });

  it("throws UnsafeXmlError for a DOCTYPE-declaring attachment (XXE protection, never silently parsed)", () => {
    const malicious = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rsm:CrossIndustryInvoice>&xxe;</rsm:CrossIndustryInvoice>`;
    expect(() => extractZugferdInvoiceFields(malicious)).toThrow();
  });

  it("returns null when the document has a CII root but none of the known fields", () => {
    const empty = `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"></rsm:CrossIndustryInvoice>`;
    expect(extractZugferdInvoiceFields(empty)).toBeNull();
  });
});
