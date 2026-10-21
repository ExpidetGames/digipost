import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeTextBytes, sniffFileKind } from "../core/file-kind";
import { MT940_ERROR, Mt940ParseError, mt940StatementReconciles, parseMt940 } from "../core/mt940-parser";

function readFixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

describe("sniffFileKind - MT940 detection (does not depend on file extension)", () => {
  it("recognizes a raw MT940 dump (no SWIFT envelope) by its :20:/:61: tag lines", () => {
    expect(sniffFileKind(new TextEncoder().encode(readFixtureText("mt940-valid.mt940")))).toBe("mt940");
  });

  it("recognizes MT940 wrapped in a {1:...}{2:...}{4: ... -} SWIFT block envelope", () => {
    const enveloped = `{1:F01BANKDEFFAXXX0000000000}{2:O9401200000000BANKDEFFAXXX00000000000001200000000000N}{4:\n:20:STARTUMS\n:25:DE02120300000000202051\n:28C:00001/001\n:60F:C260901EUR100,00\n:61:2609020902D25,00NTRFNONREF\n:86:105?00SEPA\n:62F:C260902EUR75,00\n-}`;
    expect(sniffFileKind(new TextEncoder().encode(enveloped))).toBe("mt940");
  });

  it("tolerates CRLF line endings", () => {
    const crlf = readFixtureText("mt940-valid.mt940").replace(/\n/g, "\r\n");
    expect(sniffFileKind(new TextEncoder().encode(crlf))).toBe("mt940");
  });

  it("does NOT detect a CSV file as MT940", () => {
    expect(sniffFileKind(new TextEncoder().encode("a,b,c\n1,2,3\n4,5,6\n7,8,9\n"))).toBe("csv");
  });

  it("does NOT detect a camt.053 XML file as MT940", () => {
    const xml = readFixtureText("camt053-valid.xml");
    expect(sniffFileKind(new TextEncoder().encode(xml))).toBe("xml");
  });

  it("does not detect plain prose with a stray colon as MT940", () => {
    expect(sniffFileKind(new TextEncoder().encode("Sehr geehrte Damen und Herren: bitte um Rueckruf."))).toBe("unknown");
  });
});

