// C2 (decisions/0021-extraction-direction-and-invoice-fields.md), tightened by
// decisions/0031-direction-from-kind-and-short-invoice-numbers.md: direction is decided
// entirely in code, in priority order, from (1) the extracted parties' `role` hints compared
// against the workspace's own company via `@/modules/contacts`'s `isOwnCompany`, (2)
// `documents.kind`, (3) a deterministic own-company-in-text check - never trusted from the
// model at any level.
import { describe, expect, it } from "vitest";

import type { OwnCompanyProfile } from "@/modules/contacts";
import type { DocumentKind } from "@/modules/intake";

import { decideDirection, nonOwnParties, resolveLinkRoles } from "../core/direction";
import type { ExtractedParty } from "../core/ports";

// decisions/0034-extended-company-profile.md (H1) added `aliases`/`ibans`/`domains`/
// `taxNumber`/`registerCourt`/`registerNumber` to `OwnCompanyProfile` - all empty/null here,
// this test file's own scope (direction, not the extended-profile match rules, which are
// `src/modules/contacts/tests/own-company.test.ts`'s job) is unaffected by the addition.
const OWN_COMPANY: OwnCompanyProfile = {
  name: "Muster Werkstatt GmbH",
  postalCode: "10115",
  vatId: "DE111222333",
  aliases: [],
  ibans: [],
  domains: [],
  taxNumber: null,
  registerCourt: null,
  registerNumber: null,
};

function party(overrides: Partial<ExtractedParty> & Pick<ExtractedParty, "role" | "name">): ExtractedParty {
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

describe("decideDirection", () => {
  describe("priority 1: an own-company party's role", () => {
    it("is incoming when we are among the parties as recipient", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" }), party({ role: "recipient", name: "Muster Werkstatt GmbH", vatId: "DE111222333" })];
      expect(decideDirection(parties, OWN_COMPANY, null, null)).toBe("incoming");
    });

    it("is outgoing when we are the sender", () => {
      const parties = [party({ role: "sender", name: "Muster Werkstatt GmbH", vatId: "DE111222333" }), party({ role: "recipient", name: "Kunde GmbH" })];
      expect(decideDirection(parties, OWN_COMPANY, null, null)).toBe("outgoing");
    });

    it("prefers incoming over outgoing when we appear in both roles (a reply thread)", () => {
      const parties = [
        party({ role: "recipient", name: "Muster Werkstatt GmbH", vatId: "DE111222333" }),
        party({ role: "sender", name: "Muster Werkstatt GmbH", vatId: "DE111222333" }),
      ];
      expect(decideDirection(parties, OWN_COMPANY, null, null)).toBe("incoming");
    });

    it("loses against a contradicting invoice kind (decisions/0032, the real-invoice regression)", () => {
      // The owner's own outgoing invoice: the model labelled THEM the recipient and their
      // customer the sender, on a letter they had sent themselves. Believing those labels
      // produced "incoming" and excluded the document from payment matching, while the
      // classifier's kind was right in every single run. `kind` therefore wins now.
      const parties = [party({ role: "sender", name: "Kunde GmbH" }), party({ role: "recipient", name: "Muster Werkstatt GmbH", vatId: "DE111222333" })];
      expect(decideDirection(parties, OWN_COMPANY, "outgoing_invoice", null)).toBe("outgoing");
    });

    it("still decides from the party roles for a kind that carries no direction", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" }), party({ role: "recipient", name: "Muster Werkstatt GmbH", vatId: "DE111222333" })];
      expect(decideDirection(parties, OWN_COMPANY, "letter", null)).toBe("incoming");
    });
  });

  describe("priority 2: documents.kind, when no own-company party role is present", () => {
    it("is outgoing for kind outgoing_invoice", () => {
      const parties = [party({ role: "sender", name: "Kunde GmbH" })];
      expect(decideDirection(parties, OWN_COMPANY, "outgoing_invoice", null)).toBe("outgoing");
    });

    it("is incoming for kind incoming_invoice", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" })];
      expect(decideDirection(parties, OWN_COMPANY, "incoming_invoice", null)).toBe("incoming");
    });

    // decisions/0036-guided-extraction.md's wave 2 (H-contract.md section 5): `"reminder"` was
    // REMOVED from `directionFromKind` - unlike an invoice, a reminder has no fixed "who sent
    // this" shape, so its kind alone must no longer imply a direction. A reminder's own party
    // role hint (priority 1) still resolves it when present; `core/reminder-direction.ts`'s
    // `resolveReminderDirection` is what actually decides a reminder's direction in the guided
    // pipeline (the payment-IBAN override), never this function.
    it("no longer resolves a direction from kind alone for a reminder - falls through to the party role", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" })];
      expect(decideDirection(parties, OWN_COMPANY, "reminder", null)).toBe("unknown");
    });

    it("still resolves a reminder's direction from an own-company party role when one is present", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" }), party({ role: "recipient", name: "Muster Werkstatt GmbH", vatId: "DE111222333" })];
      expect(decideDirection(parties, OWN_COMPANY, "reminder", null)).toBe("incoming");
    });

    // The exact case observed on a real outgoing invoice (three consecutive analyzer runs of
    // the SAME document/prompt/model producing three different, inconsistent party lists,
    // decisions/0031): the workspace's own company is not in `parties` at all, the customer is
    // mislabeled `sender`, and there is an unrelated third party ("MUSTERBANK PAYMENTS") - yet
    // `kind` (a separate, more stable classifier call) was correct in every run.
    it("is outgoing for the exact observed case: own company absent, customer mislabeled sender, kind outgoing_invoice", () => {
      const parties = [party({ role: "sender", name: "Kunde GmbH" }), party({ role: "mentioned", name: "MUSTERBANK PAYMENTS" })];
      expect(decideDirection(parties, OWN_COMPANY, "outgoing_invoice", null)).toBe("outgoing");
    });

    it("a kind with no direction signal (e.g. a plain letter) falls through to priority 3/4", () => {
      const parties = [party({ role: "mentioned", name: "Unklare Firma" })];
      expect(decideDirection(parties, OWN_COMPANY, "letter", null)).toBe("unknown");
    });
  });

  describe("priority 3: own company mentioned in the document text, weakest signal", () => {
    it("is incoming when the own company's name appears in the text and exactly one party is marked sender", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" })];
      const text = "Muster Werkstatt GmbH\nMusterstrasse 1\n10115 Berlin\n\nSehr geehrte Damen und Herren...";
      expect(decideDirection(parties, OWN_COMPANY, "letter", text)).toBe("incoming");
    });

    it("is incoming when only the own company's postal code appears in the text", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" })];
      const text = "An den Bewohner\n10115 Berlin\n\nSehr geehrte Damen und Herren...";
      expect(decideDirection(parties, OWN_COMPANY, "letter", text)).toBe("incoming");
    });

    it("is unknown when the own company appears in the text but more than one party is marked sender", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" }), party({ role: "sender", name: "Vodafone GmbH" })];
      const text = "Muster Werkstatt GmbH, 10115 Berlin";
      expect(decideDirection(parties, OWN_COMPANY, "letter", text)).toBe("unknown");
    });

    it("is unknown when the text does not mention the own company at all", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" })];
      expect(decideDirection(parties, OWN_COMPANY, "letter", "Voellig anderer Brieftext ohne unsere Adresse")).toBe("unknown");
    });
  });

  describe("priority 4: never inventing a direction when nothing matches", () => {
    it("is unknown when no own-company party role, kind, or text evidence resolves it", () => {
      const parties = [party({ role: "sender", name: "Telekom Deutschland GmbH" }), party({ role: "mentioned", name: "Inkasso KG" })];
      expect(decideDirection(parties, OWN_COMPANY, null, null)).toBe("unknown");
    });

    it("is unknown when kind is a letter and no own-company party exists, with no text evidence either", () => {
      const parties = [party({ role: "mentioned", name: "Unklare Firma" })];
      const kind: DocumentKind = "letter";
      expect(decideDirection(parties, OWN_COMPANY, kind, "Ein Brief, der unsere Firma nicht erwaehnt")).toBe("unknown");
    });

    it("is unknown when the model mislabels the only other party as something other than sender", () => {
      const parties = [party({ role: "mentioned", name: "Telekom Deutschland GmbH" })];
      expect(decideDirection(parties, OWN_COMPANY, null, null)).toBe("unknown");
    });

    it("is unknown for no parties at all", () => {
      expect(decideDirection([], OWN_COMPANY, null, null)).toBe("unknown");
    });
  });
});

