// Every code the mail-intake UI can show resolves to German copy in `de.json`.
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";
import { ATTACHMENT_OUTCOMES, INBOUND_EMAIL_REASONS, INBOUND_EMAIL_STATUSES, MAIL_INTAKE_ACTION_ERROR_CODES, SENDER_POLICIES } from "@/modules/mail-intake";

describe("MailIntake messages", () => {
  const messages = de.MailIntake as unknown as Record<string, Record<string, unknown>>;

  it.each(MAIL_INTAKE_ACTION_ERROR_CODES)("errors.%s resolves", (code) => {
    expect(typeof messages.errors![code]).toBe("string");
  });
  it.each(INBOUND_EMAIL_STATUSES)("statuses.%s resolves", (code) => {
    expect(typeof messages.statuses![code]).toBe("string");
  });
  it.each(INBOUND_EMAIL_REASONS)("reasons.%s resolves", (code) => {
    expect(typeof messages.reasons![code]).toBe("string");
  });
  it.each(ATTACHMENT_OUTCOMES)("outcomes.%s resolves", (code) => {
    expect(typeof messages.outcomes![code]).toBe("string");
  });
  it.each(SENDER_POLICIES)("policies.%s has a label and a hint", (policy) => {
    expect(messages.policies![policy]).toMatchObject({ label: expect.any(String), hint: expect.any(String) });
  });
});
