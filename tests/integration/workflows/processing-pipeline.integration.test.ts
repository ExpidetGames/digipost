// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1): uploads through the real
// `POST /api/documents` route handler (real Postgres + real MinIO), then runs the job runner
// directly (`runDueJobs`, not via HTTP - decisions/0016-processing-pipeline-and-ai.md) with
// the fake AI provider (no `MISTRAL_API_KEY` is set anywhere in this test environment, so the
// composition root binds the deterministic fakes automatically outside production). Proves
// the whole pipeline end to end: document reaches `done`, the searchable PDF object exists,
// full-text search finds a word from the fake OCR text.
// `next/cache` is mocked because the upload route calls `revalidatePath("/dashboard")` on
// success; calling the exported `POST` directly, outside Next's own request dispatch, has
// no request-scoped cache context for the real implementation to write to.
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: async () => currentUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleContactRepository, createDrizzleDocumentContactRepository } from "@/persistence/repositories/drizzle/contacts-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { getObjectStorage } from "@/platform/object-storage/server";
import { runDueJobs } from "@/platform/jobs/server";

import { POST } from "@/app/api/documents/route";

const PNG_1X1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// A second, distinct 1x1 PNG (an OPAQUE RED pixel - the sample above happens to also embed
// as plain black once pdf-lib flattens its grayscale+alpha channel, so an opaque, clearly
// different color was picked deliberately, verified to produce a different embedded pixel
// value) - F1b's exact-duplicate check (`createFromUpload`'s `fileHash`) now rejects a second
// upload whose assembled PDF is byte-identical to an already-stored one, so a test simulating
// two genuinely different physical scans from the same sender must use different image bytes,
// exactly like two real photos never come out byte-identical.
const PNG_1X1_VARIANT_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function pngFile(name = "seite-1.png", base64 = PNG_1X1_B64): File {
  return new File([Buffer.from(base64, "base64")], name, { type: "image/png" });
}

