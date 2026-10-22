// The E-Mail-Eingang end to end below the browser (decisions/0075-email-intake.md): the real
// `POST /api/webhooks/resend` route with real Svix signatures, real Postgres, real MinIO and the
// `process-inbound-email` job, with the deterministic fake `InboundMailProvider`
// (`docker/compose.test.yml` sets `INBOUND_MAIL_PROVIDER=fake`, `INBOUND_EMAIL_DOMAIN` and a
// dummy `RESEND_WEBHOOK_SECRET`). `after()` cannot run outside Next's request dispatch, so each
// test runs the job itself through the use case.
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import { and, eq, sql } from "drizzle-orm";
import { Webhook } from "svix";
import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/webhooks/resend/route";
import { generateInboundToken } from "@/modules/mail-intake";
import { getRequestServices } from "@/persistence/composition/request-services";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { documents } from "@/persistence/schema/documents";
import { jobs } from "@/persistence/schema/jobs";
import { inboundEmails } from "@/persistence/schema/mail-intake";
import { generatedFakePdf, registerFakeInboundEmail, resetFakeInboundMailForTests, type FakeInboundAttachment } from "@/platform/inbound-mail/server";

const DOMAIN = process.env.INBOUND_EMAIL_DOMAIN ?? "inbox.digipost.test";
const SECRET = process.env.RESEND_WEBHOOK_SECRET ?? "";
const db = getDb();

afterEach(() => resetFakeInboundMailForTests());

// --- fixtures ----------------------------------------------------------------------------

async function createAdmin(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await db.insert(user).values({ name: "Mail Test", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert user");
  return { id: row.id, email };
}

async function createWorkspace(label: string, tier: "free" | "starter" = "starter") {
  const admin = await createAdmin(label);
  const workspace = await createDrizzleWorkspaceRepository(db).create({ name: `${label} GmbH` });
  if (tier !== "free") await db.execute(sql`update workspaces set tier = ${tier} where id = ${workspace.id}`);
  await createDrizzleWorkspaceMemberRepository(db).create({ workspaceId: workspace.id, userId: admin.id, role: "admin" });
  const settings = await getRequestServices().mailIntake.getSettings(workspace.id);
  if (!settings.address) throw new Error("INBOUND_EMAIL_DOMAIN is not set for the integration run");
  return { workspace, admin, address: settings.address };
}

function pdf(label: string): FakeInboundAttachment {
  return { fileName: `${label}.pdf`, contentType: "application/pdf", bytes: generatedFakePdf(`${label}-${randomUUID()}`) };
}

/** A valid, uncompressed RGB PNG of random pixels: large enough (> 20 KB) not to be skipped as
 * a signature logo, unique per call. */
function photoPng(): FakeInboundAttachment {
  const width = 100;
  const height = 100;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < raw.length; i++) raw[i] = i % (width * 3 + 1) === 0 ? 0 : Math.floor(Math.random() * 256);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { fileName: "foto.png", contentType: "image/png", bytes: new Uint8Array(png) };
}

function webhookRequest(body: unknown, secret = SECRET): Request {
  const payload = JSON.stringify(body);
  const at = new Date();
  const id = `msg_${randomUUID()}`;
  return new Request("http://localhost/api/webhooks/resend", {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, at, payload),
    },
  });
}

function receivedEvent(input: { emailId: string; from: string; to: string[]; cc?: string[]; subject?: string }) {
  return {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: input.emailId,
      created_at: new Date().toISOString(),
      from: input.from,
      to: input.to,
      cc: input.cc ?? [],
      bcc: [],
      received_for: [],
      message_id: `<${input.emailId}@example.test>`,
      subject: input.subject ?? "Rechnung",
      attachments: [],
    },
  };
}

async function postMail(input: Parameters<typeof receivedEvent>[0]): Promise<Response> {
  return POST(webhookRequest(receivedEvent(input)), {} as never);
}

async function rowsFor(emailId: string) {
  return db.select().from(inboundEmails).where(eq(inboundEmails.providerEmailId, emailId));
}

async function processAll(emailId: string): Promise<void> {
  for (const row of await rowsFor(emailId)) {
    await getRequestServices().mailIntake.processInboundEmail({ workspaceId: row.workspaceId, inboundEmailId: row.id });
  }
}

