import { describe, expect, it } from "vitest";

import { manualContactCreateSchema } from "../core/schemas";

describe("manualContactCreateSchema", () => {
  it("accepts a minimal contact with only a name", () => {
    const result = manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Musterwerk GmbH");
      expect(result.data.iban).toBeUndefined();
    }
  });

  it("rejects a blank name", () => {
    expect(manualContactCreateSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("treats a blank optional field as not provided", () => {
    const result = manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", city: "   " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.city).toBeUndefined();
  });

  it("rejects a malformed iban", () => {
    const result = manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", iban: "not an iban" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid iban", () => {
    const result = manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", iban: "DE89370400440532013000" });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed vat id", () => {
    const result = manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", vatId: "DE12345678" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown relation type", () => {
    const result = manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", relationType: "not-a-real-type" });
    expect(result.success).toBe(false);
  });

  it("accepts every declared relation type", () => {
    for (const relationType of ["supplier", "customer", "authority", "insurance", "bank", "other"]) {
      expect(manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", relationType }).success).toBe(true);
    }
  });

  it("coerces payment terms to a number and rejects a negative one", () => {
    const ok = manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", paymentTermsDays: "30" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.paymentTermsDays).toBe(30);

    expect(manualContactCreateSchema.safeParse({ name: "Musterwerk GmbH", paymentTermsDays: -1 }).success).toBe(false);
  });
});
