import { describe, expect, it } from "vitest";

import { createFakeOcrEngine } from "../core/fake-ocr-engine";

describe("createFakeOcrEngine", () => {
  const engine = createFakeOcrEngine();

  it("derives a Telekom invoice letter from rechnung-telekom.pdf, deterministically", async () => {
    const result = await engine.recognize({ pdfBytes: new Uint8Array(), fileName: "rechnung-telekom.pdf" });

    expect(result.pages).toHaveLength(1);
    const markdown = result.pages[0]!.markdown;
    expect(markdown).toContain("Telekom Deutschland GmbH");
    expect(markdown).toContain("Rechnungsnummer 4711");

    // Deterministic: calling it again with the same file name gives byte-identical output.
    const again = await engine.recognize({ pdfBytes: new Uint8Array(), fileName: "rechnung-telekom.pdf" });
    expect(again).toEqual(result);
  });

  it("produces one block per line of markdown", async () => {
    const result = await engine.recognize({ pdfBytes: new Uint8Array(), fileName: "rechnung-telekom.pdf" });
    const page = result.pages[0]!;
    const lineCount = page.markdown.split("\n\n").length;
    expect(page.blocks).toHaveLength(lineCount);
  });

  it("falls back to a generic letter for a file name with no recognized keyword", async () => {
    const result = await engine.recognize({ pdfBytes: new Uint8Array(), fileName: "scan-0001.pdf" });
    expect(result.pages[0]!.markdown).toContain("Unbekannter Absender");
  });

  it("picks a different template for a different keyword", async () => {
    const result = await engine.recognize({ pdfBytes: new Uint8Array(), fileName: "mahnung-inkasso.pdf" });
    expect(result.pages[0]!.markdown).toContain("Zahlungserinnerung");
  });

  it("includes page dimensions matching the block coordinate space", async () => {
    const result = await engine.recognize({ pdfBytes: new Uint8Array(), fileName: "rechnung-telekom.pdf" });
    const page = result.pages[0]!;
    expect(page.dimensions).not.toBeNull();
    for (const block of page.blocks ?? []) {
      expect(block.bottomRightX).toBeLessThanOrEqual(page.dimensions!.width);
      expect(block.bottomRightY).toBeLessThanOrEqual(page.dimensions!.height);
    }
  });
});
