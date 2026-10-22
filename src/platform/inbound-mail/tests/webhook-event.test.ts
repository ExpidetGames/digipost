import { describe, expect, it } from "vitest";

import { parseWebhookEvent } from "@/platform/inbound-mail";

// Resend's documented `email.received` example.
const EXAMPLE = {
  type: "email.received",
  created_at: "2026-02-22T23:41:12.126Z",
  data: {
    email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
    created_at: "2026-02-22T23:41:11.894Z",
    from: "onboarding@resend.dev",
    to: ["delivered@resend.dev"],
    bcc: [],
    cc: [],
    received_for: ["forwarded@example.com"],
    message_id: "<111-222-333@email.example.com>",
    subject: "Sending this example",
    attachments: [{ id: "2a0c9ce0", filename: "avatar.png", content_type: "image/png", content_disposition: "inline", content_id: "img001" }],
  },
};

describe("parseWebhookEvent", () => {
  it("reads Resend's documented example, merging every recipient field", () => {
    const parsed = parseWebhookEvent(JSON.stringify(EXAMPLE));
    expect(parsed).toEqual({
      kind: "email_received",
      email: {
        emailId: "56761188-7520-42d8-8898-ff6fc54ce618",
        from: "onboarding@resend.dev",
        recipients: ["delivered@resend.dev", "forwarded@example.com"],
        messageId: "<111-222-333@email.example.com>",
        subject: "Sending this example",
        receivedAt: new Date("2026-02-22T23:41:11.894Z"),
      },
    });
  });

  it("tolerates missing optional recipient fields", () => {
    const parsed = parseWebhookEvent(JSON.stringify({ type: "email.received", data: { email_id: "x", from: "a@b.de", to: ["c@d.de"] } }));
    expect(parsed).toMatchObject({ kind: "email_received", email: { recipients: ["c@d.de"], subject: null, receivedAt: null } });
  });

  it("ignores other event types", () => {
    expect(parseWebhookEvent(JSON.stringify({ type: "email.delivered", data: {} }))).toEqual({ kind: "ignored", type: "email.delivered" });
  });

  it("returns null for malformed input", () => {
    expect(parseWebhookEvent("not json")).toBeNull();
    expect(parseWebhookEvent(JSON.stringify({ data: {} }))).toBeNull();
    expect(parseWebhookEvent(JSON.stringify({ type: "email.received", data: { from: "a@b.de" } }))).toBeNull();
  });
});
