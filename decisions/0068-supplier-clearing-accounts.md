# A supplier billed by threshold gets a clearing account

Document type: decision
Lifecycle: active
Owner: src/modules/accounts
Scope: A clearing account owned by a contact, how its two sides are booked, and what payment
matching stops doing for that contact
Canonical responsibility: Active source for how a supplier whose invoices and charges do not
line up is settled
Maintenance triggers:
- A second supplier needs one (check the matching exclusion still holds)
- The sign convention or the payment status of a booked invoice changes
Last verified: 2026-10-03, measured on a sample workspace: 12 invoices and 6 charges booked,
balance -0,60 EUR, all 12 documents `settled`, no Meta charge left unexplained, a second pass
and a full matching run both no-ops

## Status

Accepted and implemented (migration `0020_concerned_blue_shield`).

## Context

Meta bills per advert and charges on a spending threshold, so the two sides are cut
differently and can never pair one to one. Sample data over January to March 2025:

| | Invoices | | Charges | |
| --- | --- | --- | --- | --- |
| Januar | 8 | 30,00 EUR | 6 | 50,40 EUR |
| Februar | 3 | 15,00 EUR | 0 | 0 |
| März | 1 | 6,00 EUR | 0 | 0 |
| **Total** | **12** | **51,00 EUR** | **6** | **50,40 EUR** |

Nothing reconciles per month; over the period the two sides are 0,60 EUR apart. All twelve
invoices sat at `open` forever, and the matching engine kept proposing pairings between
identical 2,00 EUR amounts, two of which were rejected by hand. The engine was not wrong
about the amounts; the question it was asked has no answer.

This is exactly what a clearing account is for, and the product already has two of them for
Apple and Google. They are tied to a settlement platform, created by importing that platform's
report. Meta publishes no report, and `SETTLEMENT_PLATFORMS` describes file formats this
application can read, so putting Meta in it would overload what that list means.

Scope check before building: Meta is the only supplier in the sample workspace with more than
one open invoice (the other, Musterbank, has two open notes totalling 1,50 EUR). One supplier is
thin justification on its own, but threshold billing is the norm for advertising and cloud
vendors, so the next one is a question of when.

## Decision

**A clearing account may be owned by a contact** instead of a platform: `accounts.contact_id`,
nullable, at most one clearing account per contact per workspace. Creating it IS the switch;
there is no separate flag on the contact to keep in step with it.

**Both sides book onto it:**
- An incoming invoice from that contact books a negative amount (the liability grows),
  idempotent per document, and the document's payment status becomes `settled` rather than
  `open`. It is settled, just not by a payment of its own.
- A bank charge whose counterparty resolves to that contact books the opposite sign on the
  clearing account and is tied to the bank row by `transferGroupId`, exactly as
  `recordPlatformPayout` already does for an app-store payout.
- The balance is therefore what is still owed. `51,00` invoiced minus `50,40` charged leaves
  `-0,60 EUR`.

**Resolving a bank charge to the contact** uses the matching the product already has: the
contact's learned payment names first (decisions/0047), otherwise the single best contact at or
above the existing `NAME_MATCH_THRESHOLD` using the card-merchant comparison
(decisions/0046). A tie resolves to nothing. It is deliberately conservative: no resolution
means the charge stays unexplained and visible, which is the safe failure.

**This paragraph was wrong when first written, and the correction is the feature's hinge.** It
claimed the card-merchant tolerance already turns `FACEBK *QX7MNP41KD,fb.me/ads` into "Meta
Platforms Ireland Limited". It does not: after the reference is stripped, the comparison is
"facebk" against "meta platforms ireland limited", similarity zero, and no learned alias could
ever exist for this contact because matching is precisely what we are switching off for it. As
written, the feature would have booked none of the six charges. The account's creation form
therefore carries an optional **"Name auf dem Kontoauszug"**, stored through the existing
`payment_aliases` mechanism under the same merchant key. A supplier whose bank name does not
resemble its invoice name is the normal case for card billing, not an exception, so asking once
at creation is the right place for it.

**Payment matching stops proposing pairings for that contact**, in both directions. This is the
point, not a side effect: two wrong Meta suggestions came from asking a question with
no answer, and rejecting them one at a time would never end.

**Creating the account books the history.** The contact's existing invoices and the already
imported charges are booked when the account is created, or the balance would start as a lie.

## Consequences

- Twelve permanently open documents become one account with a visible residue, the same shape
  as Apple's 0,01 EUR which users already read correctly.
- **The opening balance is unknown unless the earlier invoices exist.** The two 20,00 EUR
  charges of early January predate the first invoice in the system and almost certainly settle
  December 2024 adverts nobody has uploaded. The account therefore shows "0,60 EUR unexplained
  across the period we hold", not "0,60 EUR owed", and the UI has to say so rather than imply a
  precision it does not have. Same situation as the missing Google December 2024 report.
- A clearing account now has two possible owners. A check constraint enforces that exactly one
  of `platform`/`contact_id` is set, and a partial unique index allows one clearing account per
  contact. The contact foreign key is `on delete set null`, never cascade: deleting a contact
  must not delete booked financial history.
- `unmatchedTransactionConditions`, the single definition behind "Buchungen ohne Beleg" and the
  Abschluss count, gained `transfer_group_id is null`: a charge tied into a clearing account is
  explained by it. No existing row changed meaning, since every bank row with a transfer group
  already had a confirmed document link.
- **Merging contacts does not repoint a clearing account.** `mergeContacts` moves document links
  and proposals but not `accounts.contact_id`, so merging away a contact that owns one nulls the
  column and leaves an orphan ledger. Known, not yet fixed, and the reason the foreign key sets
  null rather than cascading: an orphan ledger is recoverable, deleted bookings are not.

## Alternatives considered

- **Mark the twelve invoices "ohne Zahlung erledigt" and the six charges "kein Beleg nötig".**
  Possible today, in minutes, and rejected: both statements are false. The invoices exist and
  the charges do have documents behind them; only the pairing is impossible. It would also
  leave no balance anywhere, so the 0,60 EUR would simply vanish.
- **Add `meta` to `SETTLEMENT_PLATFORMS`.** Rejected: that list says which report formats the
  intake can read, and Meta has none. Tying the account to the contact is both truer and more
  general, since the next such supplier will also just be a contact.
- **Teach the collective matcher to span months.** Rejected: the subset sums do not line up
  even over the full period, and a matcher that searches harder on data this ambiguous produces
  confident nonsense, which is what it already did.