describe("parseMt940 - realistic German fixture", () => {
  const text = readFixtureText("mt940-valid.mt940");
  const result = parseMt940(text);

  it("parses both statements in the file", () => {
    expect(result.statements).toHaveLength(2);
  });

  it("reads the account IBAN, currency, and statement id (from :28C:) for each statement", () => {
    expect(result.statements[0]!.accountIban).toBe("DE02120300000000202051");
    expect(result.statements[0]!.currency).toBe("EUR");
    expect(result.statements[0]!.statementId).toBe("00001/001");
    expect(result.statements[1]!.statementId).toBe("00002/001");
  });

  it("parses opening and closing balances", () => {
    expect(result.statements[0]!.openingBalance).toEqual({ type: "60F", amountCents: 100000, currency: "EUR", date: "2026-08-01" });
    expect(result.statements[0]!.closingBalance).toEqual({ type: "62F", amountCents: 100000, currency: "EUR", date: "2026-08-05" });
  });

  it("both statements reconcile: opening + sum(transactions) == closing", () => {
    expect(mt940StatementReconciles(result.statements[0]!)).toBe(true);
    expect(mt940StatementReconciles(result.statements[1]!)).toBe(true);
  });

  it("parses every :61:/:86: pair in the first statement (4 transactions)", () => {
    expect(result.statements[0]!.transactions).toHaveLength(4);
  });

  it("normalizes a plain credit entry with structured SEPA remittance info, umlauts preserved", () => {
    const tx = result.statements[0]!.transactions[0]!;
    expect(tx.amountCents).toBe(25000);
    expect(tx.creditDebit).toBe("credit");
    expect(tx.bookingDate).toBe("2026-08-02");
    expect(tx.valueDate).toBe("2026-08-02");
    expect(tx.currency).toBe("EUR");
    expect(tx.endToEndId).toBe("X2026-0001");
    expect(tx.counterpartyName).toBe("Kunde AG");
    expect(tx.counterpartyIban).toBe("DE89370400440532013000");
    expect(tx.counterpartyBic).toBe("COBADEFFXXX");
    expect(tx.accountServicerReference).toBe("P100001"); // Primanota (?10)
    expect(tx.entryReference).toBe("REF0001");
    expect(tx.bankTransactionCode).toBe("NTRF/051/GUTSCHR/000");
    expect(tx.remittanceInformation).toContain("Rechnung RE-4711");
  });

  it("normalizes a direct debit with mandate id, creditor id, and the '//' bank reference (Primanota takes priority over it)", () => {
    const tx = result.statements[0]!.transactions[1]!;
    expect(tx.amountCents).toBe(-7550);
    expect(tx.creditDebit).toBe("debit");
    expect(tx.mandateId).toBe("MND-2026-77");
    expect(tx.creditorId).toBe("DE98ZZZ09999999999");
    expect(tx.counterpartyName).toBe("Vermieter GmbHCo KG");
    expect(tx.counterpartyIban).toBe("DE12500105170648489890");
    // NONREF is a placeholder, kept raw on the field itself...
    expect(tx.entryReference).toBe("NONREF");
    // ...the '//' bank reference is only used as accountServicerReference when Primanota is absent -
    // here Primanota (?10) IS present, so it wins.
    expect(tx.accountServicerReference).toBe("P100002");
  });

  it("flips the sign for a reversal-of-credit (RC) mark", () => {
    const tx = result.statements[0]!.transactions[2]!;
    expect(tx.amountCents).toBe(-3000);
    expect(tx.creditDebit).toBe("debit");
  });

  it("folds a leading Geschaeftsvorfallcode and the ?00 booking text into the bank transaction code", () => {
    const tx = result.statements[0]!.transactions[2]!;
    expect(tx.remittanceInformation).toBe("Korrektur fehlerhafte Gutschrift vom Vortag");
    expect(tx.bankTransactionCode).toBe("NMSC/150/STORNO");
  });

  it("treats a genuinely unstructured :86: (no ?nn subfields at all) as plain remittance text", () => {
    const text =
      ":20:X\n:25:DE02120300000000202051\n:60F:C260801EUR0,00\n:61:260802C5,00NTRFREF1\n:86:Freitext ohne Feldkennungen\n:62F:C260802EUR5,00\n-";
    const tx = parseMt940(text).statements[0]!.transactions[0]!;
    expect(tx.remittanceInformation).toBe("Freitext ohne Feldkennungen");
    expect(tx.bankTransactionCode).toBe("NTRF");
  });

  it("joins a :86: wrapped across multiple physical lines before parsing its subfields, umlauts intact", () => {
    const tx = result.statements[0]!.transactions[3]!;
    expect(tx.amountCents).toBe(-14450);
    expect(tx.counterpartyName).toBe("Müller & Söhne GmbH");
    expect(tx.counterpartyIban).toBe("DE44500105175407324931");
    expect(tx.remittanceInformation).toContain("Büromöbel");
    expect(tx.remittanceInformation).toContain("Großauftrag für Büroausstattung, Straße 1, Köln");
  });

  it("computes a stable, deterministic idempotency key per transaction, across two separate parses", () => {
    const again = parseMt940(text);
    expect(again.statements[0]!.transactions.map((t) => t.idempotencyKey)).toEqual(
      result.statements[0]!.transactions.map((t) => t.idempotencyKey),
    );
    const allKeys = [...result.statements[0]!.transactions, ...result.statements[1]!.transactions].map((t) => t.idempotencyKey);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});

describe("parseMt940 - CP1252-encoded variant of the same statement", () => {
  it("decodes umlauts correctly via decodeTextBytes before parsing", () => {
    const bytes = readFixtureBytes("mt940-valid-cp1252.mt940");
    expect(sniffFileKind(bytes)).toBe("mt940");
    const text = decodeTextBytes(bytes);
    const result = parseMt940(text);
    const tx = result.statements[0]!.transactions[3]!;
    expect(tx.counterpartyName).toBe("Müller & Söhne GmbH");
    expect(tx.counterpartyIban).toBe("DE44500105175407324931");
    expect(tx.remittanceInformation).toContain("Großauftrag für Büroausstattung, Straße 1, Köln");
  });
});

describe("parseMt940 - idempotency key, distinct-vs-occurrence-index (mirrors camt053-notprovided.xml, R2)", () => {
  const text = readFixtureText("mt940-duplicate-shaped.mt940");
  const transactions = parseMt940(text).statements[0]!.transactions;

  it("parses all 4 same-day, same-amount debit fee lines", () => {
    expect(transactions).toHaveLength(4);
    expect(transactions.every((t) => t.amountCents === -1000)).toBe(true);
    expect(transactions.every((t) => t.entryReference === "NONREF")).toBe(true);
  });

  it("gives two entries with different '//' bank references different keys", () => {
    expect(transactions[0]!.accountServicerReference).toBe("BKREF001");
    expect(transactions[1]!.accountServicerReference).toBe("BKREF002");
    expect(transactions[0]!.idempotencyKey).not.toBe(transactions[1]!.idempotencyKey);
  });

  it("gives two entries identical across every field this parser reads a distinct key via the occurrence index", () => {
    expect(transactions[2]!.accountServicerReference).toBeNull();
    expect(transactions[3]!.accountServicerReference).toBeNull();
    expect(transactions[2]!.idempotencyKey).not.toBe(transactions[3]!.idempotencyKey);
  });

  it("every transaction gets a unique key overall", () => {
    const keys = transactions.map((t) => t.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is deterministic across two separate parses", () => {
    const again = parseMt940(text).statements[0]!.transactions;
    expect(again.map((t) => t.idempotencyKey)).toEqual(transactions.map((t) => t.idempotencyKey));
  });
});

describe("parseMt940 - malformed input", () => {
  it("skips an unparseable :61: line rather than throwing, still returns the statement", () => {
    const text = readFixtureText("mt940-malformed.mt940");
    const result = parseMt940(text);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]!.transactions).toHaveLength(0);
  });

  it("throws Mt940ParseError (not_mt940) when called directly on text without :20:/:61: tags", () => {
    expect(() => parseMt940("just some text\nwith no tags at all")).toThrow(Mt940ParseError);
    try {
      parseMt940("nope");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Mt940ParseError);
      expect((err as Mt940ParseError).code).toBe(MT940_ERROR.notMt940);
    }
  });
});

