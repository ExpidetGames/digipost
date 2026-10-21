// Unit tests for the upload route's structured-file (XML/CSV/TSV) sniffing/validation entry
// point (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): "route
// validation for the new types". No I/O - `sniffFileKind`/`detectCamt053`/`sampleTabular` are
// all pure.
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { sniffFileKind } from "@/modules/intake";

import { processIntakeUpload } from "../core/intake-upload-processing";

const CAMT_053_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-1</Id>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-31</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">50.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-01-15</Dt></BookgDt>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

const MALICIOUS_XML = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">&xxe;</Document>`;

const UNRECOGNIZED_XML = `<?xml version="1.0"?><SomeOtherDocument><Foo>bar</Foo></SomeOtherDocument>`;

// decisions/0028-mt940-support.md: the exact same statement as `CAMT_053_XML` above, but
// declaring the v08 namespace - proving the orchestrator's diagnosed bug (a real Musterbank v08
// export being rejected) is a server-side non-issue: `processIntakeUpload` takes raw bytes
// only, never a file name, so there is nothing here for an extension to "matter" to in the
// first place - the fix for that bug lives entirely in `upload-form.tsx`'s file picker.
const CAMT_053_V08_XML = CAMT_053_XML.replace("camt.053.001.02", "camt.053.001.08");

const MUSTERBANK_CSV = ["Buchungsdatum;Wertstellung;Betrag;Währung;Empfänger/Auftraggeber;IBAN;Verwendungszweck", "15.01.2026;15.01.2026;100,00;EUR;Kunde AG;DE89370400440532013000;Rechnung 1"].join(
  "\n",
);

// decisions/0028-mt940-support.md: a minimal, realistic MT940 statement (SWIFT tag lines at
// line starts, `:20:`/`:61:` at minimum) - the second self-identifying, deterministic
// bank-statement format alongside camt.053.
const MT940_STATEMENT = [
  ":20:STMT1",
  ":25:DE02120300000000202051",
  ":28C:00001/001",
  ":60F:C260801EUR100,00",
  ":61:2608020802C50,00NTRFREF0001",
  ":86:000?00GUTSCHR?20EREF+X1?21SVWZ+Rechnung 1?32Kunde AG",
  ":62F:C260802EUR150,00",
  "-",
].join("\n");

function text(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

async function validPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 300]);
  return doc.save();
}

describe("processIntakeUpload", () => {
  it("still routes a plain PDF through the existing pdf_or_image path", async () => {
    const pdfBytes = await validPdf();
    const result = await processIntakeUpload([pdfBytes], 20);
    expect(result).toEqual({ ok: true, data: { kind: "pdf_or_image", pdfBytes: expect.any(Uint8Array), pageCount: 1 } });
  });

  it("accepts a recognized camt.053 XML as a structured upload", async () => {
    const result = await processIntakeUpload([text(CAMT_053_XML)], 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      kind: "structured",
      data: { bytes: expect.any(Uint8Array), mimeType: "application/xml", extension: "xml", isCamt053: true },
    });
  });

  it("rejects a malicious XML (DOCTYPE/XXE) with the unsafe_xml stable code, before anything is stored", async () => {
    const result = await processIntakeUpload([text(MALICIOUS_XML)], 20);
    expect(result).toEqual({ ok: false, errorCode: "unsafe_xml" });
  });

  it("rejects an XML that is not camt.053 with unrecognized_xml_format", async () => {
    const result = await processIntakeUpload([text(UNRECOGNIZED_XML)], 20);
    expect(result).toEqual({ ok: false, errorCode: "unrecognized_xml_format" });
  });

  it("accepts a readable CSV as a structured upload", async () => {
    const result = await processIntakeUpload([text(MUSTERBANK_CSV)], 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      kind: "structured",
      data: { bytes: expect.any(Uint8Array), mimeType: "text/csv", extension: "csv", isCamt053: false },
    });
  });

  it("accepts a tab-separated file as a structured upload with the tsv extension", async () => {
    const tsv = "Datum\tBetrag\n01.01.2026\t10,00";
    const result = await processIntakeUpload([text(tsv)], 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      kind: "structured",
      data: { bytes: expect.any(Uint8Array), mimeType: "text/tab-separated-values", extension: "tsv", isCamt053: false },
    });
  });

  it("rejects a CSV with no actual data rows with empty_tabular_file", async () => {
    // A single quoted value spanning five physical lines is still just ONE header column, no
    // data rows at all - `sniffFileKind`'s quote-aware delimiter count (decisions/0048-app-store-reports.md)
    // still sniffs this as "csv" because three of its five physical lines (the fully-interior
    // ones, which contain no quote character of their own at all) each independently count one
    // real, unquoted comma - reaching the "at least 3 lines agree" quorum on their own, without
    // needing the two edge lines (which carry the value's own opening/closing quote and are
    // themselves miscounted by this per-line heuristic) to agree at all.
    const result = await processIntakeUpload([text('"start,\nb,c\nd,e\nf,g\nh,i"\n')], 20);
    expect(result).toEqual({ ok: false, errorCode: "empty_tabular_file" });
  });

  it("does not sniff a single quoted value spanning two physical lines as csv (decisions/0048-app-store-reports.md)", () => {
    // A quoted field spanning both raw lines (an embedded newline) is, correctly, a single
    // logical CSV record with one column - `sniffFileKind`'s quote-aware delimiter count
    // (needed for the real Apple/Google reports, decisions/0048) sees zero delimiters outside
    // the quote on either physical line, so there is nothing to sniff a consistent delimiter
    // from. Before that fix, the OLD naive (quote-unaware) count happened to agree across both
    // physical lines by coincidence and sniffed this as "csv" instead - an accident, not a
    // behavior worth preserving.
    expect(sniffFileKind(new TextEncoder().encode('"a,b\nc,d"\n'))).toBe("unknown");
  });

  it("rejects an empty request with no_file", async () => {
    const result = await processIntakeUpload([], 20);
    expect(result).toEqual({ ok: false, errorCode: "no_file" });
  });

  it("accepts a camt.053 v08 XML - server-side acceptance never depends on a file name (decisions/0028-mt940-support.md)", async () => {
    const result = await processIntakeUpload([text(CAMT_053_V08_XML)], 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      kind: "structured",
      data: { bytes: expect.any(Uint8Array), mimeType: "application/xml", extension: "xml", isCamt053: true },
    });
  });

  it("accepts a recognized MT940 statement as a structured upload (decisions/0028-mt940-support.md)", async () => {
    const result = await processIntakeUpload([text(MT940_STATEMENT)], 20);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      kind: "structured",
      data: { bytes: expect.any(Uint8Array), mimeType: "application/vnd.mt940", extension: "mt940", isCamt053: false },
    });
  });

  it("rejects an MT940-shaped file with no actual transaction lines with empty_mt940_file", async () => {
    const noTransactions = [":20:STMT1", ":25:DE02120300000000202051", ":60F:C260801EUR100,00", ":61:GARBLED-LINE", ":62F:C260801EUR100,00", "-"].join(
      "\n",
    );
    const result = await processIntakeUpload([text(noTransactions)], 20);
    expect(result).toEqual({ ok: false, errorCode: "empty_mt940_file" });
  });
});
