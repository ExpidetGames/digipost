// `/dashboard/contacts`'s filter/pagination state lives entirely in the URL
// (`contactListQuerySchema`, same convention as `src/modules/documents/core/schemas.ts`'s
// `documentListQuerySchema`) - this is the list page's own filter logic, tested at the
// schema level since the page itself is an async Server Component (not renderable with
// Testing Library/jsdom the way a client island is).
import { describe, expect, it } from "vitest";

import { contactListQuerySchema } from "../core/schemas";

describe("contactListQuerySchema", () => {
  it("defaults to page 1 with every filter absent", () => {
    const result = contactListQuerySchema.parse({});
    expect(result).toEqual({ page: 1 });
  });

  it("accepts a search term, relation type, and the unverified flag together", () => {
    const result = contactListQuerySchema.parse({ q: "Muster", relationType: "supplier", unverified: "1", page: "2" });
    expect(result).toEqual({ q: "Muster", relationType: "supplier", unverified: "1", page: 2 });
  });

  it("rejects a relation type outside the closed CONTACT_RELATION_TYPES set", () => {
    const result = contactListQuerySchema.safeParse({ relationType: "not-a-real-type" });
    expect(result.success).toBe(false);
  });

  it("falls back to page 1 for a non-numeric or invalid page value", () => {
    expect(contactListQuerySchema.parse({ page: "not-a-number" }).page).toBe(1);
    expect(contactListQuerySchema.parse({ page: "0" }).page).toBe(1);
  });

  it("ignores any unverified value other than the literal \"1\"", () => {
    const result = contactListQuerySchema.safeParse({ unverified: "true" });
    expect(result.success).toBe(false);
  });
});

// decisions/0062-an-empty-search-param-means-absent.md: what the browser really sends when the
// user sets one filter and presses the button - every untouched control submits an empty value.
describe("an empty search param means absent", () => {
  it("keeps the filter that was set and drops the empty ones", () => {
    const result = contactListQuerySchema.safeParse({ q: "muster", relationType: "", unverified: "", page: "" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ q: "muster", page: 1 });
    expect(result.data?.relationType).toBeUndefined();
    expect(result.data?.unverified).toBeUndefined();
  });
});
