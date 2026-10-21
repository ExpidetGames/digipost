import { describe, expect, it } from "vitest";

import {
  acceptInvitationInputSchema,
  companyProfileInputSchema,
  createWorkspaceInputSchema,
  inviteMemberInputSchema,
  removeMemberInputSchema,
  revokeInvitationInputSchema,
} from "../core/schemas";

// C2 (decisions/0021-extraction-direction-and-invoice-fields.md): onboarding also collects
// the company's address (line 1/postal code/city required, line 2/VAT id optional).
const VALID_ADDRESS = { addressLine1: "Musterstraße 1", postalCode: "10115", city: "Berlin" };

describe("createWorkspaceInputSchema", () => {
  it("trims the name", () => {
    expect(createWorkspaceInputSchema.parse({ name: "  Muster GmbH  ", ...VALID_ADDRESS })).toEqual({
      name: "Muster GmbH",
      addressLine1: "Musterstraße 1",
      addressLine2: undefined,
      postalCode: "10115",
      city: "Berlin",
      country: undefined,
      vatId: undefined,
      // decisions/0034-extended-company-profile.md: onboarding's only extended-profile field.
      aliases: [],
    });
  });

  it("defaults aliases to an empty array when absent, and trims each entry", () => {
    const parsed = createWorkspaceInputSchema.parse({ name: "Muster GmbH", ...VALID_ADDRESS, aliases: ["  Musterfirma  ", ""] });
    expect(parsed.aliases).toEqual(["Musterfirma", ""]);
  });

  it("rejects an empty name", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "   ", ...VALID_ADDRESS }).success).toBe(false);
  });

  it("rejects a name over 120 characters", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "x".repeat(121), ...VALID_ADDRESS }).success).toBe(false);
  });

  it("rejects a missing required address field", () => {
    expect(createWorkspaceInputSchema.safeParse({ name: "Muster GmbH" }).success).toBe(false);
    expect(createWorkspaceInputSchema.safeParse({ name: "Muster GmbH", addressLine1: "Musterstraße 1" }).success).toBe(false);
  });

  it("defaults country to DE (via the use case) when blank/absent, and normalizes optional fields", () => {
    const parsed = createWorkspaceInputSchema.parse({
      name: "Muster GmbH",
      ...VALID_ADDRESS,
      addressLine2: "  ",
      country: "de",
      vatId: "  DE123456789  ",
    });
    expect(parsed.addressLine2).toBeUndefined();
    expect(parsed.country).toBe("de"); // normalized to uppercase/defaulted by the use case, not this schema
    expect(parsed.vatId).toBe("DE123456789");
  });
});

describe("companyProfileInputSchema", () => {
  it("accepts the same address shape without a workspace name", () => {
    expect(companyProfileInputSchema.safeParse(VALID_ADDRESS).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    expect(companyProfileInputSchema.safeParse({ postalCode: "10115", city: "Berlin" }).success).toBe(false);
  });

  // decisions/0034-extended-company-profile.md (H1): the extended profile's list fields only
  // validate SHAPE here (array length/entry length) - the semantic checks (malformed IBAN,
  // non-host domain, too-generic alias) are the persistence use case's job, covered by
  // `src/persistence/tests/workspaces-use-cases.test.ts`.
  describe("extended profile fields", () => {
    it("defaults aliases/ibans/domains to an empty array when absent", () => {
      const parsed = companyProfileInputSchema.parse(VALID_ADDRESS);
      expect(parsed.aliases).toEqual([]);
      expect(parsed.ibans).toEqual([]);
      expect(parsed.domains).toEqual([]);
    });

    it("accepts a full extended profile", () => {
      const parsed = companyProfileInputSchema.parse({
        ...VALID_ADDRESS,
        aliases: ["Musterfirma"],
        ibans: ["DE89 3704 0044 0532 0130 00"],
        domains: ["https://www.musterfirma.de/x"],
        taxNumber: "12/345/67890",
        registerCourt: "Amtsgericht Charlottenburg",
        registerNumber: "HRB 123456",
        profileText: "Wir treten als Musterfirma auf.",
      });
      expect(parsed.aliases).toEqual(["Musterfirma"]);
      expect(parsed.ibans).toEqual(["DE89 3704 0044 0532 0130 00"]);
      expect(parsed.domains).toEqual(["https://www.musterfirma.de/x"]);
      expect(parsed.taxNumber).toBe("12/345/67890");
      expect(parsed.profileText).toBe("Wir treten als Musterfirma auf.");
    });

    it("rejects more than 20 aliases", () => {
      expect(companyProfileInputSchema.safeParse({ ...VALID_ADDRESS, aliases: Array(21).fill("Musterfirma") }).success).toBe(false);
    });

    it("rejects a profile text over 1000 characters", () => {
      expect(companyProfileInputSchema.safeParse({ ...VALID_ADDRESS, profileText: "x".repeat(1001) }).success).toBe(false);
    });

    it("treats a blank profile text as absent", () => {
      const parsed = companyProfileInputSchema.parse({ ...VALID_ADDRESS, profileText: "   " });
      expect(parsed.profileText).toBeUndefined();
    });
  });
});

describe("inviteMemberInputSchema", () => {
  it("trims and lowercases the email", () => {
    expect(inviteMemberInputSchema.parse({ email: "  New@Example.TEST  " })).toEqual({ email: "new@example.test" });
  });

  it("rejects an invalid email", () => {
    expect(inviteMemberInputSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });
});

describe("revokeInvitationInputSchema", () => {
  it("requires a uuid invitationId", () => {
    expect(revokeInvitationInputSchema.safeParse({ invitationId: "not-a-uuid" }).success).toBe(false);
    expect(revokeInvitationInputSchema.safeParse({ invitationId: crypto.randomUUID() }).success).toBe(true);
  });
});

describe("removeMemberInputSchema", () => {
  it("requires a uuid memberId", () => {
    expect(removeMemberInputSchema.safeParse({ memberId: "not-a-uuid" }).success).toBe(false);
    expect(removeMemberInputSchema.safeParse({ memberId: crypto.randomUUID() }).success).toBe(true);
  });
});

describe("acceptInvitationInputSchema", () => {
  it("accepts a plausible hex token", () => {
    expect(acceptInvitationInputSchema.safeParse({ token: "a".repeat(64) }).success).toBe(true);
  });

  it("rejects a too-short token", () => {
    expect(acceptInvitationInputSchema.safeParse({ token: "short" }).success).toBe(false);
  });
});
