import { describe, expect, it } from "vitest";

import {
  counterpartyNameSimilarity,
  documentNamesStatementReference,
  extractInvoiceReferences,
  extractStatementReferences,
  findCustomerNumbers,
  findInvoiceNumbers,
  hasContradictingInvoiceReference,
} from "../core/text-signals";

describe("findInvoiceNumbers", () => {
  const tolerantVariants = ["RE-2026-00002", "RE 2026 00002", "RE202600002", "re-2026-00002"];

  it.each(tolerantVariants)("finds candidate 'RE-2026-00002' in remittance text spelled as %s", (variant) => {
    expect(findInvoiceNumbers(`Zahlung fuer ${variant}, vielen Dank`, ["RE-2026-00002"])).toEqual(["RE-2026-00002"]);
  });

  it("tolerates prefix noise before and after the invoice number", () => {
    expect(findInvoiceNumbers("Rechnungsnummer: RE-2026-00002 - Zahlung erfolgt am 01.09.", ["RE-2026-00002"])).toEqual(["RE-2026-00002"]);
  });

  it("returns no match when the remittance text is null", () => {
    expect(findInvoiceNumbers(null, ["RE-2026-00002"])).toEqual([]);
  });

  it("returns no match when the remittance text is empty", () => {
    expect(findInvoiceNumbers("", ["RE-2026-00002"])).toEqual([]);
  });

  it("returns no match when the invoice number is not present", () => {
    expect(findInvoiceNumbers("Zahlung fuer RE-2026-99999", ["RE-2026-00002"])).toEqual([]);
  });

  // decisions/0031-direction-from-kind-and-short-invoice-numbers.md: this used to be a
  // digit-only candidate ("12") deliberately chosen to also demonstrate the generic
  // `MIN_TOKEN_LENGTH` floor - but "Rechnung 12" is now EXACTLY the keyword-adjacency shape
  // the same decision's short-invoice-number exception is meant to find (see "digit-only
  // candidates (R1 fix)" -> "keyword exception" below), so it no longer proves this floor in
  // isolation. Switched to a short ALPHANUMERIC candidate, which the keyword exception never
  // applies to.
  it("skips an alphanumeric candidate that normalizes to fewer than 4 characters", () => {
    expect(findInvoiceNumbers("Vorgang AB1 abgeschlossen", ["AB1"])).toEqual([]);
  });

  it("returns every matching candidate, preserving input order, deduplicated", () => {
    expect(findInvoiceNumbers("RE-2026-00002 und RE-2026-00003 und RE-2026-00002 erneut", ["RE-2026-00002", "RE-2026-00003", "RE-2026-99999"])).toEqual([
      "RE-2026-00002",
      "RE-2026-00003",
    ]);
  });

  it("does not match a candidate that is only a partial substring collision by coincidence", () => {
    // "RE-2026-0000" (11 normalized chars) is a strict prefix of "RE-2026-00002" (12 normalized
    // chars) as text, but the search direction is candidate-in-text, so a LONGER candidate than
    // what appears in the text must not match.
    expect(findInvoiceNumbers("Zahlung fuer RE-2026-0000", ["RE-2026-00002"])).toEqual([]);
  });

  // R1 security review (suspected, low): a digit-only candidate used to need only 4 normalized
  // characters, so a bare year like "2026" matched the date substring inside an unrelated
  // sentence. Table-driven per the finding's own worked cases.
  describe("digit-only candidates (R1 fix)", () => {
    it("does not match a 4-digit year against the date it is part of", () => {
      expect(findInvoiceNumbers("Rechnung vom 15.03.2026", ["2026"])).toEqual([]);
    });

    it("does not match ANY standalone 4-digit candidate at all - the minimum digit-only length is 5, regardless of context", () => {
      expect(findInvoiceNumbers("Bestellnummer 2026 vom Kunden", ["2026"])).toEqual([]);
    });

    it("matches a 5-digit digit-only candidate standing at a word boundary", () => {
      expect(findInvoiceNumbers("Rechnungsnummer: 12345, vielen Dank", ["12345"])).toEqual(["12345"]);
    });

    it("does not match a 5-digit candidate embedded inside a longer digit run", () => {
      // "23456" is a literal substring of "123456789", but not a standalone token: rejected
      // by the digit-adjacency (word-boundary) check even though it clears the length floor.
      expect(findInvoiceNumbers("Referenz 123456789 abgeschlossen", ["23456"])).toEqual([]);
    });

    it("does not match a 5-digit candidate embedded inside a compact (unseparated) date", () => {
      expect(findInvoiceNumbers("Beleg vom 20260315 gebucht", ["20260"])).toEqual([]);
    });

    it("still matches a standalone 5-digit candidate immediately followed by punctuation", () => {
      expect(findInvoiceNumbers("Kundennummer 54321.", ["54321"])).toEqual(["54321"]);
    });

    it.each(["RE-2026-00002", "RE 2026 00002", "RE202600002", "re-2026-00002"])(
      "still finds the alphanumeric candidate 'RE-2026-00002' spelled as %s (unaffected by the digit-only tightening)",
      (variant) => {
        expect(findInvoiceNumbers(`Zahlung fuer ${variant}, vielen Dank`, ["RE-2026-00002"])).toEqual(["RE-2026-00002"]);
      },
    );

    // decisions/0031-direction-from-kind-and-short-invoice-numbers.md: a real transaction's
    // remittance text ("Re.Nr. 12 vom 02.07.25 Beratung und Hosting") has a genuinely short, bare
    // invoice number ("12") that the 5-digit floor above made permanently unfindable - the one
    // narrow exception is a short digit-only candidate directly preceded by a recognized
    // invoice-number keyword.
    describe("keyword exception for short invoice numbers (decisions/0031)", () => {
      it("finds '38' in the exact observed transaction text, after 'Re.Nr.'", () => {
        expect(findInvoiceNumbers("Re.Nr. 12 vom 02.07.25 Beratung und Hosting", ["12"])).toEqual(["12"]);
      });

      it("finds '38' directly after 'Rechnung'", () => {
        expect(findInvoiceNumbers("Rechnung 12 wurde beglichen", ["12"])).toEqual(["12"]);
      });

      it("finds '12' directly after 'RG-'", () => {
        expect(findInvoiceNumbers("Zahlung RG-12 danke", ["12"])).toEqual(["12"]);
      });

      it("does not find '38' when it is not even present in the text ('vom 02.07.25' alone)", () => {
        expect(findInvoiceNumbers("vom 02.07.25", ["12"])).toEqual([]);
      });

      it("does not find a bare '38' with no invoice-number keyword in front of it", () => {
        expect(findInvoiceNumbers("Ueberweisung 38 Euro vom Konto", ["12"])).toEqual([]);
      });

      it("still does not match a 4-digit year inside a date even though 'Rechnung' appears earlier in the same text (the keyword is not directly adjacent)", () => {
        expect(findInvoiceNumbers("Rechnung vom 15.03.2026", ["2026"])).toEqual([]);
      });

      it("does not match a keyword-adjacent candidate that is itself only part of a longer digit run", () => {
        // "Re.Nr. 1215" is invoice number 3815, not 38 - the trailing "1" after the candidate's
        // own digits means the word-boundary-after-the-number check must still reject "12"
        // even though "Re.Nr." directly precedes it.
        expect(findInvoiceNumbers("Re.Nr. 1215 vom 02.07.25", ["12"])).toEqual([]);
      });
    });
  });
});

