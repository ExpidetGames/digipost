// The Resend adapter against an injected `fetch` (no network in unit tests).
import { describe, expect, it, vi } from "vitest";

import { INBOUND_MAIL_ERROR_CODES, InboundMailError } from "@/platform/inbound-mail";
import { createResendInboundMailProvider } from "@/platform/inbound-mail/server";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ITEM = {
  id: "att-1",
  filename: "rechnung.pdf",
  size: 1234,
  content_type: "application/pdf",
  content_disposition: "attachment",
  content_id: null,
  download_url: "https://cdn.resend.app/att-1?signature=abc",
  expires_at: "2026-10-22T12:00:00Z",
};

describe("createResendInboundMailProvider", () => {
  it("lists attachments with the bearer key and maps the fields", async () => {
    const fetchMock = vi.fn(async () => json({ object: "list", has_more: false, data: [ITEM] }));
    const provider = createResendInboundMailProvider({ apiKey: "re_key", fetch: fetchMock as unknown as typeof fetch });

    const list = await provider.listAttachments("email-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails/receiving/email-1/attachments",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer re_key" }) }),
    );
    expect(list).toEqual([
      { id: "att-1", fileName: "rechnung.pdf", sizeBytes: 1234, contentType: "application/pdf", contentDisposition: "attachment", downloadUrl: ITEM.download_url },
    ]);
  });

  it("retrieves recipients and authentication verdicts of a received mail", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () =>
      json({
        object: "email",
        id: "email-1",
        to: ["Post <post-abc@inbox-test.resend.app>"],
        cc: [],
        bcc: [],
        received_for: ["post-abc@inbox-test.resend.app"],
        from: "rechnung@lieferant.de",
        authentication: { spf: "pass", dkim: "Pass", dmarc: "pass" },
        html: "<p>secret body</p>",
      }),
    );
    const provider = createResendInboundMailProvider({ apiKey: "re_key", fetch: fetchMock as unknown as typeof fetch });

    const details = await provider.getEmail("email-1");

    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.resend.com/emails/receiving/email-1");
    expect(details).toEqual({
      recipients: ["Post <post-abc@inbox-test.resend.app>", "post-abc@inbox-test.resend.app"],
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    });
  });

  it("reports no authentication when the provider sends none", async () => {
    const provider = createResendInboundMailProvider({ apiKey: "k", fetch: (async () => json({ to: [] })) as unknown as typeof fetch });
    expect(await provider.getEmail("e")).toEqual({ recipients: [], authentication: null });
  });

  it("follows has_more with the last id as cursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ object: "list", has_more: true, data: [ITEM] }))
      .mockResolvedValueOnce(json({ object: "list", has_more: false, data: [{ ...ITEM, id: "att-2" }] }));
    const provider = createResendInboundMailProvider({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });

    const list = await provider.listAttachments("e");

    expect(list.map((item) => item.id)).toEqual(["att-1", "att-2"]);
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.resend.com/emails/receiving/e/attachments?after=att-1");
  });

  it.each([
    [429, INBOUND_MAIL_ERROR_CODES.rateLimited, true],
    [503, INBOUND_MAIL_ERROR_CODES.unavailable, true],
    [404, INBOUND_MAIL_ERROR_CODES.notFound, false],
    [401, INBOUND_MAIL_ERROR_CODES.unauthorized, false],
  ])("maps HTTP %i to %s (retryable: %s)", async (status, code, retryable) => {
    const provider = createResendInboundMailProvider({ apiKey: "k", fetch: (async () => json({}, status)) as unknown as typeof fetch });
    await expect(provider.listAttachments("e")).rejects.toMatchObject({ code, retryable });
  });

  it("treats a network failure as retryable", async () => {
    const provider = createResendInboundMailProvider({
      apiKey: "k",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(provider.listAttachments("e")).rejects.toMatchObject({ code: INBOUND_MAIL_ERROR_CODES.unavailable, retryable: true });
  });

  it("downloads without sending the API key and enforces the byte cap", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5])));
    const provider = createResendInboundMailProvider({ apiKey: "re_key", fetch: fetchMock as unknown as typeof fetch });
    const attachment = { id: "a", fileName: "a", sizeBytes: 5, contentType: null, contentDisposition: null, downloadUrl: "https://cdn/a" };

    expect(Array.from(await provider.downloadAttachment(attachment, 10))).toEqual([1, 2, 3, 4, 5]);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.stringify(init.headers ?? {})).not.toContain("re_key");

    const error = await provider.downloadAttachment(attachment, 3).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(InboundMailError);
    expect(error).toMatchObject({ code: INBOUND_MAIL_ERROR_CODES.tooLarge, retryable: false });
  });

  it("treats an expired download URL (403) as retryable, since the next attempt lists afresh", async () => {
    const provider = createResendInboundMailProvider({ apiKey: "k", fetch: (async () => new Response("", { status: 403 })) as unknown as typeof fetch });
    const attachment = { id: "a", fileName: "a", sizeBytes: 5, contentType: null, contentDisposition: null, downloadUrl: "https://cdn/a" };
    await expect(provider.downloadAttachment(attachment, 10)).rejects.toMatchObject({ retryable: true });
  });
});
