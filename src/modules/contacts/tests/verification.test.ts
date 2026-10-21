import { describe, expect, it } from "vitest";

import { computeContactUpdatePlan, type ExistingContactForDiff } from "../core/verification";
import type { ExtractedContactData } from "../core/types";

function emptyExisting(overrides: Partial<ExistingContactForDiff> = {}): ExistingContactForDiff {
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

function extraction(overrides: Partial<ExtractedContactData> = {}): ExtractedContactData {
  return { name: "Musterwerk GmbH", ...overrides };
}

describe("computeContactUpdatePlan", () => {
  it("fills an empty field directly, no proposal", () => {
    const { fillPatch, proposals } = computeContactUpdatePlan(emptyExisting(), extraction({ iban: "DE12 3456 7890 1234 5678 90" }));

    expect(fillPatch).toEqual({ iban: "DE12 3456 7890 1234 5678 90" });
    expect(proposals).toEqual([]);
  });

  it("proposes a change instead of overwriting a non-empty, contradicting field", () => {
    const existing = emptyExisting({ iban: "DE00111122223333444455" });
    const { fillPatch, proposals } = computeContactUpdatePlan(existing, extraction({ iban: "DE99888877776666555544" }));

    expect(fillPatch).toEqual({});
    expect(proposals).toEqual([{ field: "iban", currentValue: "DE00111122223333444455", proposedValue: "DE99888877776666555544" }]);
  });

  it("never proposes and never fills when the value is equal after normalization", () => {
    const existing = emptyExisting({ vatId: "DE123456789" });
    const { fillPatch, proposals } = computeContactUpdatePlan(existing, extraction({ vatId: "DE 123 456 789" }));

    expect(fillPatch).toEqual({});
    expect(proposals).toEqual([]);
  });

  it("compares payment terms numerically, not as strings", () => {
    const existing = emptyExisting({ paymentTermsDays: 14 });
    const { fillPatch, proposals } = computeContactUpdatePlan(existing, extraction({ paymentTermsDays: 14 }));

    expect(fillPatch).toEqual({});
    expect(proposals).toEqual([]);
  });

  it("proposes a change to payment terms when the number actually differs", () => {
    const existing = emptyExisting({ paymentTermsDays: 14 });
    const { proposals } = computeContactUpdatePlan(existing, extraction({ paymentTermsDays: 30 }));

    expect(proposals).toEqual([{ field: "paymentTermsDays", currentValue: "14", proposedValue: "30" }]);
  });

  it("ignores a field the extraction did not provide", () => {
    const existing = emptyExisting({ phone: "+49 30 1234567" });
    const { fillPatch, proposals } = computeContactUpdatePlan(existing, extraction());

    expect(fillPatch).toEqual({});
    expect(proposals).toEqual([]);
  });

  it("treats a blank extracted string the same as an absent field", () => {
    const existing = emptyExisting({ city: "Berlin" });
    const { fillPatch, proposals } = computeContactUpdatePlan(existing, extraction({ city: "   " }));

    expect(fillPatch).toEqual({});
    expect(proposals).toEqual([]);
  });

  it("handles several fields at once: some fill, one proposes, one is unchanged", () => {
    const existing = emptyExisting({ vatId: "DE123456789", city: "Berlin" });
    const { fillPatch, proposals } = computeContactUpdatePlan(
      existing,
      extraction({ vatId: "DE123456789", city: "Hamburg", phone: "+49 30 1234567" }),
    );

    expect(fillPatch).toEqual({ phone: "+49 30 1234567" });
    expect(proposals).toEqual([{ field: "city", currentValue: "Berlin", proposedValue: "Hamburg" }]);
  });
});
