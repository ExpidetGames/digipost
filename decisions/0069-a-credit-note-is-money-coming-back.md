# A credit note is money coming back, without changing who sent it

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: `directionMatches`, the single "never cross" gate every matching stage calls
Canonical responsibility: Active source for which way the money must move for a document
Maintenance triggers:
- A document kind appears whose money flow is not implied by direction plus the total's sign
- `totalAmountCents` stops being negative for a credit note
Last verified: 2026-10-03, against two sample Musterbank cashback documents

## Status

Accepted. Corrects decisions/0023-payment-matching.md's direction rule.

## Context

Three documents in a sample workspace had never been matched. Two of them are Musterbank
cashback statements: Musterbank pays money INTO the account and sends a document about it.

```
08.09.2025   Beleg C-1AB2-0001   -40,00 EUR   |   Buchung  +40,00 EUR  "Cashback reward from all your cards"
21.10.2025   Beleg C-1AB2-0002   -12,50 EUR   |   Buchung  +12,50 EUR  "Cashback reward from all your cards"
```

Same day, same cent, same counterparty. They should have been the easiest matches in the
workspace, and no stage ever saw them as candidates.

`directionMatches` read:

```
negative transaction (money out)  <->  direction "incoming"
positive transaction (money in)   <->  direction "outgoing"
```

That treats `direction` as if it answered "which way does the money move". It does not: it
answers "who sent this document". The two agree for an ordinary invoice and disagree for every
credit note, which arrives FROM the supplier while the money comes back TO us. A user's
words: the classification as an incoming invoice "ist sogar nicht wirklich falsch, wir haben
sie nicht gestellt, sie kam bei uns an".

Nothing else in the module was in the way. `openAmountCents` is already built with
`Math.abs`, and `rules.ts` already compares `Math.abs(tx.amountCents)`, so both sides were
magnitude-based. The gate alone was the blocker.

## Decision

The expected money flow is the exclusive or of two facts that each reverse it:

```
expectsMoneyIn = (direction === "outgoing") XOR (totalAmountCents < 0)
```

| Document | Total | Money |
| --- | --- | --- |
| Supplier invoice | positive | out |
| Supplier credit note | negative | **in** |
| Our invoice | positive | in |
| Our credit note to a customer | negative | **out** |

The signal needs no new field: a credit note's total is already stored negative
(decisions/0021-extraction-direction-and-invoice-fields.md). `directionMatches` therefore takes
the total as well as the direction, and remains the one function every stage calls. A
zero-amount transaction still matches nothing, and a zero-total document counts as ordinary,
never as a credit note.

## Consequences

- Both Musterbank documents matched on the next run, automatically (exact amount, exact date,
  exact counterparty) and are now `paid`. The third unmatched document, a 10,00 EUR fee from
  the Stadt Beispielstadt, stays open and correctly so: there is no payment for it in the bank data at
  all.
- Any supplier refund booked as a negative invoice now reconciles by itself, which was
  previously impossible rather than merely unlikely.
- "Paid" reads oddly for a credit note we RECEIVED money for. The status set is shared with
  ordinary invoices and `settled` is taken by another meaning, so the wording is left alone
  rather than complicated; the amount's sign says what happened.
- No new document kind. A `credit_note` kind would also make the distinction visible in the
  inbox and the export, and is worth considering separately, but it is not needed to make the
  money move the right way.

## Alternatives considered

- **A `credit_note` document kind driving the gate.** Rejected as the fix: the sign is already
  there and is extracted per document, while a new kind would need the classifier to learn it
  and would leave every already-stored credit note unmatched until reprocessed.
- **Letting the matcher try both directions and rank by evidence.** Rejected: "never cross" is
  the one rule in this module with no exception, and weakening it to catch a case the data
  already distinguishes would trade a sharp invariant for a guess.
