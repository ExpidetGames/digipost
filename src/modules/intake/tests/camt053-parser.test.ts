import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { camt053StatementReconciles, parseCamt053 } from "../core/camt053-parser";
import { UnsafeXmlError } from "../core/xml-safety";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("parseCamt053", () => {
  const xml = readFixture("camt053-valid.xml");
  const result = parseCamt053(xml);

  it("reports the namespace version", () => {
    expect(result.version).toBe("02");
  });

  it("parses exactly one statement with the account IBAN and currency", () => {
    expect(result.statements).toHaveLength(1);
    const statement = result.statements[0]!;
    expect(statement.accountIban).toBe("DE02120300000000202051");
    expect(statement.currency).toBe("EUR");
    expect(statement.statementId).toBe("STMT-2026-08");
  });

  it("parses opening and closing balances", () => {
    const statement = result.statements[0]!;
    expect(statement.openingBalance).toEqual({ type: "OPBD", amountCents: 100000, currency: "EUR", date: "2026-08-01" });
    expect(statement.closingBalance).toEqual({ type: "CLBD", amountCents: 199902, currency: "EUR", date: "2026-08-31" });
  });

  it("reconciles: opening balance plus every transaction equals the closing balance", () => {
    expect(camt053StatementReconciles(result.statements[0]!)).toBe(true);
  });

  it("expands the batch entry into one transaction per TxDtls (3 transactions) plus the 5 non-batch entries", () => {
    expect(result.statements[0]!.transactions).toHaveLength(3 + 5);
  });

  it("normalizes a simple credit entry", () => {
    const tx = result.statements[0]!.transactions.find((t) => t.entryReference === "NTRYREF-001")!;
    expect(tx.amountCents).toBe(25000);
    expect(tx.creditDebit).toBe("credit");
    expect(tx.currency).toBe("EUR");
    expect(tx.bookingDate).toBe("2026-08-02");
    expect(tx.valueDate).toBe("2026-08-02");
    expect(tx.counterpartyName).toBe("Müller GmbH");
    expect(tx.counterpartyIban).toBe("DE45500105172295759744");
    expect(tx.counterpartyBic).toBe("COBADEFFXXX");
    expect(tx.endToEndId).toBe("E2E-INV-1001");
    expect(tx.accountServicerReference).toBe("ASR-001");
    expect(tx.remittanceInformation).toBe("Rechnung 1001");
    expect(tx.bankTransactionCode).toBe("PMNT/RCDT/ESCT");
  });

  it("normalizes a SEPA direct debit with mandate id and creditor id, umlauts preserved", () => {
    const tx = result.statements[0]!.transactions.find((t) => t.entryReference === "NTRYREF-002")!;
    expect(tx.amountCents).toBe(-4599);
    expect(tx.creditDebit).toBe("debit");
    expect(tx.counterpartyName).toBe("Hausverwaltung Schäfer & Söhne GmbH");
    expect(tx.counterpartyIban).toBe("DE11500105170648489890");
    expect(tx.mandateId).toBe("MANDATE-2026-001");
    expect(tx.creditorId).toBe("DE98ZZZ09999999999");
    expect(tx.bankTransactionCode).toBe("PMNT/RDDT/ESDD");
  });

  it("normalizes every batch transaction with its own amount and counterparty", () => {
    const batchTransactions = result.statements[0]!.transactions.filter((t) => t.entryReference === "NTRYREF-005");
    expect(batchTransactions).toHaveLength(3);
    expect(batchTransactions.map((t) => t.amountCents).sort((a, b) => a - b)).toEqual([7550, 10000, 15000]);
    expect(batchTransactions.some((t) => t.counterpartyName === "Grüne Straße Handels GmbH")).toBe(true);
    expect(batchTransactions.some((t) => t.counterpartyName === "Österreich Consulting GmbH")).toBe(true);
    expect(batchTransactions.some((t) => t.counterpartyName === "Süßwaren Krüger KG")).toBe(true);
    // Every batch transaction shares the same entry-level reference and bank transaction code.
    expect(batchTransactions.every((t) => t.bankTransactionCode === "PMNT/RCDT/ESCT")).toBe(true);
  });

  it("normalizes a bank-fee entry with no NtryDtls/TxDtls at all", () => {
    const tx = result.statements[0]!.transactions.find((t) => t.entryReference === "NTRYREF-006")!;
    expect(tx.amountCents).toBe(-1050);
    expect(tx.creditDebit).toBe("debit");
    expect(tx.counterpartyName).toBeNull();
    expect(tx.remittanceInformation).toBeNull();
    expect(tx.accountServicerReference).toBe("ASR-006");
  });

  it("computes a stable, deterministic idempotency key per transaction", () => {
    const again = parseCamt053(xml);
    expect(again.statements[0]!.transactions[0]!.idempotencyKey).toBe(result.statements[0]!.transactions[0]!.idempotencyKey);
    const keys = result.statements[0]!.transactions.map((t) => t.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("throws UnsafeXmlError for the XXE fixture without expanding it", () => {
    expect(() => parseCamt053(readFixture("malicious-xxe.xml"))).toThrow(UnsafeXmlError);
  });

  it("throws UnsafeXmlError for the billion-laughs fixture without expanding it", () => {
    expect(() => parseCamt053(readFixture("malicious-billion-laughs.xml"))).toThrow(UnsafeXmlError);
  });

  it("throws a plain error for XML that is not camt.053 at all", () => {
    expect(() => parseCamt053("<Root/>")).toThrow(/camt\.053/);
  });
});

// R2: a confirmed data-loss bug in the idempotency key. The old formula picked "the most
// specific reference" via `endToEndId ?? accountServicerReference ?? ... ?? ""`; since `??`
// only falls through on null/undefined, the literal placeholder "NOTPROVIDED" (routinely
// emitted by German banks as EndToEndId when the SEPA payment carried none) won over every
// genuinely unique reference, collapsing distinct transactions onto the same key.
describe("parseCamt053 - idempotency key, NOTPROVIDED placeholder (R2)", () => {
  const xml = readFixture("camt053-notprovided.xml");
  const result = parseCamt053(xml);
  const transactions = result.statements[0]!.transactions;

  it("gives two same-day, same-amount entries with EndToEndId=NOTPROVIDED but different AcctSvcrRef different keys", () => {
    const first = transactions.find((t) => t.accountServicerReference === "ASR-100")!;
    const second = transactions.find((t) => t.accountServicerReference === "ASR-101")!;
    expect(first.endToEndId).toBe("NOTPROVIDED");
    expect(second.endToEndId).toBe("NOTPROVIDED");
    expect(first.bookingDate).toBe(second.bookingDate);
    expect(first.amountCents).toBe(second.amountCents);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("gives two entries that are identical across every other field a distinct key via the occurrence index", () => {
    const bankFees = transactions.filter((t) => t.bankTransactionCode === "PMNT/MCOP/MCOP");
    expect(bankFees).toHaveLength(2);
    expect(bankFees[0]!.entryReference).toBeNull();
    expect(bankFees[0]!.accountServicerReference).toBeNull();
    expect(bankFees[0]!.amountCents).toBe(bankFees[1]!.amountCents);
    expect(bankFees[0]!.bookingDate).toBe(bankFees[1]!.bookingDate);
    expect(bankFees[0]!.idempotencyKey).not.toBe(bankFees[1]!.idempotencyKey);
  });

  it("is deterministic: parsing the same file twice yields identical keys, in order", () => {
    const again = parseCamt053(xml).statements[0]!.transactions;
    expect(again.map((t) => t.idempotencyKey)).toEqual(transactions.map((t) => t.idempotencyKey));
  });

  it("every transaction in the fixture gets a unique key (no collisions at all)", () => {
    const keys = transactions.map((t) => t.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a whitespace/case variant of the placeholder is treated identically to the canonical one", () => {
    const variant = xml.replace(/<EndToEndId>NOTPROVIDED<\/EndToEndId>/g, "<EndToEndId> notprovided </EndToEndId>");
    const variantResult = parseCamt053(variant);
    expect(variantResult.statements[0]!.transactions.map((t) => t.idempotencyKey)).toEqual(transactions.map((t) => t.idempotencyKey));
  });
});

// decisions/0064-camt053-wraps-its-parties.md: a real-world Musterbank export is a
// camt.053.001.08 document, where a related party is a choice type and its name sits under
// <Pty>. The parser only read the .001.02 shape, so every transaction from such a statement
// was imported with no counterparty at all, while the same account's MT940 import had a name
// on every single one.
describe("parseCamt053 - a version that wraps its parties (.001.04 and later)", () => {
  const result = parseCamt053(readFixture("camt053-v8-wrapped-parties.xml"));
  const transactions = result.statements[0]!.transactions;

  it("reads the version", () => {
    // `version` is the namespace's own minor number, the same shape the .001.02 fixture yields.
    expect(result.version).toBe("08");
  });

  it("takes the debtor as the counterparty of a credit", () => {
    expect(transactions[0]!.counterpartyName).toBe("Beispiel Software Inc");
    expect(transactions[0]!.creditDebit).toBe("credit");
  });

  it("takes the creditor as the counterparty of a debit, never the account owner", () => {
    expect(transactions[1]!.counterpartyName).toBe("HOSTING-BEISPIEL.COM");
    expect(transactions[1]!.creditDebit).toBe("debit");
  });

  it("reads the agent's BICFI, which .001.02 spelled BIC", () => {
    expect(transactions[0]!.counterpartyBic).toBe("DEUTDEFFXXX");
  });
});
