# camt.053 wraps its parties from version .001.04 onwards

Document type: decision
Lifecycle: active
Owner: src/modules/intake
Scope: `extractCounterparty` and `extractCounterpartyBic` in `core/camt053-parser.ts`
Canonical responsibility: Active source for which camt.053 element shapes this parser reads
Maintenance triggers:
- A bank's statement imports with transactions that have no counterparty (check the version and
  the element path first, before anything else)
- Support for a namespace-prefixed camt.053 document is added
Last verified: 2026-09-23, against the owner's own Musterbank camt.053.001.08 statement

## Status

Accepted. Fixes a data-loss bug in decisions/0020-universal-intake.md's camt.053 parser.

## Context

The owner asked why the transactions on their bank account show no counterparty: "jede
Banktransaktion hat doch irgendwie einen Zahlungspartner". They were right, and the data said
exactly where it went:

| Source of the account's transactions | Transactions | With a counterparty |
| --- | --- | --- |
| `Musterbank_statement.mt940` | 80 | 80 |
| `OLD_Musterbank_statement.mt940` | 60 | 60 |
| `Musterbank_statement.xml` (camt.053) | 10 | **0** |

The MT940 path was perfect and the camt.053 path lost every single name. The XML itself has
them: the stored statement is a `camt.053.001.08` document and reads

```xml
<RltdPties>
  <Dbtr><Pty><Nm>Apple Inc</Nm></Pty></Dbtr>
  <Cdtr><Pty><Nm>Mustermann und Beispiel GbR</Nm></Pty></Cdtr>
</RltdPties>
```

The parser read `RltdPties/Dbtr/Nm`. That is correct for camt.053.001.02 and .03, where
`Dbtr` is a `PartyIdentification`. From .001.04 onwards it is a `Party40Choice`, so the name
sits one level deeper under `<Pty>`. The parser's own namespace check already accepted `.001.02`
through `.001.08`, so it declared support for versions whose party shape it could not read.

The same version bump renamed the agent's `<BIC>` to `<BICFI>`; that one happened to be written
for the newer spelling only, which is the mirror image of the same mistake.

## Decision

`extractCounterparty` reads `[party, "Pty", "Nm"]` first and falls back to `[party, "Nm"]`;
`extractCounterpartyBic` reads `BICFI` first and falls back to `BIC`. Both shapes are supported
for every accepted version rather than branching on the version number: a parser that accepts a
range of versions has to read every shape in that range, and trying two paths costs nothing.

The account element is deliberately NOT changed: `DbtrAcct`/`CdtrAcct` stay siblings of the
party element in every version, so their `Id/IBAN` path is already right.

## Consequences

- The credit/debit rule is unchanged and matters more now that names actually arrive: on a
  credit the counterparty is the debtor, on a debit it is the creditor. Reading the wrong one
  would have put the account owner's own name on every transaction, which is exactly what the
  fixture's second entry pins down.
- The ten already-imported transactions were repaired in place rather than
  re-imported: the counterparty name is not part of the idempotency key, so a re-import would
  have been a no-op, and deleting them would have broken the three that already carry a
  confirmed document link. The stored statement was re-parsed with the fixed parser and the
  names written back by idempotency key.
- A statement from a bank using a namespace prefix is still unsupported (see the parser's own
  header comment). Unchanged by this decision, and still not observed in practice.

## Alternatives considered

- **Branch on the parsed version number.** Rejected: it turns one lookup into a version table
  that has to be maintained against a spec nobody in this project owns, and it would have
  failed the same way for the next element that moved.
- **Narrow the accepted namespace range to .001.02/.03.** Rejected: it would have turned a
  silent data loss into an outright rejection of the owner's own bank export.
- **Delete the ten transactions and re-import the statement.** Rejected: some of them carry
  confirmed document links, and one is the Apple payout that a clearing-account booking hangs
  off.
