import { describe, expect, it } from "vitest";

import {
  assignBelegFileNames,
  AUSGANGSRECHNUNGEN_DIRECTORY,
  belegFileName,
  BELEGE_DIRECTORY,
  closingDirectoryFor,
  fileExtensionFor,
  slugifyFileNamePart,
} from "../core/file-names";

describe("slugifyFileNamePart", () => {
  it("transliterates German letters rather than dropping them", () => {
    expect(slugifyFileNamePart("Müller & Söhne GmbH")).toBe("Mueller-Soehne-GmbH");
    expect(slugifyFileNamePart("Straßenbau")).toBe("Strassenbau");
    expect(slugifyFileNamePart("Über Alles")).toBe("Ueber-Alles");
  });

  it("strips every character a filesystem, a shell or a ZIP reader could misread", () => {
    expect(slugifyFileNamePart("../../etc/passwd")).toBe("etc-passwd");
    expect(slugifyFileNamePart("a/b\\c:d*e?f\"g<h>i|j")).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(slugifyFileNamePart("Rechnung 2026.01.pdf")).toBe("Rechnung-2026-01-pdf");
    expect(slugifyFileNamePart("line\nbreak\ttab")).toBe("line-break-tab");
    // No leading/trailing separator survives, so nothing starts with a dot or a dash.
    expect(slugifyFileNamePart("   ...Anwalt...   ")).toBe("Anwalt");
  });

  it("falls back to a readable constant rather than producing an empty component", () => {
    expect(slugifyFileNamePart("")).toBe("beleg");
    expect(slugifyFileNamePart("***")).toBe("beleg");
    expect(slugifyFileNamePart("日本語")).toBe("beleg");
  });

  it("truncates a very long name without leaving a trailing separator", () => {
    const slug = slugifyFileNamePart("A".repeat(200));
    expect(slug).toHaveLength(60);
    const mixed = slugifyFileNamePart(`${"B".repeat(59)} tail`);
    expect(mixed).toBe("B".repeat(59));
  });
});

describe("fileExtensionFor", () => {
  it("keeps the extension the media type actually calls for, never 'everything is a PDF'", () => {
    expect(fileExtensionFor("application/pdf", "scan.pdf")).toBe("pdf");
    expect(fileExtensionFor("application/xml", "camt.xml")).toBe("xml");
    expect(fileExtensionFor("application/vnd.mt940", "auszug.sta")).toBe("mt940");
    expect(fileExtensionFor("text/csv", "PlayApps.csv")).toBe("csv");
    expect(fileExtensionFor("text/tab-separated-values", "report.tsv")).toBe("tsv");
    expect(fileExtensionFor("image/jpeg", "foto.JPG")).toBe("jpg");
  });

  it("ignores a charset parameter and is case-insensitive", () => {
    expect(fileExtensionFor("TEXT/CSV; charset=utf-8", "x")).toBe("csv");
  });

  it("falls back to the uploaded name's own extension, then to bin", () => {
    expect(fileExtensionFor("application/octet-stream", "beleg.Zip")).toBe("zip");
    expect(fileExtensionFor("application/octet-stream", "beleg")).toBe("bin");
  });
});

describe("belegFileName", () => {
  it("is date, name and a slice of the id", () => {
    expect(
      belegFileName({
        id: "a1b2c3d4-1111-2222-3333-444455556666",
        direction: "incoming",
        effectiveDate: "2026-01-15",
        name: "Bauwerk Generalbau",
        extension: "pdf",
      }),
    ).toBe("2026-01-15_Bauwerk-Generalbau_a1b2c3d4.pdf");
  });
});

