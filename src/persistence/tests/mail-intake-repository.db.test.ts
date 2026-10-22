// Real Postgres (decisions/0075-email-intake.md): the E-Mail-Eingang's constraints and
// idempotency - lazy settings creation, globally unique tokens, the per-workspace allowlist,
// the `(provider_email_id, workspace_id)` idempotency key, workspace scoping, the notification
// throttle query and the jsonb document lookup.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { generateInboundToken } from "@/modules/mail-intake";
import { getDb } from "@/persistence/foundation/client";
import { isDbError } from "@/persistence/foundation/db-errors";
import { createDrizzleMailIntakeRepository } from "@/persistence/repositories/drizzle/mail-intake-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";

const db = getDb();
const repo = createDrizzleMailIntakeRepository(db);
const workspaces = createDrizzleWorkspaceRepository(db);

async function workspace(name = "Mail GmbH") {
  return workspaces.create({ name: `${name} ${randomUUID()}` });
}

function email(workspaceId: string, providerEmailId = randomUUID()) {
  return {
    workspaceId,
    providerEmailId,
    fromAddress: "rechnung@lieferant.de",
    subject: "Rechnung",
    messageId: null,
    receivedAt: new Date(),
    status: "received" as const,
    reasonCode: null,
  };
}

describe("createDrizzleMailIntakeRepository", () => {
  it("ensureSettings creates the row once and keeps the first token on later calls", async () => {
    const ws = await workspace();
    const first = await repo.ensureSettings(ws.id, generateInboundToken());
    const second = await repo.ensureSettings(ws.id, generateInboundToken());

    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
    expect(first).toMatchObject({ enabled: true, senderPolicy: "allowlist", tokenRotatedAt: null });
    expect(await repo.findSettingsByToken(first.token)).toMatchObject({ workspaceId: ws.id });
  });

  it("refuses the same token for two workspaces", async () => {
    const a = await workspace();
    const b = await workspace();
    const token = generateInboundToken();
    await repo.ensureSettings(a.id, token);
    const err = await repo.ensureSettings(b.id, token).catch((e: unknown) => e);
    expect(isDbError(err, "unique")).toBe(true);
  });

  it("updateSettings is scoped to the workspace", async () => {
    const a = await workspace();
    const b = await workspace();
    await repo.ensureSettings(a.id, generateInboundToken());
    const bSettings = await repo.ensureSettings(b.id, generateInboundToken());

    await repo.updateSettings(a.id, { enabled: false, senderPolicy: "anyone" });

    expect(await repo.findSettings(a.id)).toMatchObject({ enabled: false, senderPolicy: "anyone" });
    expect(await repo.findSettings(b.id)).toMatchObject({ enabled: true, senderPolicy: "allowlist", token: bSettings.token });
  });

  it("keeps the allowlist unique per workspace and scopes removal", async () => {
    const a = await workspace();
    const b = await workspace();
    const added = await repo.addAllowedSender({ workspaceId: a.id, kind: "domain", value: "lieferant.de", createdByUserId: null });
    expect(added).not.toBeNull();
    expect(await repo.addAllowedSender({ workspaceId: a.id, kind: "domain", value: "lieferant.de", createdByUserId: null })).toBeNull();
    expect(await repo.addAllowedSender({ workspaceId: b.id, kind: "domain", value: "lieferant.de", createdByUserId: null })).not.toBeNull();
    expect(await repo.countAllowedSenders(a.id)).toBe(1);

    expect(await repo.removeAllowedSender(b.id, added!.id)).toBe(false);
    expect(await repo.removeAllowedSender(a.id, added!.id)).toBe(true);
    expect(await repo.listAllowedSenders(a.id)).toEqual([]);
  });

  it("inserts an inbound mail once per (provider email id, workspace)", async () => {
    const a = await workspace();
    const b = await workspace();
    const providerEmailId = randomUUID();

    expect(await repo.insertInboundEmail(email(a.id, providerEmailId))).not.toBeNull();
    expect(await repo.insertInboundEmail(email(a.id, providerEmailId))).toBeNull();
    // The same mail addressed to a second workspace is its own row.
    expect(await repo.insertInboundEmail(email(b.id, providerEmailId))).not.toBeNull();
  });

  it("scopes reads and updates of inbound mails to the workspace", async () => {
    const a = await workspace();
    const b = await workspace();
    const row = (await repo.insertInboundEmail(email(a.id)))!;

    expect(await repo.findInboundEmail(b.id, row.id)).toBeNull();
    await repo.updateInboundEmail(b.id, row.id, { status: "rejected" });
    expect(await repo.findInboundEmail(a.id, row.id)).toMatchObject({ status: "received" });
    expect(await repo.listInboundEmails(b.id, 10)).toEqual([]);
  });

  it("finds a recent notification per reason only", async () => {
    const ws = await workspace();
    const row = (await repo.insertInboundEmail(email(ws.id)))!;
    const since = new Date(Date.now() - 60_000);
    expect(await repo.hasNotificationSince(ws.id, "sender_not_allowed", since)).toBe(false);

    await repo.updateInboundEmail(ws.id, row.id, { status: "rejected", reasonCode: "sender_not_allowed", notifiedAt: new Date() });

    expect(await repo.hasNotificationSince(ws.id, "sender_not_allowed", since)).toBe(true);
    expect(await repo.hasNotificationSince(ws.id, "quota_exceeded", since)).toBe(false);
    expect(await repo.hasNotificationSince(ws.id, "sender_not_allowed", new Date(Date.now() + 60_000))).toBe(false);
  });

  it("finds the mail that imported a document, never one that only saw it as a duplicate", async () => {
    const ws = await workspace();
    const documentId = randomUUID();
    const importing = (await repo.insertInboundEmail(email(ws.id)))!;
    const duplicate = (await repo.insertInboundEmail(email(ws.id)))!;
    await repo.updateInboundEmail(ws.id, importing.id, {
      attachments: [{ attachmentId: "1", fileName: "a.pdf", sizeBytes: 1, outcome: "imported", documentId }],
    });
    await repo.updateInboundEmail(ws.id, duplicate.id, {
      attachments: [{ attachmentId: "2", fileName: "b.pdf", sizeBytes: 1, outcome: "duplicate", documentId: randomUUID() }],
    });

    expect(await repo.findByDocumentId(ws.id, documentId)).toMatchObject({ id: importing.id });
    expect(await repo.findByDocumentId(ws.id, randomUUID())).toBeNull();
  });

  it("cascades every table from the workspace's deletion", async () => {
    const ws = await workspace();
    await repo.ensureSettings(ws.id, generateInboundToken());
    await repo.addAllowedSender({ workspaceId: ws.id, kind: "email", value: "a@b.de", createdByUserId: null });
    await repo.insertInboundEmail(email(ws.id));

    await workspaces.delete(ws.id);

    expect(await repo.findSettings(ws.id)).toBeNull();
    expect(await repo.listAllowedSenders(ws.id)).toEqual([]);
    expect(await repo.listInboundEmails(ws.id, 10)).toEqual([]);
  });
});