describe("parseMt940 - hard limits (R1-review spirit: reject absurd input early)", () => {
  it("throws mt940_too_many_lines for a pathologically line-heavy file", () => {
    const huge = ":20:X\n:61:1\n" + "\n".repeat(200_001);
    expect(() => parseMt940(huge)).toThrow(Mt940ParseError);
    try {
      parseMt940(huge);
      expect.unreachable();
    } catch (err) {
      expect((err as Mt940ParseError).code).toBe(MT940_ERROR.tooManyLines);
    }
  });

  it("throws mt940_too_many_statements for a file with more than 1000 :20: groups", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `:20:S${i}\n:61:2608010801D10,00NMSCNONREF`).join("\n");
    expect(() => parseMt940(many)).toThrow(Mt940ParseError);
    try {
      parseMt940(many);
      expect.unreachable();
    } catch (err) {
      expect((err as Mt940ParseError).code).toBe(MT940_ERROR.tooManyStatements);
    }
  });
});

describe("parseMt940 - amount and date parsing", () => {
  it("parses a value date without a booking date (booking date falls back to value date)", () => {
    const text = ":20:X\n:25:DE02120300000000202051\n:60F:C260801EUR0,00\n:61:260802C5,00NTRFREF1\n:62F:C260802EUR5,00\n-";
    const tx = parseMt940(text).statements[0]!.transactions[0]!;
    expect(tx.valueDate).toBe("2026-08-02");
    expect(tx.bookingDate).toBe("2026-08-02");
  });

  it("resolves a booking-date year-end rollover (value date in December, booking date in January)", () => {
    const text =
      ":20:X\n:25:DE02120300000000202051\n:60F:C261231EUR0,00\n:61:2612310102C5,00NTRFREF1\n:62F:C261231EUR5,00\n-";
    const tx = parseMt940(text).statements[0]!.transactions[0]!;
    expect(tx.valueDate).toBe("2026-12-31");
    expect(tx.bookingDate).toBe("2027-01-02");
  });

  it("parses a whole-euro amount with no decimal digits after the comma", () => {
    const text = ":20:X\n:25:DE02120300000000202051\n:60F:C260801EUR0,00\n:61:260802C5,NTRFREF1\n:62F:C260802EUR5,00\n-";
    const tx = parseMt940(text).statements[0]!.transactions[0]!;
    expect(tx.amountCents).toBe(500);
  });
});
