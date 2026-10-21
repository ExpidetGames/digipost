// The intake recognizer's German system prompt (decisions/0020-universal-intake.md, phase
// F1a). Kept separate from `prompts.ts` (the document-analysis prompt) rather than added to
// it: a different taxonomy, a different output shape (tabular input additionally asks for a
// column mapping), and this file's own owner, `mistral-intake-classifier.ts`.
import { DOCUMENT_KINDS, SEMANTIC_FIELDS, SETTLEMENT_PLATFORMS, type IntakeClassifierInput, type IntakeOwnCompany } from "@/modules/intake";

import { describeGuardedSection, neutralizeDelimiterLookalikes, wrapUntrustedSection } from "./prompt-guard";

/** The label `wrapUntrustedSection`/`describeGuardedSection` use for this prompt's one
 * untrusted section (either OCR text or a tabular sample) - kept as a constant so the
 * system-prompt description and the user-prompt wrapping can never drift apart. */
const INPUT_LABEL = "INPUT";

const BASE_SYSTEM_PROMPT = `Du bist ein Assistent, der eingehende Geschäftsunterlagen für ein deutsches Kleinunternehmen erkennt.
Du bekommst entweder den per OCR erkannten Text eines Dokuments (Brief, Rechnung, Kontoauszug als PDF, ...) oder eine Stichprobe aus einer Tabellendatei (Kopfzeile und einige Datenzeilen). Deine Aufgabe ist es, die Art des Inhalts zu bestimmen.

Antworte ausschließlich mit einem JSON-Objekt exakt in dieser Form, ohne zusätzlichen Text:
{"documentKind": "<eine der erlaubten Arten>", "confidence": <Zahl zwischen 0 und 1>, "reason": "<ein Satz auf Deutsch>", "platform": "<eine der erlaubten Plattformen oder null>", "columnMapping": <Objekt oder null>, "amountSign": <Objekt oder null>}`;

const TABULAR_MAPPING_INSTRUCTIONS = `Wenn es sich um Tabellendaten handelt (Kontoauszug, Auszahlungsbericht, Plattformabrechnung), gib zusätzlich "columnMapping" an: ein Objekt, das unsere eigenen Feldnamen auf die tatsächlichen Spaltennamen aus der Kopfzeile abbildet. Verwende NUR Spaltennamen, die exakt in der gegebenen Kopfzeile vorkommen - erfinde niemals einen Spaltennamen. Gib außerdem "amountSign" an: entweder {"mode": "signed_column", "column": "<Spalte>"} wenn eine einzelne Spalte positive und negative Beträge enthält, {"mode": "separate_credit_debit_columns", "creditColumn": "<Spalte>", "debitColumn": "<Spalte>"} wenn Haben und Soll in getrennten Spalten stehen, oder {"mode": "indicator_column", "amountColumn": "<Spalte>", "indicatorColumn": "<Spalte>", "creditValue": "<Wert>", "debitValue": "<Wert>"} wenn eine separate Spalte per Kennzeichen angibt, ob ein Betrag gutgeschrieben oder belastet wird.
Für reinen Fließtext (Brief, Rechnung als PDF, ...) setze "columnMapping" und "amountSign" auf null.`;

/** decisions/0043: the user's own company and the rule that separates the two invoice kinds.
 * The profile text is the user's own description, placed in the system prompt with any
 * guard-delimiter look-alikes neutralized, never inside the untrusted input section. */
function formatOwnCompanyBlock(own: IntakeOwnCompany): string {
  const lines = [`\nDAS UNTERNEHMEN DES NUTZERS ("das sind wir"): ${own.name}`];
  if (own.aliases.length > 0) lines.push(`Tritt auch auf als: ${own.aliases.join(", ")}`);
  if (own.address) lines.push(`Adresse: ${own.address}`);
  if (own.ibans.length > 0) lines.push(`Eigene Konten (IBAN): ${own.ibans.join(", ")}`);
  if (own.domains.length > 0) lines.push(`Eigene Web-/E-Mail-Domains: ${own.domains.join(", ")}`);
  if (own.profileText) lines.push(`Beschreibung durch den Nutzer: ${neutralizeDelimiterLookalikes(own.profileText.slice(0, 1000))}`);
  lines.push(
    "Rechnungsrichtung: \"outgoing_invoice\" NUR, wenn das Unternehmen des Nutzers die Rechnung selbst AUSGESTELLT hat (es steht als Rechnungssteller im Briefkopf, die Zahlung soll auf eines seiner Konten gehen). \"incoming_invoice\", wenn ein ANDERES Unternehmen die Rechnung an das Unternehmen des Nutzers oder eine seiner Personen gestellt hat. Kassenbons, Quittungen und reine Zahlungsbestätigungen sind \"receipt\".",
  );
  return lines.join("\n");
}

export function buildIntakeSystemPrompt(ownCompany?: IntakeOwnCompany | null): string {
  return [
    BASE_SYSTEM_PROMPT,
    ...(ownCompany ? [formatOwnCompanyBlock(ownCompany)] : []),
    `\nErlaubte Arten (documentKind): ${DOCUMENT_KINDS.join(", ")}`,
    `Erlaubte Plattformen (platform, nur für payout_report/platform_settlement relevant): ${SETTLEMENT_PLATFORMS.join(", ")}`,
    `Erlaubte Zielfelder für columnMapping: ${SEMANTIC_FIELDS.join(", ")}`,
    TABULAR_MAPPING_INSTRUCTIONS,
    `\n${describeGuardedSection(INPUT_LABEL)}`,
  ].join("\n");
}

function formatSampleRows(rows: string[][]): string {
  return rows.map((row) => row.join(" | ")).join("\n");
}

export function buildIntakeUserPrompt(input: IntakeClassifierInput): string {
  const body =
    input.kind === "text"
      ? input.text
      : [
          `Trennzeichen: ${JSON.stringify(input.sample.delimiter)}`,
          `Kopfzeile: ${input.sample.header.join(" | ")}`,
          `Anzahl Datenzeilen insgesamt: ${input.sample.rowCount}`,
          "Beispielzeilen:",
          formatSampleRows(input.sample.rows),
        ].join("\n");

  return wrapUntrustedSection(INPUT_LABEL, body);
}