describe("assignBelegFileNames", () => {
  it("keeps two documents of the same day with the same name apart", () => {
    const names = assignBelegFileNames([
      { id: "aaaaaaaa-0000-0000-0000-000000000001", direction: "incoming", effectiveDate: "2026-01-15", name: "Telekom", extension: "pdf" },
      { id: "bbbbbbbb-0000-0000-0000-000000000002", direction: null, effectiveDate: "2026-01-15", name: "Telekom", extension: "pdf" },
    ]);
    expect([...names.values()]).toEqual(["belege/2026-01-15_Telekom_aaaaaaaa.pdf", "belege/2026-01-15_Telekom_bbbbbbbb.pdf"]);
  });

  it("never yields the same path twice, even for a repeated id", () => {
    const names = assignBelegFileNames([
      { id: "cccccccc-0000-0000-0000-000000000003", direction: "incoming", effectiveDate: "2026-02-01", name: "Stadtwerke", extension: "pdf" },
      { id: "cccccccc-0000-0000-0000-000000000003", direction: "incoming", effectiveDate: "2026-02-01", name: "Stadtwerke", extension: "pdf" },
    ]);
    // The map keys collapse, but the names that were handed out did not collide.
    expect(names.get("cccccccc-0000-0000-0000-000000000003")).toBe("belege/2026-02-01_Stadtwerke_cccccccc-2.pdf");
  });

  it("puts an incoming or directionless document under belege/, with exactly one directory level", () => {
    const names = assignBelegFileNames([
      { id: "dddddddd-0000-0000-0000-000000000004", direction: null, effectiveDate: "2026-03-03", name: "../../escape", extension: "xml" },
    ]);
    const path = names.get("dddddddd-0000-0000-0000-000000000004")!;
    expect(path.startsWith("belege/")).toBe(true);
    expect(path.split("/")).toHaveLength(2);
    expect(path).toBe("belege/2026-03-03_escape_dddddddd.xml");
  });

  it("is empty for an empty period", () => {
    expect(assignBelegFileNames([]).size).toBe(0);
  });

  // decisions/0066: evidence the workspace ISSUED is a different thing from evidence it
  // received, and nine outgoing invoices among seventy incoming ones were unfindable.
  it("puts an outgoing document under ausgangsrechnungen/ and everything else under belege/", () => {
    const names = assignBelegFileNames([
      { id: "eeeeeeee-0000-0000-0000-000000000005", direction: "outgoing", effectiveDate: "2026-01-04", name: "Kunde AG", extension: "pdf" },
      { id: "ffffffff-0000-0000-0000-000000000006", direction: "incoming", effectiveDate: "2026-01-05", name: "Telekom", extension: "pdf" },
      { id: "99999999-0000-0000-0000-000000000007", direction: null, effectiveDate: "2026-01-06", name: "Kontoauszug", extension: "xml" },
    ]);
    expect(names.get("eeeeeeee-0000-0000-0000-000000000005")).toBe("ausgangsrechnungen/2026-01-04_Kunde-AG_eeeeeeee.pdf");
    expect(names.get("ffffffff-0000-0000-0000-000000000006")).toBe("belege/2026-01-05_Telekom_ffffffff.pdf");
    expect(names.get("99999999-0000-0000-0000-000000000007")).toBe("belege/2026-01-06_Kontoauszug_99999999.xml");
  });

  it("de-duplicates per folder: the same file name in the two folders is not a collision", () => {
    const sameId = "12345678-0000-0000-0000-000000000008";
    const names = assignBelegFileNames([
      { id: sameId, direction: "outgoing", effectiveDate: "2026-01-07", name: "Kunde AG", extension: "pdf" },
      { id: sameId, direction: "incoming", effectiveDate: "2026-01-07", name: "Kunde AG", extension: "pdf" },
    ]);
    // The second one lands in the OTHER folder, so it keeps its plain name (no `-2` suffix).
    expect(names.get(sameId)).toBe("belege/2026-01-07_Kunde-AG_12345678.pdf");
  });

  it("names the folder of a direction without consulting anything else", () => {
    expect(closingDirectoryFor("outgoing")).toBe(AUSGANGSRECHNUNGEN_DIRECTORY);
    expect(closingDirectoryFor("incoming")).toBe(BELEGE_DIRECTORY);
    expect(closingDirectoryFor(null)).toBe(BELEGE_DIRECTORY);
  });
});
