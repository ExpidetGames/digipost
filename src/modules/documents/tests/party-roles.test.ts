// H-contract.md section 2's plan table, verbatim: one test per row (decisions/0036-guided-extraction.md).
import { describe, expect, it } from "vitest";

import type { DocumentKind } from "@/modules/intake";

import { isDerivedCounterpartyKind, planCounterparty } from "../core/party-roles";

describe("planCounterparty", () => {
  it("outgoing_invoice: derived, we are the sender, the counterparty is the recipient, relationType customer", () => {
    expect(planCounterparty("outgoing_invoice")).toEqual({
      mode: "derived",
      ourRole: "sender",
      counterpartyRole: "recipient",
      relationType: "customer",
    });
  });

  it("incoming_invoice: derived, we are the recipient, the counterparty is the sender, relationType supplier", () => {
    expect(planCounterparty("incoming_invoice")).toEqual({
      mode: "derived",
      ourRole: "recipient",
      counterpartyRole: "sender",
      relationType: "supplier",
    });
  });

  it("receipt: derived, we are the recipient, the counterparty is the sender, relationType supplier", () => {
    expect(planCounterparty("receipt")).toEqual({
      mode: "derived",
      ourRole: "recipient",
      counterpartyRole: "sender",
      relationType: "supplier",
    });
  });

  it("platform_settlement: derived, we are the recipient, the counterparty is the sender, relationType null", () => {
    expect(planCounterparty("platform_settlement")).toEqual({
      mode: "derived",
      ourRole: "recipient",
      counterpartyRole: "sender",
      relationType: null,
    });
  });

  it("payout_report: derived, we are the recipient, the counterparty is the sender, relationType null", () => {
    expect(planCounterparty("payout_report")).toEqual({
      mode: "derived",
      ourRole: "recipient",
      counterpartyRole: "sender",
      relationType: null,
    });
  });

  it("authority_letter: derived, we are the recipient, the counterparty is the sender, relationType authority", () => {
    expect(planCounterparty("authority_letter")).toEqual({
      mode: "derived",
      ourRole: "recipient",
      counterpartyRole: "sender",
      relationType: "authority",
    });
  });

  it("bank_statement: none - no counterparty is extracted at all", () => {
    expect(planCounterparty("bank_statement")).toEqual({ mode: "none" });
  });

  it("reminder: open - the model still decides", () => {
    expect(planCounterparty("reminder")).toEqual({ mode: "open" });
  });

  it("letter: open", () => {
    expect(planCounterparty("letter")).toEqual({ mode: "open" });
  });

  it("contract: open", () => {
    expect(planCounterparty("contract")).toEqual({ mode: "open" });
  });

  it("other: open", () => {
    expect(planCounterparty("other")).toEqual({ mode: "open" });
  });

  it("covers every DocumentKind with no exceptions (a new kind must be added to this table deliberately)", () => {
    const kinds: DocumentKind[] = [
      "letter",
      "incoming_invoice",
      "outgoing_invoice",
      "reminder",
      "receipt",
      "bank_statement",
      "payout_report",
      "platform_settlement",
      "contract",
      "authority_letter",
      "other",
    ];
    for (const kind of kinds) {
      expect(() => planCounterparty(kind)).not.toThrow();
    }
  });
});

// Wave 2 (H2-wave2.md's self-counterparty check, decisions/0036-guided-extraction.md).
describe("isDerivedCounterpartyKind", () => {
  it.each(["outgoing_invoice", "incoming_invoice", "receipt", "platform_settlement", "payout_report", "authority_letter"] as const)(
    "is true for %s (a derived-mode kind)",
    (kind) => {
      expect(isDerivedCounterpartyKind(kind)).toBe(true);
    },
  );

  it.each(["bank_statement", "reminder", "letter", "contract", "other"] as const)("is false for %s (open/none mode)", (kind) => {
    expect(isDerivedCounterpartyKind(kind)).toBe(false);
  });
});