describe("findCustomerNumbers", () => {
  it("uses the same tolerant matching as findInvoiceNumbers", () => {
    expect(findCustomerNumbers("Ihre Kundennummer: K-4711", ["K-4711"])).toEqual(["K-4711"]);
  });
});

// decisions/0033-contradicting-invoice-number-vetoes-a-match.md
describe("extractInvoiceReferences", () => {
  it("extracts the invoice number from the exact observed correct-match text", () => {
    expect(extractInvoiceReferences("Re.Nr. 12 vom 02.07.25 Beratung und Hosting")).toEqual(new Set(["12"]));
  });

  it("extracts the invoice number from the exact observed false-positive text", () => {
    expect(extractInvoiceReferences("Re Nr. 15")).toEqual(new Set(["15"]));
  });

  it("extracts only the invoice number, never a customer number sitting next to it", () => {
    expect(extractInvoiceReferences("Kundennummer 1 Rechnung 12")).toEqual(new Set(["12"]));
  });

  it("returns an empty set for a bare number with no invoice keyword at all", () => {
    expect(extractInvoiceReferences("12")).toEqual(new Set());
  });

  it("returns an empty set for a date-only text", () => {
    expect(extractInvoiceReferences("Zahlung vom 15.03.2026")).toEqual(new Set());
  });

  it("returns an empty set for null/empty remittance text", () => {
    expect(extractInvoiceReferences(null)).toEqual(new Set());
    expect(extractInvoiceReferences("")).toEqual(new Set());
  });

  it("extracts every reference when the text names more than one invoice", () => {
    expect(extractInvoiceReferences("Re.Nr. 12 und Re.Nr. 15")).toEqual(new Set(["12", "15"]));
  });
});

