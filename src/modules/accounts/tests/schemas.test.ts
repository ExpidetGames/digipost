import { describe, expect, it } from "vitest";

import { manualAccountCreateSchema, transactionListQuerySchema } from "../core/schemas";

describe("transactionListQuerySchema", () => {
  it("defaults to page 1 with every filter optional", () => {
    const result = transactionListQuerySchema.parse({});
    expect(result).toEqual({ page: 1 });
  });

  it("coerces string query-param numbers to integers", () => {
    const result = transactionListQuerySchema.parse({ minAmountCents: "1000", maxAmountCents: "5000", page: "2" });
    expect(result).toMatchObject({ minAmountCents: 1000, maxAmountCents: 5000, page: 2 });
  });

  it("rejects a malformed date", () => {
    expect(transactionListQuerySchema.safeParse({ dateFrom: "15.01.2026" }).success).toBe(false);
  });

  it("rejects a creditDebit value outside the fixed set", () => {
    expect(transactionListQuerySchema.safeParse({ creditDebit: "both" }).success).toBe(false);
  });

  it("accepts a valid credit/debit filter and ISO dates", () => {
    const result = transactionListQuerySchema.parse({ creditDebit: "debit", dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result).toMatchObject({ creditDebit: "debit", dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  });

  it("falls back to page 1 for an invalid page value rather than rejecting the whole query", () => {
    expect(transactionListQuerySchema.parse({ page: "not-a-number" }).page).toBe(1);
  });
});

describe("manualAccountCreateSchema", () => {
  it("requires only type and name", () => {
    const result = manualAccountCreateSchema.parse({ type: "bank", name: "Geschäftskonto" });
    expect(result).toMatchObject({ type: "bank", name: "Geschäftskonto", currency: "EUR" });
  });

  it("normalizes a valid IBAN (uppercase, no spaces)", () => {
    const result = manualAccountCreateSchema.parse({ type: "bank", name: "Konto", iban: "de89 3704 0044 0532 0130 00" });
    expect(result.iban).toBe("DE89370400440532013000");
  });

  it("rejects a malformed IBAN (bad checksum)", () => {
    expect(manualAccountCreateSchema.safeParse({ type: "bank", name: "Konto", iban: "DE00370400440532013000" }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(manualAccountCreateSchema.safeParse({ type: "bank", name: "" }).success).toBe(false);
  });

  it("rejects a type outside bank/clearing", () => {
    expect(manualAccountCreateSchema.safeParse({ type: "savings", name: "Konto" }).success).toBe(false);
  });
});

// decisions/0062-an-empty-search-param-means-absent.md
describe("an empty search param means absent", () => {
  it("keeps the filter that was set and drops the empty ones", () => {
    const result = transactionListQuerySchema.safeParse({ q: "", dateFrom: "2025-01-01", dateTo: "", minAmountCents: "", maxAmountCents: "", creditDebit: "", page: "" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ dateFrom: "2025-01-01", page: 1 });
    expect(result.data?.dateTo).toBeUndefined();
    expect(result.data?.creditDebit).toBeUndefined();
  });

  it("does not turn an empty amount field into a zero-euro filter", () => {
    // `z.coerce.number()` reads "" as 0, so before this an untouched amount box silently
    // became "at least 0 euros" instead of no filter at all.
    const result = transactionListQuerySchema.safeParse({ minAmountCents: "", maxAmountCents: "" });
    expect(result.data?.minAmountCents).toBeUndefined();
    expect(result.data?.maxAmountCents).toBeUndefined();
  });
});
