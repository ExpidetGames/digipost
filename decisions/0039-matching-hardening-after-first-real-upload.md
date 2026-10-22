# Matching hardening after the first real bulk upload

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: four fixes found by reviewing a first real bulk upload of outgoing invoices
against imported bank transactions
Canonical responsibility: Active source for the own-IBAN kind correction, the hard-evidence gate
on AI suggestions, the cleanup of suggestions on paid documents, and the single follow-up
matching job per workspace
Maintenance triggers:
- The chat model changes (the gate was motivated by `ministral-8b`'s invented matches)
- A fourth kind of evidence is added to matching
- Matching gains another self-rescheduling job
Last verified: 2026-09-22, initial version

## Status

Accepted. Point 4 refined by decisions/0076-match-after-every-trigger.md (2026-10-22): the check is
now `hasQueuedPending` and counts any queued run, also one due immediately, and a trigger pulls a
queued follow-up forward instead of being swallowed by it.

## Context

A workspace kept its bank statements (a few hundred transactions) and uploaded nine outgoing
invoices. Six were auto-confirmed correctly, two got correct suggestions awaiting a click. Four defects remained:

1. Invoice 7 was classified `incoming_invoice` once (not reproducible in 12 later runs across
   four models), so payment matching searched for a debit and missed its payment "ReNr 7, KdNr
   11". Its payment IBAN was the workspace's own account.
2. The AI arbiter paired unrelated credits with invoices on invented grounds: an Amazon credit of
   219,99 EUR with invoice 9 (250,00 EUR) "because the amounts are very close", "GG1000AB12"
   with invoice 14 "because GG could stand for Generalbau". A benchmark over all 49 transactions
   that reach the AI stage: `ministral-8b` invented 5 of 47, `mistral-small` and
   `mistral-medium` none, `mistral-large` one.
3. The invoice 14 suggestion survived although 14 was auto-confirmed one second later by a
   parallel matching run.
4. Every matching run queued a follow-up six hours later whenever anything was unresolved,
   without checking for an already queued one. Almost every workspace has transactions that never
   get a document, so the chains never ended: 26 were queued after one upload.

## Decision

1. **Own IBAN as payment IBAN means outgoing.** An invoice we must pay carries the supplier's
   IBAN, never ours. If the classifier says `incoming_invoice` but the payment IBAN is one of our
   accounts, the kind becomes `outgoing_invoice` before direction and contact roles are decided.
   Our accounts are the profile's IBANs plus every bank account imported from our statements. The
   reminder direction uses the same set. This is a document-level fact; an IBAN the model
   attributed to a party still decides nothing (decisions/0034, 0035).
2. **An AI pick needs one fact the code can verify** (`hasHardEvidence`): an exact or skonto-range
   amount, the invoice number in the remittance text, the same IBAN, or a counterparty name
   similarity at the rules stage's threshold. Otherwise `validateArbiterResult` drops it. This
   holds for any model, because the benchmark showed even the largest one inventing a match.
3. **A paid document keeps no open suggestions**: dropped whenever its status is recomputed to
   `paid`, and once more at the end of every matching run to catch parallel runs.
4. **At most one scheduled follow-up** `match-payments` job per workspace (`hasScheduledPending`).

The chat model moves from `ministral-8b-latest` back to `mistral-small-latest`, the model the
brief originally intended; the switch to the small one was forced by a subscription-tier
restriction that no longer applies.

## Consequences

- Positive: invoice 7's case is corrected deterministically once its account is known.
- Positive: invented AI matches cannot reach the user, whatever the model does.
- Negative: an AI pick based only on context the code cannot check (for example a payer name
  unlike the contact's) is dropped. It stays unmatched for manual review, never wrongly matched.
- Negative: the own-IBAN rule only knows accounts that are in the profile or imported; an old
  account appearing only on invoices must be added to the profile by hand.
- Neutral: two follow-up jobs can still be queued when two runs finish at the same instant; the
  unbounded growth is gone.
