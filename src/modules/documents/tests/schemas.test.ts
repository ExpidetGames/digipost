import { describe, expect, it } from "vitest";

import { DOCUMENT_KINDS } from "@/modules/intake";

import {
  confirmIntakeInputSchema,
  deleteDocumentInputSchema,
  documentListQuerySchema,
  reclassifyDocumentInputSchema,
  rejectIntakeInputSchema,
  resetIntakeFingerprintInputSchema,
} from "../core/schemas";

const DOC_ID = "11111111-1111-4111-8111-111111111111";

describe("deleteDocumentInputSchema", () => {
  it("requires a uuid document id", () => {
    expect(deleteDocumentInputSchema.safeParse({ documentId: DOC_ID }).success).toBe(true);
    expect(deleteDocumentInputSchema.safeParse({ documentId: "x" }).success).toBe(false);
  });
});

// decisions/0072-correcting-a-document-s-kind.md
describe("reclassifyDocumentInputSchema", () => {
  it("accepts every kind except the three account-feeding ones", () => {
    const accepted = DOCUMENT_KINDS.filter((kind) => reclassifyDocumentInputSchema.safeParse({ documentId: DOC_ID, kind }).success);
    expect(accepted).toEqual(["letter", "incoming_invoice", "outgoing_invoice", "reminder", "receipt", "contract", "authority_letter", "other"]);
  });

  it("rejects bank_statement, payout_report, platform_settlement, an unknown kind, and a non-uuid id", () => {
    for (const kind of ["bank_statement", "payout_report", "platform_settlement", "invoice"]) {
      expect(reclassifyDocumentInputSchema.safeParse({ documentId: DOC_ID, kind }).success).toBe(false);
    }
    expect(reclassifyDocumentInputSchema.safeParse({ documentId: "x", kind: "incoming_invoice" }).success).toBe(false);
  });
});

describe("documentListQuerySchema", () => {
  it("defaults page to 1", () => {
    const result = documentListQuerySchema.parse({});
    expect(result.page).toBe(1);
  });

  it("coerces a string page to a number and falls back to 1 for an invalid one", () => {
    expect(documentListQuerySchema.parse({ page: "3" }).page).toBe(3);
    expect(documentListQuerySchema.parse({ page: "not-a-number" }).page).toBe(1);
  });

  it("only accepts a known status", () => {
    expect(documentListQuerySchema.safeParse({ status: "done" }).success).toBe(true);
    expect(documentListQuerySchema.safeParse({ status: "archived" }).success).toBe(false);
  });

  it("only accepts a known kind (F1b, decisions/0022-intake-wiring.md)", () => {
    expect(documentListQuerySchema.safeParse({ kind: "bank_statement" }).success).toBe(true);
    expect(documentListQuerySchema.safeParse({ kind: "not_a_real_kind" }).success).toBe(false);
  });

  // decisions/0066-abschluss-check-and-export.md: the inbox's date range, which is also what
  // the Abschluss's "Wartet auf Bestätigung"/"Verarbeitung fehlgeschlagen" links carry.
  describe("the date range (?from=/?to=)", () => {
    it("keeps two real ISO dates", () => {
      const parsed = documentListQuerySchema.parse({ from: "2025-01-01", to: "2025-12-31" });
      expect(parsed).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
    });

    it("accepts one bound on its own", () => {
      const lowerOnly = documentListQuerySchema.parse({ from: "2025-01-01" });
      expect([lowerOnly.from, lowerOnly.to]).toEqual(["2025-01-01", undefined]);
      const upperOnly = documentListQuerySchema.parse({ to: "2025-12-31" });
      expect([upperOnly.from, upperOnly.to]).toEqual([undefined, "2025-12-31"]);
    });

    it("treats an empty field as absent, never as a filter (decisions/0062)", () => {
      // A `method="get"` form submits every field, so an untouched date input arrives as "".
      const parsed = documentListQuerySchema.parse({ from: "", to: "", status: "done" });
      expect([parsed.from, parsed.to, parsed.status]).toEqual([undefined, undefined, "done"]);
    });

    it("drops an unusable bound instead of failing the whole query", () => {
      // A stale bookmark, a hand-edited URL, or a date that does not exist. Each would
      // otherwise reach Postgres as `'...'::date` and break the page rather than the filter.
      for (const bad of ["01.01.2025", "2025-1-1", "2025-02-31", "2025-13-01", "yesterday"]) {
        const parsed = documentListQuerySchema.parse({ from: bad, status: "done" });
        expect(parsed.from).toBeUndefined();
        expect(parsed.status).toBe("done");
      }
    });

    it("keeps a leap day, which is a real date", () => {
      expect(documentListQuerySchema.parse({ from: "2024-02-29" }).from).toBe("2024-02-29");
      expect(documentListQuerySchema.parse({ from: "2025-02-29" }).from).toBeUndefined();
    });
  });
});

// F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the confirmation
// UI's own Server Action inputs.
describe("confirmIntakeInputSchema", () => {
  const VALID_INPUT = {
    documentId: DOC_ID,
    documentKind: "bank_statement",
    platform: null,
    mapping: { bookingDate: "Datum", amount: "Betrag" },
    amountSign: { mode: "signed_column", column: "Betrag" },
  };

  it("accepts a valid confirmation with a partial mapping and a signed_column amount sign", () => {
    expect(confirmIntakeInputSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it("accepts an empty mapping and a null amount sign (the model proposed neither)", () => {
    expect(confirmIntakeInputSchema.safeParse({ ...VALID_INPUT, mapping: {}, amountSign: null }).success).toBe(true);
  });

  it("accepts every amountSign mode shape", () => {
    expect(
      confirmIntakeInputSchema.safeParse({
        ...VALID_INPUT,
        amountSign: { mode: "separate_credit_debit_columns", creditColumn: "Haben", debitColumn: "Soll" },
      }).success,
    ).toBe(true);
    expect(
      confirmIntakeInputSchema.safeParse({
        ...VALID_INPUT,
        amountSign: { mode: "indicator_column", amountColumn: "Betrag", indicatorColumn: "Typ", creditValue: "H", debitValue: "S" },
      }).success,
    ).toBe(true);
  });

  it("rejects a mapping key that is not a known semantic field", () => {
    expect(confirmIntakeInputSchema.safeParse({ ...VALID_INPUT, mapping: { notARealField: "Spalte" } }).success).toBe(false);
  });

  it("rejects an unrecognized document kind or platform", () => {
    expect(confirmIntakeInputSchema.safeParse({ ...VALID_INPUT, documentKind: "not_a_kind" }).success).toBe(false);
    expect(confirmIntakeInputSchema.safeParse({ ...VALID_INPUT, platform: "not_a_platform" }).success).toBe(false);
  });

  it("rejects a non-uuid document id", () => {
    expect(confirmIntakeInputSchema.safeParse({ ...VALID_INPUT, documentId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("rejectIntakeInputSchema", () => {
  it("requires a uuid document id", () => {
    expect(rejectIntakeInputSchema.safeParse({ documentId: DOC_ID }).success).toBe(true);
    expect(rejectIntakeInputSchema.safeParse({ documentId: "x" }).success).toBe(false);
  });
});

describe("resetIntakeFingerprintInputSchema", () => {
  it("requires a uuid fingerprint id", () => {
    expect(resetIntakeFingerprintInputSchema.safeParse({ fingerprintId: DOC_ID }).success).toBe(true);
    expect(resetIntakeFingerprintInputSchema.safeParse({ fingerprintId: "x" }).success).toBe(false);
  });
});
