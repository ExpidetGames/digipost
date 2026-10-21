import { describe, expect, it } from "vitest";

import { flattenMarkdownTables, joinOcrText, truncateForAnalysis } from "../core/ocr-text";
import type { OcrPage } from "../core/ports";

function page(markdown: string, index = 0): OcrPage {
  return { index, markdown, dimensions: null, blocks: null };
}

/**
 * Shaped like what the real Mistral OCR API actually returns for a German invoice
 * (verified against the live API, 2026-09, D1 in P7's defect list): a markdown title, a
 * sender address, a 7-column line-item table with a "19 %" tax column, and a totals block
 * below it. This is the fixture D1 asks for - amounts, tax rates and item names must
 * survive `joinOcrText` into what gets stored in `documents.ocr_text`.
 */
const INVOICE_MARKDOWN = `# Rechnung Nr. 2026-0817

**Buchhandlung Mustermann GmbH**
Musterstraße 12, 10115 Berlin

Kunde: Fachbuchhandlung Nord, Hafenstraße 3, 20095 Hamburg

| Pos | Beschreibung | Menge | Einzelpreis | Rabatt | USt-Satz | Gesamtpreis |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Fachbücher Wirtschaftsrecht | 12 | 45,00 € | 0 % | 19 % | 540,00 € |
| 2 | Bürobedarf Sortiment | 30 | 12,50 € | 5 % | 19 % | 356,25 € |
| 3 | Versandkosten |  | 15,00 € | 0 % | 19 % | 15,00 € |

**Nettobetrag:** 911,25 €
**USt (19 %):** 172,43 €
**Gesamtbetrag: 1.083,68 €**

![img-0.jpeg](img-0.jpeg)
`;

describe("joinOcrText", () => {
  it("joins multiple pages with a blank line between them", () => {
    expect(joinOcrText([page("Seite eins"), page("Seite zwei", 1)])).toBe("Seite eins\n\nSeite zwei");
  });

  it("strips a self-referential image placeholder link", () => {
    expect(joinOcrText([page("Text davor\n\n![img-1.jpeg](img-1.jpeg)\n\nText danach")])).not.toContain("img-1.jpeg");
  });

  it("strips a self-referential table placeholder link (tbl-N.html)", () => {
    expect(joinOcrText([page("Text davor\n\n[tbl-3.html](tbl-3.html)\n\nText danach")])).not.toContain("tbl-3.html");
  });

  it("keeps a real image/link whose visible text differs from its target (not a placeholder)", () => {
    const result = joinOcrText([page("Siehe ![Firmenlogo](logo.png) und [unsere Website](https://example.test).")]);
    expect(result).toContain("Firmenlogo");
    expect(result).toContain("unsere Website");
  });

  it("flattens markdown table rows into plain text instead of deleting them", () => {
    const withTable = "Text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nMehr Text";
    const result = joinOcrText([page(withTable)]);
    expect(result).not.toContain("| A | B |");
    expect(result).not.toContain("---");
    expect(result).toContain("A | B");
    expect(result).toContain("1 | 2");
  });

  it("omits an empty page from the joined output", () => {
    expect(joinOcrText([page(""), page("Inhalt", 1)])).toBe("Inhalt");
  });

  it("preserves a realistic invoice table's amounts, tax rates and item names", () => {
    const result = joinOcrText([page(INVOICE_MARKDOWN)]);

    // Item names.
    expect(result).toContain("Fachbücher Wirtschaftsrecht");
    expect(result).toContain("Bürobedarf Sortiment");
    // Quantities and unit prices.
    expect(result).toContain("12");
    expect(result).toContain("45,00 €");
    // Tax rate.
    expect(result).toContain("19 %");
    // Totals.
    expect(result).toContain("Gesamtbetrag: 1.083,68 €");
    // No leftover markdown table punctuation.
    expect(result).not.toMatch(/^\|/m);
    expect(result).not.toContain("---");
    // The asset placeholder is gone, everything else survived.
    expect(result).not.toContain("img-0.jpeg");
  });
});

describe("flattenMarkdownTables", () => {
  it("drops the separator row and collapses an empty cell", () => {
    const table = "| Pos | Name |  |\n| --- | --- | --- |\n| 1 | Kaffee |  |";
    const result = flattenMarkdownTables(table);
    expect(result).toBe("Pos | Name\n1 | Kaffee");
  });

  it("leaves non-table lines untouched", () => {
    expect(flattenMarkdownTables("Ein normaler Satz ohne Tabelle.")).toBe("Ein normaler Satz ohne Tabelle.");
  });
});

describe("truncateForAnalysis", () => {
  it("leaves short text unchanged", () => {
    expect(truncateForAnalysis("kurz")).toBe("kurz");
  });

  it("leaves a realistic one-page invoice (with its table) unchanged - well under the default limit", () => {
    const ocrText = joinOcrText([page(INVOICE_MARKDOWN)]);
    expect(ocrText.length).toBeLessThan(1000);
    expect(truncateForAnalysis(ocrText)).toBe(ocrText);
  });

  it("truncates long text and marks it as shortened", () => {
    const long = "x".repeat(10_000);
    const result = truncateForAnalysis(long, 100);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("gekürzt");
  });
});
