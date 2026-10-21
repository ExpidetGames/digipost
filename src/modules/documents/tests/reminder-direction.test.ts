// H-contract.md section 5: own IBAN -> outgoing, a foreign IBAN -> incoming, no IBAN -> the
// model's own answer (or unknown), decisions/0036-guided-extraction.md.
import { describe, expect, it } from "vitest";

import { resolveReminderDirection } from "../core/reminder-direction";

describe("resolveReminderDirection", () => {
  it("is outgoing when the payment IBAN is one of our own (we are chasing our own payment)", () => {
    const result = resolveReminderDirection({
      modelDirection: "received",
      paymentIban: "DE89370400440532013000",
      ownIbans: ["DE89370400440532013000"],
    });
    expect(result).toBe("outgoing");
  });

  it("is incoming when the payment IBAN is present but none of ours (someone else is chasing us)", () => {
    const result = resolveReminderDirection({
      modelDirection: "sent",
      paymentIban: "DE12500105170648489890",
      ownIbans: ["DE89370400440532013000"],
    });
    expect(result).toBe("incoming");
  });

  it("is incoming when the payment IBAN is present and there are no own IBANs at all", () => {
    const result = resolveReminderDirection({
      modelDirection: "sent",
      paymentIban: "DE12500105170648489890",
      ownIbans: [],
    });
    expect(result).toBe("incoming");
  });

  it("normalizes IBANs before comparing: spacing and case differences on either side still match", () => {
    const result = resolveReminderDirection({
      modelDirection: null,
      paymentIban: "de89 3704 0044 0532 0130 00",
      ownIbans: ["DE89370400440532013000"],
    });
    expect(result).toBe("outgoing");
  });

  it("falls back to the model's own answer 'received' when there is no payment IBAN at all", () => {
    const result = resolveReminderDirection({ modelDirection: "received", paymentIban: null, ownIbans: ["DE89370400440532013000"] });
    expect(result).toBe("incoming");
  });

  it("falls back to the model's own answer 'sent' when there is no payment IBAN at all", () => {
    const result = resolveReminderDirection({ modelDirection: "sent", paymentIban: null, ownIbans: [] });
    expect(result).toBe("outgoing");
  });

  it("is unknown when there is no payment IBAN and the model gave no answer either", () => {
    const result = resolveReminderDirection({ modelDirection: null, paymentIban: null, ownIbans: [] });
    expect(result).toBe("unknown");
  });

  it("prefers the payment IBAN over the model's own answer even when they disagree", () => {
    const result = resolveReminderDirection({
      modelDirection: "received",
      paymentIban: "DE89370400440532013000",
      ownIbans: ["DE89370400440532013000"],
    });
    expect(result).toBe("outgoing");
  });
});