async function createTestUser(): Promise<{ id: string; email: string }> {
  const email = `${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Processing Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

async function createWorkspaceForUser(userId: string, name: string) {
  const workspaceRepo = createDrizzleWorkspaceRepository(getDb());
  const memberRepo = createDrizzleWorkspaceMemberRepository(getDb());
  const workspace = await workspaceRepo.create({ name });
  await memberRepo.create({ workspaceId: workspace.id, userId, role: "admin" });
  return workspace;
}

function postRequest(formData: FormData): Request {
  return new Request("http://localhost/api/documents", { method: "POST", body: formData });
}

describe("processing pipeline (real Postgres + MinIO, fake AI)", () => {
  it("uploads, processes, and becomes searchable", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Processing Flow GmbH");

    const formData = new FormData();
    formData.append("files", pngFile());
    formData.append("fileName", "rechnung-telekom.pdf");

    const uploadResponse = await POST(postRequest(formData), {} as never);
    expect(uploadResponse.status).toBe(201);
    const { documentId } = (await uploadResponse.json()) as { documentId: string };

    // The upload route's own `after()` never runs in a test (no real response lifecycle) -
    // call the runner directly instead, exactly like the cron sweeper or the UI "kick" would.
    const result = await runDueJobs({ workspaceId: workspace.id, limit: 5 });
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const processed = await documentRepo.findById(workspace.id, documentId);
    expect(processed?.status).toBe("done");
    expect(processed?.errorCode).toBeNull();
    expect(processed?.searchablePdfKey).toBeTruthy();
    expect(processed?.ocrText).toContain("Telekom Deutschland GmbH");

    // The searchable PDF object actually exists in MinIO.
    const searchableBytes = await getObjectStorage().getObject(processed!.searchablePdfKey!);
    expect(searchableBytes.byteLength).toBeGreaterThan(0);

    // Full-text search (websearch_to_tsquery('german', ...)) finds a word from the fake OCR
    // text via the generated search_vector column.
    const found = await documentRepo.list(workspace.id, { q: "Telekom", page: 1, pageSize: 10 });
    expect(found.items.map((d) => d.id)).toContain(documentId);
  });

  it("runDueJobs with a limit of 0 due jobs for an unrelated workspace processes nothing", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Idle GmbH");

    const result = await runDueJobs({ workspaceId: workspace.id, limit: 5 });
    expect(result.processed).toBe(0);
  });

  it("keeps app_runtime's usage/quota tracking intact through the pipeline (workspace-scoped)", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Quota Tracking GmbH");

    const formData = new FormData();
    formData.append("files", pngFile());
    formData.append("fileName", "mahnung.pdf");
    const uploadResponse = await POST(postRequest(formData), {} as never);
    expect(uploadResponse.status).toBe(201);

    await runDueJobs({ workspaceId: workspace.id, limit: 5 });

    const documentRepo = createDrizzleDocumentRepository(getDb());
    expect(await documentRepo.countByWorkspace(workspace.id)).toBe(1);
  });

  // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): direction, invoice
  // fields, and contact linking against REAL Postgres - not just the fakes in
  // `src/persistence/tests/documents-use-cases.test.ts` - proving the whole vertical slice
  // (upload route -> job runner -> use case -> repositories -> real tables) together.
  it("ends processing with direction incoming, invoice fields set, and an unverified linked sender contact", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Direction Flow GmbH");

    const formData = new FormData();
    formData.append("files", pngFile());
    formData.append("fileName", "rechnung-telekom.pdf");
    const uploadResponse = await POST(postRequest(formData), {} as never);
    expect(uploadResponse.status).toBe(201);
    const { documentId } = (await uploadResponse.json()) as { documentId: string };

    await runDueJobs({ workspaceId: workspace.id, limit: 5 });

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const processed = await documentRepo.findById(workspace.id, documentId);
    expect(processed?.status).toBe("done");
    expect(processed?.direction).toBe("incoming");
    expect(processed?.invoiceNumber).toBe("4711");
    expect(processed?.totalAmountCents).toBe(4999);
    expect(processed?.currency).toBe("EUR");
    expect(processed?.dueDate).toBe("2026-04-05");
    expect(processed?.paymentIban).toBe("DE12500105170648489890");

    const contactRepo = createDrizzleContactRepository(getDb());
    const documentContactRepo = createDrizzleDocumentContactRepository(getDb());
    const contacts = await contactRepo.listAllForWorkspace(workspace.id);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ name: "Telekom Deutschland GmbH", vatId: "DE813298342", source: "auto", verifiedAt: null });

    const links = await documentContactRepo.listForDocument(workspace.id, documentId);
    expect(links).toEqual([expect.objectContaining({ contactId: contacts[0]!.id, role: "sender" })]);
  });

  it("links a second document from the same sender to the same contact, not a duplicate", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Repeat Sender GmbH");

    // Both uploads declare the identical `fileName` (the fake OCR/analyzer's own key) -
    // deterministically the same "sender" both times, proving the second upload matches
    // the contact `upsertFromExtraction` already created rather than creating a duplicate.
    // Each uses a DIFFERENT source image (a real second scan is never byte-identical to the
    // first) so F1b's exact-duplicate check (`fileHash`) does not itself reject the second
    // upload - that specific rejection has its own coverage in
    // `tests/integration/http/documents-upload.integration.test.ts`.
    const images = [PNG_1X1_B64, PNG_1X1_VARIANT_B64];
    for (const image of images) {
      const formData = new FormData();
      formData.append("files", pngFile("seite-1.png", image));
      formData.append("fileName", "rechnung-telekom.pdf");
      const uploadResponse = await POST(postRequest(formData), {} as never);
      expect(uploadResponse.status).toBe(201);
    }

    await runDueJobs({ workspaceId: workspace.id, limit: 5 });

    const contactRepo = createDrizzleContactRepository(getDb());
    const contacts = await contactRepo.listAllForWorkspace(workspace.id);
    expect(contacts).toHaveLength(1);

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const documentContactRepo = createDrizzleDocumentContactRepository(getDb());
    const list = await documentRepo.list(workspace.id, { page: 1, pageSize: 10 });
    expect(list.items).toHaveLength(2);
    const linksPerDocument = await Promise.all(list.items.map((d) => documentContactRepo.listForDocument(workspace.id, d.id)));
    for (const links of linksPerDocument) {
      expect(links).toEqual([expect.objectContaining({ contactId: contacts[0]!.id, role: "sender" })]);
    }
  });

  it("marks a document outgoing and links a recipient contact when it names the workspace's own company as sender", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Muster Werkstatt GmbH");

    const workspaceRepo = createDrizzleWorkspaceRepository(getDb());
    await workspaceRepo.updateCompanyProfile(workspace.id, {
      companyAddressLine1: "Hauptstr. 1",
      companyAddressLine2: null,
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyCountry: "DE",
      companyVatId: "DE111222333",
      // decisions/0034-extended-company-profile.md (H1): this test only exercises the
      // original company-profile fields above, so the extended ones stay at their "nothing
      // filled in" default.
      companyAliases: [],
      companyIbans: [],
      companyDomains: [],
      companyTaxNumber: null,
      companyRegisterCourt: null,
      companyRegisterNumber: null,
      companyProfileText: null,
    });

    const formData = new FormData();
    formData.append("files", pngFile());
    formData.append("fileName", "ausgangsrechnung.pdf");
    const uploadResponse = await POST(postRequest(formData), {} as never);
    expect(uploadResponse.status).toBe(201);
    const { documentId } = (await uploadResponse.json()) as { documentId: string };

    await runDueJobs({ workspaceId: workspace.id, limit: 5 });

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const processed = await documentRepo.findById(workspace.id, documentId);
    expect(processed?.status).toBe("done");
    expect(processed?.direction).toBe("outgoing");

    const contactRepo = createDrizzleContactRepository(getDb());
    const documentContactRepo = createDrizzleDocumentContactRepository(getDb());
    const contacts = await contactRepo.listAllForWorkspace(workspace.id);
    // The workspace's own company must never become a contact of itself
    // (decisions/0019-contacts.md's own-company exclusion), even though the fake analyzer
    // extracted it as a party - enforced in code via `isOwnCompany`, never trusted from the
    // model.
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.name).not.toBe("Muster Werkstatt GmbH");
    expect(contacts[0]!.name).toBe("Muster Kunde GmbH");

    const links = await documentContactRepo.listForDocument(workspace.id, documentId);
    expect(links).toEqual([expect.objectContaining({ contactId: contacts[0]!.id, role: "recipient" })]);
  });
});
