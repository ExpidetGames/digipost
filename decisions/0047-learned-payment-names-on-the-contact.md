# Learned payment names: learned on every confirmation, keyed by merchant, shown on the contact

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: `maybeLearnAlias`, `aliasKeyForCounterparty`, `applyAliases`, and the "Namen in Zahlungen"
section on `/dashboard/contacts/[id]`
Canonical responsibility: Active source for when a counterparty name is learned as belonging to a
contact, under which key, and where a human sees and removes it
Maintenance triggers:
- A bank formats card counterparty names differently
- Learned names should also apply to foreign-currency matching
Last verified: 2026-09-22, initial version

## Status

Accepted

## Context

The owner asked that booking an invoice to a transaction whose company names differ should
remember the other name for the contact. Learning already existed (decisions/0023's aliases) but:
the auto-confirm policy of decisions/0044 did not learn at all; the key was the full normalized
counterparty name, so a card debit "FACEBK *QX7MNP41KD,fb.me/ads" would never match next month's
"FACEBK *AB12CD34EF,fb.me/ads"; identical names were learned too; and nobody could see or remove a
learned name.

## Decision

- Every confirmation learns, manual or automatic (in-run auto-confirm and the policy pass).
- Only a name that differs from the contact's (similarity below the rules threshold) is learned.
- The key is the merchant part: the name before the first comma, with an asterisk reference that
  mixes letters and digits removed ("facebk", "automattic"). Lookup tries this key first, then the
  old full-name key, so earlier aliases keep working.
- The contact detail page lists the learned names under "Namen in Zahlungen" for users with
  `finance.read` (a bank counterparty name is finance data), with a remove button for
  `finance.manage`.
- One-time local backfill: confirmed links were re-read with these rules (two names learned) and
  aliases identical to their contact's name were removed.

## Consequences

- Positive: confirming a suggestion once lets the rules stage match the same payer next month; in
  mode "system" it is then booked automatically.
- Negative: learned names do not help foreign-currency documents, which the rules stage skips
  (decisions/0044); those stay with the AI stage.
