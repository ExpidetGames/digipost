import { describe, expect, it } from "vitest";

import { sniffFileType } from "../core/magic-bytes";

describe("sniffFileType", () => {
  it("recognizes a PDF signature", () => {
    expect(sniffFileType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]))).toBe("pdf");
  });

  it("recognizes a JPEG signature", () => {
    expect(sniffFileType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("jpeg");
  });

  it("recognizes a PNG signature", () => {
    expect(sniffFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
  });

  it("returns null for an unsupported type (declared PDF but actually a GIF)", () => {
    expect(sniffFileType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
  });

  it("returns null for too-short input", () => {
    expect(sniffFileType(new Uint8Array([0x25]))).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(sniffFileType(new Uint8Array())).toBeNull();
  });

  it("never trusts a claimed extension - only the bytes matter", () => {
    // JPEG bytes named "invoice.pdf" by a malicious or confused client: still sniffed as jpeg.
    expect(sniffFileType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("jpeg");
  });
});
