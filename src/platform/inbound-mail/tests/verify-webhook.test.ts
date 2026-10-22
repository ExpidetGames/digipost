// Signature verification against payloads signed by `svix` itself, the same library Resend's
// signing side is built on. No network, no env: the secret is passed explicitly.
import { Webhook } from "svix";
import { describe, expect, it } from "vitest";

import { WebhookSignatureError } from "@/platform/inbound-mail";
import { verifyInboundWebhook } from "@/platform/inbound-mail/server";

const SECRET = `whsec_${Buffer.from("unit-test-webhook-secret-0123456789").toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.from("another-webhook-secret-9876543210").toString("base64")}`;

function signedHeaders(body: string, secret = SECRET, at = new Date()): Headers {
  const id = "msg_unit_test";
  const signature = new Webhook(secret).sign(id, at, body);
  return new Headers({ "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": signature });
}

describe("verifyInboundWebhook", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });

  it("accepts a correctly signed body", () => {
    expect(() => verifyInboundWebhook(body, signedHeaders(body), SECRET)).not.toThrow();
  });

  it("rejects a body signed with another secret", () => {
    expect(() => verifyInboundWebhook(body, signedHeaders(body, OTHER_SECRET), SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects a tampered body", () => {
    expect(() => verifyInboundWebhook(body.replace("e1", "e2"), signedHeaders(body), SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects missing signature headers", () => {
    expect(() => verifyInboundWebhook(body, new Headers(), SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    expect(() => verifyInboundWebhook(body, signedHeaders(body, SECRET, old), SECRET)).toThrow(WebhookSignatureError);
  });

  it("rejects everything when no secret is configured", () => {
    expect(() => verifyInboundWebhook(body, signedHeaders(body), "")).toThrow(WebhookSignatureError);
  });
});
