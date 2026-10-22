import { afterEach, describe, expect, it } from "vitest";

import { processIntakeUpload } from "@/modules/documents";
import { createFakeInboundMailProvider, generatedFakePdf, registerFakeInboundEmail, resetFakeInboundMailForTests } from "@/platform/inbound-mail/server";

afterEach(() => resetFakeInboundMailForTests());

describe("createFakeInboundMailProvider", () => {
  it("serves a generated PDF per unknown mail that the upload pipeline accepts, distinct per mail", async () => {
    const provider = createFakeInboundMailProvider();
    const [attachment] = await provider.listAttachments("mail-1");
    const bytes = await provider.downloadAttachment(attachment!, 1_000_000);

    const processed = await processIntakeUpload([bytes], 20);
    expect(processed).toMatchObject({ ok: true, data: { kind: "pdf_or_image", pageCount: 1 } });
    expect(Buffer.from(generatedFakePdf("mail-2")).equals(Buffer.from(bytes))).toBe(false);
  });

  it("serves registered attachments and simulates download failures", async () => {
    registerFakeInboundEmail("mail-3", [{ fileName: "a.pdf", contentType: "application/pdf", bytes: new Uint8Array([1]), failuresBeforeSuccess: 1 }]);
    const provider = createFakeInboundMailProvider();
    const [attachment] = await provider.listAttachments("mail-3");

    await expect(provider.downloadAttachment(attachment!, 10)).rejects.toMatchObject({ retryable: true });
    expect(Array.from(await provider.downloadAttachment(attachment!, 10))).toEqual([1]);
  });

  it("reports passing authentication by default, failing for a fake-unauthenticated id, or what was registered", async () => {
    const provider = createFakeInboundMailProvider();
    expect(await provider.getEmail("x")).toEqual({ recipients: null, authentication: { spf: "pass", dkim: "pass", dmarc: "pass" } });
    expect((await provider.getEmail("fake-unauthenticated-1")).authentication).toMatchObject({ dmarc: "fail" });
    registerFakeInboundEmail("y", [], { recipients: ["a@b.de"] });
    expect(await provider.getEmail("y")).toMatchObject({ recipients: ["a@b.de"] });
  });

  it("fails retryably for a fake-unavailable mail id", async () => {
    await expect(createFakeInboundMailProvider().listAttachments("fake-unavailable-1")).rejects.toMatchObject({ retryable: true });
  });
});