async function singleRow(emailId: string) {
  const rows = await rowsFor(emailId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function documentCount(workspaceId: string): Promise<number> {
  return createDrizzleDocumentRepository(db).countByWorkspace(workspaceId);
}

async function jobsOfKind(workspaceId: string, kind: string) {
  return db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.kind, kind)));
}

async function countInboundRowsSince(since: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(inboundEmails).where(sql`${inboundEmails.createdAt} >= ${since}`);
  return row?.n ?? 0;
}

// --- tests -------------------------------------------------------------------------------

describe("POST /api/webhooks/resend + process-inbound-email (real Postgres + MinIO, fake provider)", () => {
  it("imports a PDF and a photo from a member's mail as two documents", async () => {
    const { workspace, admin, address } = await createWorkspace("pdf-and-photo");
    const emailId = randomUUID();
    registerFakeInboundEmail(emailId, [pdf("rechnung"), photoPng(), { ...photoPng(), fileName: "logo.png", reportedSize: 2_000 }]);

    const response = await postMail({ emailId, from: `Chef <${admin.email}>`, to: [address] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", accepted: 1 });
    expect(await jobsOfKind(workspace.id, "process-inbound-email")).toHaveLength(1);

    await processAll(emailId);

    const row = await singleRow(emailId);
    expect(row).toMatchObject({ status: "processed", reasonCode: null, fromAddress: admin.email, subject: "Rechnung" });
    expect(row.attachments.map((a) => a.outcome)).toEqual(["imported", "imported", "skipped_small"]);
    expect(await documentCount(workspace.id)).toBe(2);
    const created = await db.select().from(documents).where(eq(documents.workspaceId, workspace.id));
    expect(created.every((doc) => doc.uploadedByUserId === null)).toBe(true);
    expect(created.map((doc) => doc.originalFileName).sort()).toEqual(["foto.png", "rechnung.pdf"]);
    // Every new document goes through the ordinary processing pipeline.
    expect(await jobsOfKind(workspace.id, "process-document")).toHaveLength(2);
    // The document detail's "Per E-Mail von" source.
    const imported = row.attachments[0]!.documentId!;
    expect(await getRequestServices().mailIntake.getEmailSourceForDocument(workspace.id, imported)).toEqual({ fromAddress: admin.email });
  });

  it("treats a webhook replay as already received: no second row, no second job", async () => {
    const { workspace, admin, address } = await createWorkspace("replay");
    const emailId = randomUUID();
    const event = { emailId, from: admin.email, to: [address] };

    expect((await postMail(event)).status).toBe(200);
    const replay = await postMail(event);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "ok", accepted: 0 });
    expect(await rowsFor(emailId)).toHaveLength(1);
    expect(await jobsOfKind(workspace.id, "process-inbound-email")).toHaveLength(1);

    // A second job run on an already processed mail changes nothing either.
    await processAll(emailId);
    await processAll(emailId);
    expect(await documentCount(workspace.id)).toBe(1);
  });

  it("an exact duplicate attachment counts as already present, not as a failure", async () => {
    const { workspace, admin, address } = await createWorkspace("duplicate-attachment");
    const same = pdf("gleich");
    const first = randomUUID();
    const second = randomUUID();
    registerFakeInboundEmail(first, [same]);
    registerFakeInboundEmail(second, [same]);

    await postMail({ emailId: first, from: admin.email, to: [address] });
    await postMail({ emailId: second, from: admin.email, to: [address] });
    await processAll(first);
    await processAll(second);

    expect(await singleRow(second)).toMatchObject({ status: "processed" });
    expect((await singleRow(second)).attachments[0]).toMatchObject({ outcome: "duplicate" });
    expect(await documentCount(workspace.id)).toBe(1);
  });

  describe("strict recipient matching: nothing is stored for a mail that is not ours", () => {
    it("drops a recipient on a foreign domain", async () => {
      const { address } = await createWorkspace("foreign-domain");
      const token = address.split("@")[0]!;
      const since = new Date();
      const response = await postMail({ emailId: randomUUID(), from: "a@lieferant.de", to: [`${token}@example.de`] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", accepted: 0 });
      expect(await countInboundRowsSince(since)).toBe(0);
    });

    it("drops a well-formed address on our domain with an unknown token", async () => {
      const since = new Date();
      const response = await postMail({ emailId: randomUUID(), from: "a@lieferant.de", to: [`post-${generateInboundToken()}@${DOMAIN}`] });
      expect(response.status).toBe(200);
      expect(await countInboundRowsSince(since)).toBe(0);
    });

    it("drops a mail to a disabled address", async () => {
      const { workspace, admin, address } = await createWorkspace("disabled");
      await getRequestServices().mailIntake.setEnabled(workspace.id, false);
      const since = new Date();
      const response = await postMail({ emailId: randomUUID(), from: admin.email, to: [address] });
      expect(response.status).toBe(200);
      expect(await countInboundRowsSince(since)).toBe(0);
      expect(await jobsOfKind(workspace.id, "process-inbound-email")).toHaveLength(0);
    });

    it("drops a malformed local part on our domain", async () => {
      const { address } = await createWorkspace("malformed");
      const token = address.split("@")[0]!.slice("post-".length);
      const since = new Date();
      for (const local of [`post-${token}+rechnung`, `post-${token}x`, token, `info`, `post_${token}`]) {
        expect((await postMail({ emailId: randomUUID(), from: "a@lieferant.de", to: [`${local}@${DOMAIN}`] })).status).toBe(200);
      }
      expect(await countInboundRowsSince(since)).toBe(0);
    });

    it("processes only the valid workspace when one recipient is foreign and one is ours", async () => {
      const { workspace, admin, address } = await createWorkspace("mixed-recipients");
      const emailId = randomUUID();
      const response = await postMail({ emailId, from: admin.email, to: ["someone@example.de", `post-${generateInboundToken()}@other.example`], cc: [address] });
      expect(await response.json()).toEqual({ status: "ok", accepted: 1 });
      const row = await singleRow(emailId);
      expect(row.workspaceId).toBe(workspace.id);
    });

    it("ignores other event types without storing anything", async () => {
      const since = new Date();
      const response = await POST(webhookRequest({ type: "email.delivered", data: { email_id: randomUUID() } }), {} as never);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ignored" });
      expect(await countInboundRowsSince(since)).toBe(0);
    });
  });

  it("refuses a bad signature with 401 and stores nothing", async () => {
    const { address } = await createWorkspace("bad-signature");
    const since = new Date();
    const otherSecret = `whsec_${Buffer.from("not-the-configured-secret-0123456789").toString("base64")}`;
    const response = await POST(webhookRequest(receivedEvent({ emailId: randomUUID(), from: "a@b.de", to: [address] }), otherSecret), {} as never);
    expect(response.status).toBe(401);
    expect(await countInboundRowsSince(since)).toBe(0);
  });

  it("delivers one mail addressed to two workspaces to both, one row and one job each", async () => {
    const a = await createWorkspace("multi-a");
    const b = await createWorkspace("multi-b");
    await getRequestServices().mailIntake.setSenderPolicy(a.workspace.id, "anyone");
    await getRequestServices().mailIntake.setSenderPolicy(b.workspace.id, "anyone");
    const emailId = randomUUID();
    registerFakeInboundEmail(emailId, [pdf("geteilt")]);

    const response = await postMail({ emailId, from: "x@lieferant.de", to: [a.address, b.address] });
    expect(await response.json()).toEqual({ status: "ok", accepted: 2 });
    await processAll(emailId);

    expect(await documentCount(a.workspace.id)).toBe(1);
    expect(await documentCount(b.workspace.id)).toBe(1);
  });

  describe("sender policy", () => {
    it("rejects a sender that is not allowed, notifies the admin once, and throttles the next one", async () => {
      const { workspace, address } = await createWorkspace("not-allowed");
      const first = randomUUID();
      const second = randomUUID();
      await postMail({ emailId: first, from: "fremd@spam.example", to: [address] });
      await postMail({ emailId: second, from: "fremd@spam.example", to: [address] });
      await processAll(first);
      await processAll(second);

      expect(await singleRow(first)).toMatchObject({ status: "rejected", reasonCode: "sender_not_allowed" });
      expect((await singleRow(first)).notifiedAt).not.toBeNull();
      expect(await singleRow(second)).toMatchObject({ status: "rejected", reasonCode: "sender_not_allowed", notifiedAt: null });
      expect(await jobsOfKind(workspace.id, "send-mail-intake-notification")).toHaveLength(1);
      expect(await documentCount(workspace.id)).toBe(0);

      // The notification job itself renders and sends through the real SMTP path.
      await getRequestServices().jobs.runDue({ workspaceId: workspace.id, limit: 5 });
      const [notification] = await jobsOfKind(workspace.id, "send-mail-intake-notification");
      expect(notification).toMatchObject({ status: "done" });
    });

    it("accepts an allowlisted domain (and its subdomain) with passing authentication", async () => {
      const { workspace, address } = await createWorkspace("allow-domain");
      await getRequestServices().mailIntake.addAllowedSender({ workspaceId: workspace.id, value: "lieferant.de", userId: null });
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [pdf("lieferant")]);

      await postMail({ emailId, from: "Buchhaltung <rechnung@mail.lieferant.de>", to: [address] });
      await processAll(emailId);

      expect(await singleRow(emailId)).toMatchObject({ status: "processed" });
      expect(await documentCount(workspace.id)).toBe(1);
    });

    it("rejects an allowlisted but unauthenticated (possibly forged) sender and notifies", async () => {
      const { workspace, address } = await createWorkspace("forged");
      await getRequestServices().mailIntake.addAllowedSender({ workspaceId: workspace.id, value: "lieferant.de", userId: null });
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [pdf("gefaelscht")], { authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } });

      await postMail({ emailId, from: "rechnung@lieferant.de", to: [address] });
      await processAll(emailId);

      expect(await singleRow(emailId)).toMatchObject({ status: "rejected", reasonCode: "sender_not_authenticated" });
      expect(await jobsOfKind(workspace.id, "send-mail-intake-notification")).toHaveLength(1);
      expect(await documentCount(workspace.id)).toBe(0);
    });

    it("under 'anyone' requires no authentication", async () => {
      const { workspace, address } = await createWorkspace("anyone");
      await getRequestServices().mailIntake.setSenderPolicy(workspace.id, "anyone");
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [pdf("offen")], { authentication: null });

      await postMail({ emailId, from: "irgendwer@example.com", to: [address] });
      await processAll(emailId);

      expect(await singleRow(emailId)).toMatchObject({ status: "processed" });
    });

    it("rejects silently when the provider's recipient list no longer holds the current address (rotated)", async () => {
      const { workspace, admin, address } = await createWorkspace("rotated");
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [pdf("alt")], { recipients: [address] });
      await postMail({ emailId, from: admin.email, to: [address] });
      await getRequestServices().mailIntake.regenerateAddress(workspace.id);

      await processAll(emailId);

      expect(await singleRow(emailId)).toMatchObject({ status: "rejected", reasonCode: "recipient_not_matched", notifiedAt: null });
      expect(await jobsOfKind(workspace.id, "send-mail-intake-notification")).toHaveLength(0);
    });
  });

  describe("attachments and limits", () => {
    it("rejects a mail without a supported attachment and notifies", async () => {
      const { workspace, admin, address } = await createWorkspace("unsupported");
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [{ fileName: "notiz.txt", contentType: "text/plain", bytes: new TextEncoder().encode("Hallo, nur Text.") }]);

      await postMail({ emailId, from: admin.email, to: [address] });
      await processAll(emailId);

      const row = await singleRow(emailId);
      expect(row).toMatchObject({ status: "rejected", reasonCode: "no_supported_attachment" });
      expect(row.attachments[0]).toMatchObject({ outcome: "unsupported" });
      expect(await jobsOfKind(workspace.id, "send-mail-intake-notification")).toHaveLength(1);
    });

    it("rejects a mail without any attachment", async () => {
      const { admin, address } = await createWorkspace("no-attachment");
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, []);
      await postMail({ emailId, from: admin.email, to: [address] });
      await processAll(emailId);
      expect(await singleRow(emailId)).toMatchObject({ status: "rejected", reasonCode: "no_supported_attachment" });
    });

    it("skips an attachment over 15 MB without downloading it", async () => {
      const { workspace, admin, address } = await createWorkspace("too-large");
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [{ ...pdf("riesig"), reportedSize: 16 * 1024 * 1024 }, pdf("normal")]);

      await postMail({ emailId, from: admin.email, to: [address] });
      await processAll(emailId);

      const row = await singleRow(emailId);
      expect(row.attachments.map((a) => a.outcome)).toEqual(["too_large", "imported"]);
      expect(await documentCount(workspace.id)).toBe(1);
    });

    it("processes at most 10 attachments per mail", async () => {
      const { workspace, admin, address } = await createWorkspace("eleven");
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, Array.from({ length: 11 }, (_, i) => pdf(`beleg-${i}`)));

      await postMail({ emailId, from: admin.email, to: [address] });
      await processAll(emailId);

      const row = await singleRow(emailId);
      expect(row.attachments.filter((a) => a.outcome === "imported")).toHaveLength(10);
      expect(row.attachments[10]).toMatchObject({ outcome: "over_limit" });
      expect(await documentCount(workspace.id)).toBe(10);
    });

    it("stops at the quota, records the rest, notifies, and completes without endless retries", async () => {
      const { workspace, admin, address } = await createWorkspace("quota", "free");
      const documentRepo = createDrizzleDocumentRepository(db);
      for (let i = 0; i < 19; i++) {
        await documentRepo.create({
          id: randomUUID(),
          workspaceId: workspace.id,
          uploadedByUserId: null,
          originalFileName: `seed-${i}.pdf`,
          mimeType: "application/pdf",
          pageCount: 1,
          sizeBytes: 10,
          storageKey: `workspaces/${workspace.id}/documents/${randomUUID()}/original.pdf`,
          fileHash: randomUUID(),
        });
      }
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [pdf("eins"), pdf("zwei"), pdf("drei")]);

      await postMail({ emailId, from: admin.email, to: [address] });
      await processAll(emailId);

      const row = await singleRow(emailId);
      expect(row).toMatchObject({ status: "processed", reasonCode: "quota_exceeded" });
      expect(row.attachments.map((a) => a.outcome)).toEqual(["imported", "quota_exceeded", "quota_exceeded"]);
      expect(await documentCount(workspace.id)).toBe(20);
      expect(await jobsOfKind(workspace.id, "send-mail-intake-notification")).toHaveLength(1);
    });

    it("retries after a partial success without importing anything twice", async () => {
      const { workspace, admin, address } = await createWorkspace("retry");
      const emailId = randomUUID();
      registerFakeInboundEmail(emailId, [pdf("erst"), { ...pdf("dann"), failuresBeforeSuccess: 1 }]);
      await postMail({ emailId, from: admin.email, to: [address] });
      const row = await singleRow(emailId);

      await expect(getRequestServices().mailIntake.processInboundEmail({ workspaceId: workspace.id, inboundEmailId: row.id })).rejects.toMatchObject({
        name: "TransientJobError",
      });
      const partial = await singleRow(emailId);
      expect(partial).toMatchObject({ status: "received", attempts: 1 });
      expect(partial.attachments.map((a) => a.outcome)).toEqual(["imported"]);
      expect(await documentCount(workspace.id)).toBe(1);

      await getRequestServices().mailIntake.processInboundEmail({ workspaceId: workspace.id, inboundEmailId: row.id });

      const done = await singleRow(emailId);
      expect(done).toMatchObject({ status: "processed", attempts: 2 });
      expect(done.attachments.map((a) => a.outcome)).toEqual(["imported", "imported"]);
      expect(await documentCount(workspace.id)).toBe(2);
    });

    it("marks the mail failed once the provider stays unavailable through the last attempt", async () => {
      const { workspace, admin, address } = await createWorkspace("unavailable");
      const emailId = `fake-unavailable-${randomUUID()}`;
      await postMail({ emailId, from: admin.email, to: [address] });
      const row = await singleRow(emailId);

      for (let attempt = 1; attempt < 4; attempt++) {
        await expect(getRequestServices().mailIntake.processInboundEmail({ workspaceId: workspace.id, inboundEmailId: row.id })).rejects.toBeTruthy();
      }
      await getRequestServices().mailIntake.processInboundEmail({ workspaceId: workspace.id, inboundEmailId: row.id });

      expect(await singleRow(emailId)).toMatchObject({ status: "failed", reasonCode: "provider_unavailable", attempts: 4 });
    });
  });
});