describe("nonOwnParties", () => {
  it("excludes the workspace's own company, matched by VAT id", () => {
    const own = party({ role: "recipient", name: "Muster Werkstatt GmbH", vatId: "DE111222333" });
    const other = party({ role: "sender", name: "Telekom Deutschland GmbH" });
    expect(nonOwnParties([own, other], OWN_COMPANY)).toEqual([other]);
  });
});

describe("resolveLinkRoles", () => {
  it("forces the resolved counterparty's role to sender for an incoming document", () => {
    const other = party({ role: "mentioned", name: "Telekom Deutschland GmbH" });
    const resolved = resolveLinkRoles([other], "incoming");
    expect(resolved).toEqual([{ party: other, role: "sender" }]);
  });

  it("forces the resolved counterparty's role to recipient for an outgoing document", () => {
    const other = party({ role: "mentioned", name: "Kunde GmbH" });
    const resolved = resolveLinkRoles([other], "outgoing");
    expect(resolved).toEqual([{ party: other, role: "recipient" }]);
  });

  it("keeps every other party's own role hint unchanged once one party already has the expected role", () => {
    const sender = party({ role: "sender", name: "Telekom Deutschland GmbH" });
    const onBehalfOf = party({ role: "on_behalf_of", name: "Inkasso KG" });
    const resolved = resolveLinkRoles([sender, onBehalfOf], "incoming");
    expect(resolved).toEqual([
      { party: sender, role: "sender" },
      { party: onBehalfOf, role: "on_behalf_of" },
    ]);
  });

  it("does not force any role when direction is unknown", () => {
    const other = party({ role: "mentioned", name: "Unklare Firma" });
    expect(resolveLinkRoles([other], "unknown")).toEqual([{ party: other, role: "mentioned" }]);
  });
});
