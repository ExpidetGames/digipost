import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { detectEncoding, sniffFileKind } from "../core/file-kind";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

describe("sniffFileKind", () => {
  it("recognizes a PDF by its magic bytes", () => {
    expect(sniffFileKind(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]))).toBe("pdf");
  });

  it("recognizes a JPEG by its magic bytes", () => {
    expect(sniffFileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("jpeg");
  });

  it("recognizes a PNG by its magic bytes", () => {
    expect(sniffFileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
  });

  it("recognizes XML with a prolog", () => {
    expect(sniffFileKind(bytesOf('<?xml version="1.0"?>\n<Document></Document>'))).toBe("xml");
  });

  it("recognizes XML with only a root element (no prolog)", () => {
    expect(sniffFileKind(bytesOf("<Document xmlns=\"urn:example\">\n  <Child/>\n</Document>"))).toBe("xml");
  });

  it("recognizes XML with a UTF-8 BOM", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = bytesOf('<?xml version="1.0"?><Document/>');
    const withBom = new Uint8Array(bom.length + body.length);
    withBom.set(bom);
    withBom.set(body, bom.length);
    expect(sniffFileKind(withBom)).toBe("xml");
  });

  it("recognizes a comma-delimited CSV", () => {
    const csv = "a,b,c\n1,2,3\n4,5,6\n7,8,9\n";
    expect(sniffFileKind(bytesOf(csv))).toBe("csv");
  });

  it("recognizes a semicolon-delimited CSV", () => {
    const csv = "Buchungsdatum;Betrag;Waehrung\n01.08.2026;100,00;EUR\n02.08.2026;-50,00;EUR\n";
    expect(sniffFileKind(bytesOf(csv))).toBe("csv");
  });

  it("recognizes a tab-delimited TSV", () => {
    const tsv = "a\tb\tc\n1\t2\t3\n4\t5\t6\n";
    expect(sniffFileKind(bytesOf(tsv))).toBe("tsv");
  });

  it("returns unknown for a single line of text with no consistent delimiter", () => {
    expect(sniffFileKind(bytesOf("just a single line of prose"))).toBe("unknown");
  });

  it("returns unknown for random binary data", () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
    expect(sniffFileKind(bytes)).toBe("unknown");
  });

  it("returns unknown for an empty buffer", () => {
    expect(sniffFileKind(new Uint8Array(0))).toBe("unknown");
  });

  // decisions/0048-app-store-reports.md: both real reports used to sniff as "unknown" - the
  // Apple report's title/footer rows have a different comma count than its data rows, and the
  // Google report's quoted "Jan 5, 2025" comma was counted as a delimiter by the old,
  // quote-unaware, "every line must agree" heuristic.
  it("recognizes the real Apple payment summary despite its title/footer rows' different field counts", () => {
    expect(sniffFileKind(fixtureBytes("apple-payment-summary.csv"))).toBe("csv");
  });

  it("recognizes the real Google Play earnings report despite the quoted 'Jan 5, 2025' comma", () => {
    expect(sniffFileKind(fixtureBytes("google-play-earnings.csv"))).toBe("csv");
  });

  it("does not let a quoted comma inflate the delimiter count for an ordinary quoted CSV", () => {
    const csv = 'a,b,c\n"1, one","2","3"\n"4, four","5","6"\n"7, seven","8","9"\n';
    expect(sniffFileKind(bytesOf(csv))).toBe("csv");
  });

  it("accepts a delimiter only three sampled lines agree on (a differently-shaped preamble/footer)", () => {
    const csv = "title only\n\na,b,c\n1,2,3\n4,5,6\n5,6,7\n\nfooter,,\n";
    expect(sniffFileKind(bytesOf(csv))).toBe("csv");
  });

  it("still returns unknown when fewer than three lines ever agree on the same delimiter", () => {
    const csv = "a,b,c\nnope\nnope\nnope\n";
    expect(sniffFileKind(bytesOf(csv))).toBe("unknown");
  });
});

describe("detectEncoding", () => {
  it("detects plain UTF-8", () => {
    expect(detectEncoding(bytesOf("Müller GmbH, Straße 1"))).toBe("utf-8");
  });

  it("falls back to windows-1252 when a byte sequence is not valid UTF-8", () => {
    // 0xE4 alone is "ä" in Windows-1252 but an invalid/incomplete UTF-8 sequence on its own.
    const bytes = new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]); // "M", 0xFC ("ü"), "ller"
    expect(detectEncoding(bytes)).toBe("windows-1252");
  });
});
