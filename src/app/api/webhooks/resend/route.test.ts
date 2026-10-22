// The webhook route's own access/parse-step unit test (STRUCTURE.md §7's `route.test.ts`
// convention): no DB, no network. `receiveInboundEmail` and `runDueJobs` are mocked; the real
// flow against Postgres/MinIO is `tests/integration/http/webhooks-resend.integration.test.ts`.
import { Webhook } from "svix";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";

const SECRET = `whsec_${Buffer.from("route-unit-test-secret-0123456789").toString("base64")}`;
const VALID = "a".repeat(32);

const receiveInboundEmail = vi.fn().mockResolvedValue({ workspaceIds: [], matched: 0, skipped: { foreignOrMalformed: 1, unknownToken: 0, disabled: 0 } });
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ mailIntake: { receiveInboundEmail } }),
}));
vi.mock("@/platform/jobs/server", () => ({ runDueJobs: vi.fn().mockResolvedValue({ processed: 0 }) }));

function stubEnv(configured: boolean): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/app");
  vi.stubEnv("BETTER_AUTH_SECRET", VALID);
  vi.stubEnv("SMTP_URL", "smtp://localhost:1025");
  vi.stubEnv("MAIL_FROM", "App <no-reply@example.com>");
  vi.stubEnv("CRON_SECRET", VALID);
  vi.stubEnv("S3_REGION", "us-east-1");
  vi.stubEnv("S3_BUCKET", "b");
  vi.stubEnv("S3_ACCESS_KEY_ID", "k");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "s");
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", configured ? "inbox-test.resend.app" : "");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", configured ? SECRET : "");
  resetServerEnvCacheForTests();
}

function signedRequest(body: string, secret = SECRET): Request {
  const at = new Date();
  const signature = new Webhook(secret).sign("msg_1", at, body);
  return new Request("http://localhost/api/webhooks/resend", {
    method: "POST",
    body,
    headers: { "svix-id": "msg_1", "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": signature },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCacheForTests();
  receiveInboundEmail.mockClear();
});

describe("POST /api/webhooks/resend", () => {
  it("answers 503 while the deployment has no domain/secret", async () => {
    stubEnv(false);
    const { POST } = await import("./route");
    const response = await POST(signedRequest("{}"), {} as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ errorCode: "not_configured" });
  });

  it("answers 401 for a bad signature and never reaches the use case", async () => {
    stubEnv(true);
    const { POST } = await import("./route");
    const other = `whsec_${Buffer.from("some-other-secret-abcdefghijklmn").toString("base64")}`;
    const response = await POST(signedRequest(JSON.stringify({ type: "email.received", data: {} }), other), {} as never);
    expect(response.status).toBe(401);
    expect(receiveInboundEmail).not.toHaveBeenCalled();
  });

  it("acknowledges and ignores other event types", async () => {
    stubEnv(true);
    const { POST } = await import("./route");
    const response = await POST(signedRequest(JSON.stringify({ type: "email.sent", data: {} })), {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ignored" });
    expect(receiveInboundEmail).not.toHaveBeenCalled();
  });

  it("answers 400 for a signed but malformed email.received event", async () => {
    stubEnv(true);
    const { POST } = await import("./route");
    const response = await POST(signedRequest(JSON.stringify({ type: "email.received", data: { from: "a@b.de" } })), {} as never);
    expect(response.status).toBe(400);
  });

  it("answers 200 when no recipient matches", async () => {
    stubEnv(true);
    const { POST } = await import("./route");
    const body = JSON.stringify({ type: "email.received", data: { email_id: "e1", from: "a@b.de", to: ["x@example.de"] } });
    const response = await POST(signedRequest(body), {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", accepted: 0 });
    expect(receiveInboundEmail).toHaveBeenCalledOnce();
  });
});
