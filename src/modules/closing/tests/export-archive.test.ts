import { describe, expect, it } from "vitest";

import { createClosingArchiveStream, type ClosingArchiveEntry } from "../server/export-archive";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("createClosingArchiveStream", () => {
  it("produces a real ZIP containing every entry's name", async () => {
    const entries: ClosingArchiveEntry[] = [
      { name: "uebersicht.xlsx", bytes: new TextEncoder().encode("workbook") },
      { name: "belege/2026-01-15_Telekom_aaaaaaaa.pdf", bytes: new TextEncoder().encode("%PDF-1.7") },
    ];
    const zip = await collect(
      createClosingArchiveStream(async function* () {
        yield* entries;
      }),
    );

    // Local file header signature, then both paths verbatim (stored uncompressed in the
    // central directory whatever the deflate level does to the payloads).
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zip.includes("uebersicht.xlsx")).toBe(true);
    expect(zip.includes("belege/2026-01-15_Telekom_aaaaaaaa.pdf")).toBe(true);
  });

  it("pulls one entry at a time, so only one document's bytes are ever in hand", async () => {
    const produced: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    async function* entries(): AsyncIterable<ClosingArchiveEntry> {
      for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        produced.push(name);
        yield { name, bytes: new Uint8Array(1024) };
        inFlight -= 1;
      }
    }

    await collect(createClosingArchiveStream(entries));
    expect(produced).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(maxInFlight).toBe(1);
  });

  it("destroys the stream when producing an entry fails, rather than hanging or finishing silently", async () => {
    async function* entries(): AsyncIterable<ClosingArchiveEntry> {
      yield { name: "ok.pdf", bytes: new Uint8Array(8) };
      throw new Error("object storage is down");
    }

    await expect(collect(createClosingArchiveStream(entries))).rejects.toThrow("object storage is down");
  });

  it("writes a valid, empty archive when there is nothing to export", async () => {
    const zip = await collect(createClosingArchiveStream(async function* () {}));
    // "End of central directory" record only - 22 bytes, the canonical empty ZIP.
    expect(zip).toHaveLength(22);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  });
});