describe("hasContradictingInvoiceReference", () => {
  it("is the strong negative evidence from the exact observed defect: text names 15, candidate is 12", () => {
    expect(hasContradictingInvoiceReference("Re Nr. 15", "12")).toBe(true);
  });

  it("is false for the exact observed correct match: text names 12, candidate is 12", () => {
    expect(hasContradictingInvoiceReference("Re.Nr. 12 vom 02.07.25 Beratung und Hosting", "12")).toBe(false);
  });

  it("is false when the candidate has no invoice number at all - nothing to contradict", () => {
    expect(hasContradictingInvoiceReference("Re Nr. 15", null)).toBe(false);
  });

  it("is false when the text names no reference at all - a bare amount match is unaffected", () => {
    expect(hasContradictingInvoiceReference("Vielen Dank fuer die Zahlung", "12")).toBe(false);
  });

  it("is false when the candidate is one of several references the text names (a collective payment)", () => {
    expect(hasContradictingInvoiceReference("Re.Nr. 12 und Re.Nr. 15", "15")).toBe(false);
  });
});

describe("counterpartyNameSimilarity", () => {
  it("returns 1 for names that normalize identically (legal-form suffix stripped)", () => {
    expect(counterpartyNameSimilarity("Musterwerk GmbH", "Musterwerk")).toBe(1);
  });

  it("returns 0 when either side is null", () => {
    expect(counterpartyNameSimilarity(null, "Musterwerk GmbH")).toBe(0);
    expect(counterpartyNameSimilarity("Musterwerk GmbH", null)).toBe(0);
  });

  it("returns 0 when either side is an empty string", () => {
    expect(counterpartyNameSimilarity("", "Musterwerk GmbH")).toBe(0);
  });

  it("returns a partial score for related but non-identical names", () => {
    const score = counterpartyNameSimilarity("Musterwerk GmbH", "Musterwerk Handel GmbH");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("returns 0 for unrelated names", () => {
    expect(counterpartyNameSimilarity("Musterwerk GmbH", "Voellig Anderes Unternehmen AG")).toBe(0);
  });
});

// A real false veto (decisions/0033, revised): invoice 21, 312,50 EUR, was paid with the remittance
// line "Re Nr. 21/ 24" (number/year). Normalizing glued it into "2124", so the veto called the
// correct payment a contradiction and no stage could match it.
describe("number/year phrases after an invoice keyword", () => {
  const realRemittance = "Re Nr. 21/ 24";

  it("finds the first number of the phrase, and only that one", () => {
    expect(findInvoiceNumbers(realRemittance, ["21", "24", "22", "2124"])).toEqual(["21", "2124"]);
    expect(findInvoiceNumbers("Re Nr. 21/24", ["21"])).toEqual(["21"]);
    expect(findInvoiceNumbers("Rechnung 12345/2024", ["12345"])).toEqual(["12345"]);
  });

  it("extracts every plausible reading as a reference", () => {
    expect([...extractInvoiceReferences(realRemittance)].sort()).toEqual(["21", "2124", "24"]);
    expect([...extractInvoiceReferences("Rechnung 2024-21")].sort()).toEqual(["2024", "202421", "21"]);
  });

  it("no longer vetoes the real payment, whichever way the document number was extracted", () => {
    expect(hasContradictingInvoiceReference(realRemittance, "21")).toBe(false);
    expect(hasContradictingInvoiceReference(realRemittance, "21/24")).toBe(false);
    expect(hasContradictingInvoiceReference("Rechnung 2024/21", "21")).toBe(false);
    expect(hasContradictingInvoiceReference("Re Nr. 2026-00002", "RE-2026-00002")).toBe(false);
  });

  it("still vetoes a genuine contradiction", () => {
    expect(hasContradictingInvoiceReference(realRemittance, "22")).toBe(true);
    expect(hasContradictingInvoiceReference("Re Nr. 15", "12")).toBe(true);
    expect(hasContradictingInvoiceReference("Re.Nr. 12 vom 02.07.25 Beratung und Hosting", "21")).toBe(true);
  });

  it("does not let a date after the number join the phrase", () => {
    expect([...extractInvoiceReferences("Re.Nr. 12 vom 02.07.25 Beratung und Hosting")]).toEqual(["12"]);
  });
});

describe("hasContradictingInvoiceReference reads the document number leniently", () => {
  it("ignores a dropped letter prefix and leading zeros", () => {
    expect(hasContradictingInvoiceReference("Re Nr. 2026-00002", "RE-2026-00002")).toBe(false);
    expect(hasContradictingInvoiceReference("Rechnung 42", "RE-0042")).toBe(false);
  });

  it("still vetoes when the digits really differ", () => {
    expect(hasContradictingInvoiceReference("Rechnung 43", "RE-0042")).toBe(true);
  });
});

describe("extractStatementReferences (decisions/0071)", () => {
  it("reads the reference after the asterisk from the counterparty name", () => {
    expect(extractStatementReferences({ counterpartyName: "FACEBK *4TXV8WLN2B", remittanceText: null })).toEqual(["4TXV8WLN2B"]);
  });

  it("reads it from the remittance text too, uppercased and deduplicated", () => {
    expect(extractStatementReferences({ counterpartyName: "FACEBK *x6tuj3ahs4", remittanceText: "FACEBK * X6TUJ3AHS4" })).toEqual(["X6TUJ3AHS4"]);
  });

  it.each([
    ["a plain word", "PAYPAL *MUSTERSHOP"],
    ["a short mixed token", "AMZN *AB12"],
    ["a short number", "SHOP *1234567"],
    ["no asterisk", "FACEBK 4TXV8WLN2B"],
  ])("ignores %s", (_label, counterpartyName) => {
    expect(extractStatementReferences({ counterpartyName, remittanceText: null })).toEqual([]);
  });

  it("accepts a long digit-only reference", () => {
    expect(extractStatementReferences({ counterpartyName: "PAYPAL *1043219876", remittanceText: null })).toEqual(["1043219876"]);
  });
});

describe("documentNamesStatementReference (decisions/0071)", () => {
  const receipt = "Zahlungsmethode Visa ··· 4242 Referenznummer: 4TXV8WLN2B Transaktions-ID 1000000001";

  it("finds the reference as a whole token, case-insensitively", () => {
    expect(documentNamesStatementReference(receipt.toLowerCase(), ["4TXV8WLN2B"])).toBe(true);
  });

  it("does not find it inside a longer token", () => {
    expect(documentNamesStatementReference("Referenznummer: 14TXV8WLN2BX", ["4TXV8WLN2B"])).toBe(false);
  });

  it("is false without text or references", () => {
    expect(documentNamesStatementReference(null, ["4TXV8WLN2B"])).toBe(false);
    expect(documentNamesStatementReference(receipt, [])).toBe(false);
  });
});
