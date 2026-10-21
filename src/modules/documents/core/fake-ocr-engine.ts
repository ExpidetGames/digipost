// The deterministic fake `OcrEngine` (decisions/0016-processing-pipeline-and-ai.md,
// architecture brief: "fake OCR text, keyword classifier"). Bound instead of the real Mistral
// adapter whenever `AI_PROVIDER=fake` (or no `MISTRAL_API_KEY` outside production) - every
// automated test uses this, never the network. Deterministic in `fileName` alone: the same
// file name always produces the exact same "OCR'd" text and blocks, no randomness, no clock.
import type { OcrBlock, OcrEngine, OcrResult } from "./ports";

type FakeLetterRule = { keywords: string[]; sender: string; subject: string; extraLines: string[] };

// Checked in order: a more specific rule (e.g. "telekom") must come before a more generic
// one that would also match the same file name (e.g. "rechnung") so
// "rechnung-telekom.pdf" resolves to the Telekom-specific letter the architecture brief's
// example names, not the generic invoice one.
const FAKE_LETTER_RULES: FakeLetterRule[] = [
  {
    // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): the architecture
    // brief's own worked example - an incoming invoice with a VAT id, IBAN, amount, and due
    // date, all extracted deterministically by `core/fake-document-analyzer.ts`'s
    // label-matching regexes below.
    keywords: ["telekom"],
    sender: "Telekom Deutschland GmbH",
    subject: "Rechnung",
    extraLines: [
      "Rechnungsnummer 4711",
      "USt-IdNr.: DE813298342",
      "IBAN: DE12500105170648489890",
      "Rechnungsbetrag: 49,99 EUR",
      "Fälligkeitsdatum: 05.04.2026",
    ],
  },
  {
    // C2: an OUTGOING invoice fixture - `core/fake-document-analyzer.ts` recognizes this
    // keyword and builds the sender party from the caller's OWN company profile instead of
    // from this letter's own text, so a test can deterministically exercise the "we are the
    // sender" direction without needing a second real OCR fixture per workspace.
    keywords: ["ausgangsrechnung"],
    sender: "Muster Kunde GmbH",
    // "Ausgangsrechnung" literally, so the fake intake classifier reaches the same conclusion
    // this fixture's own file name states. Without it the classifier only saw "Rechnung" and
    // called our own outgoing invoice an incoming one, which decisions/0032 (kind outranks the
    // party roles) then faithfully turned into the wrong direction.
    subject: "Ausgangsrechnung",
    extraLines: ["Rechnungsnummer 9001", "Rechnungsbetrag: 250,00 EUR", "Fälligkeitsdatum: 20.04.2026"],
  },
  {
    keywords: ["rechnung", "invoice"],
    sender: "Muster Lieferant GmbH",
    subject: "Rechnung",
    extraLines: ["Rechnungsnummer 1023", "Rechnungsbetrag: 128,50 EUR", "Fälligkeitsdatum: 12.04.2026"],
  },
  {
    keywords: ["mahnung", "reminder"],
    sender: "Inkasso Meier KG",
    subject: "Zahlungserinnerung",
    extraLines: ["Mahnstufe 1", "Offener Betrag: 85,00 EUR", "Zahlungsziel: 01.04.2026"],
  },
  {
    keywords: ["finanzamt", "steuer", "tax"],
    sender: "Finanzamt Musterstadt",
    subject: "Steuerbescheid",
    extraLines: ["Steuernummer 123/456/78901", "Bescheiddatum: 10.03.2026"],
  },
  {
    keywords: ["versicherung", "insurance"],
    sender: "Allianz Versicherungs-AG",
    subject: "Versicherungsschein",
    extraLines: ["Vertragsnummer VN-99887", "Beginn: 01.01.2026"],
  },
  {
    keywords: ["vertrag", "contract"],
    sender: "Muster Vertragspartner GmbH",
    subject: "Vertragsunterlagen",
    extraLines: ["Vertragsnummer 55-2026", "Unterzeichnet am: 20.02.2026"],
  },
  {
    keywords: ["bank", "sparkasse", "konto"],
    sender: "Sparkasse Musterstadt",
    subject: "Kontoauszug",
    extraLines: ["Kontonummer DE00 0000 0000 0000 00", "Auszug Nr. 3"],
  },
  {
    keywords: ["lohn", "personal", "gehalt"],
    sender: "Personalabteilung Muster GmbH",
    subject: "Gehaltsabrechnung",
    extraLines: ["Abrechnungsmonat Maerz 2026", "Auszahlungsdatum: 27.03.2026"],
  },
  {
    keywords: ["werbung", "advertising", "flyer"],
    sender: "Werbepartner GmbH",
    subject: "Werbeschreiben",
    extraLines: ["Ihr Sonderangebot diese Woche"],
  },
  {
    keywords: ["amt", "behoerde", "gericht", "authority"],
    sender: "Ordnungsamt Musterstadt",
    subject: "Behördliches Schreiben",
    extraLines: ["Aktenzeichen OA-2026-042", "Datum: 05.03.2026"],
  },
];

const DEFAULT_RULE: FakeLetterRule = {
  keywords: [],
  sender: "Unbekannter Absender",
  subject: "Schreiben",
  extraLines: ["Kein Stichwort im Dateinamen erkannt."],
};

function normalizeFileName(fileName: string): string {
  return fileName.toLowerCase().replace(/\.[a-z0-9]+$/, "");
}

function pickRule(fileName: string): FakeLetterRule {
  const normalized = normalizeFileName(fileName);
  return FAKE_LETTER_RULES.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword))) ?? DEFAULT_RULE;
}

const PAGE_WIDTH = 1240; // A4 at ~150 dpi
const PAGE_HEIGHT = 1754;
const LINE_HEIGHT = 120;
const MARGIN = 100;

function buildBlocks(lines: string[]): OcrBlock[] {
  return lines.map((content, i) => ({
    type: "text",
    topLeftX: MARGIN,
    topLeftY: MARGIN + i * LINE_HEIGHT,
    bottomRightX: PAGE_WIDTH - MARGIN,
    bottomRightY: MARGIN + i * LINE_HEIGHT + LINE_HEIGHT - 20,
    content,
  }));
}

export function createFakeOcrEngine(): OcrEngine {
  return {
    async recognize({ fileName }) {
      const rule = pickRule(fileName);
      const lines = [rule.sender, rule.subject, ...rule.extraLines, "Mit freundlichen Grüßen", rule.sender];
      const markdown = lines.join("\n\n");

      const result: OcrResult = {
        pages: [
          {
            index: 0,
            markdown,
            dimensions: { width: PAGE_WIDTH, height: PAGE_HEIGHT, dpi: 150 },
            blocks: buildBlocks(lines),
          },
        ],
      };
      return result;
    },
  };
}
