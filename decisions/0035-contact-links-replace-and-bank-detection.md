# Contact links that replace instead of append, and bank detection

Document type: decision
Lifecycle: active
Owner: src/modules/contacts
Scope: `replaceDocumentLinks` (`src/persistence/use-cases/contacts-use-cases.ts`), the new
`DocumentContactRepository.unlinkAllForDocument`, `isLikelyBank`
(`src/modules/contacts/core/bank-detection.ts`), and the loosened `name_only_unique` matching
rule (`src/modules/contacts/core/matching.ts`)
Canonical responsibility: Active source for why a document's contact links are removed and
rewritten from scratch on every processing run instead of accumulated, how "one role per
contact per document" is enforced without a schema change, the conservative bank-detection
heuristics (address-gated, self-exclusion on the bankName-reference rule), why the workspace's
own IBAN and VAT id are stripped from every party BEFORE any identity check runs (not just
before the final write), and why the name-only matching rule is loosened no further than
"exactly one existing candidate"
Maintenance triggers:
- A new `DocumentContactRole` is added, changing the role-priority order
- The bank-name-token list needs a new entry, or a real false positive/negative shows a
  heuristic is mistuned
- H2's wave-2 wiring (H-contract.md) changes what `replaceDocumentLinks` receives from the
  pipeline (e.g. `ownCompany`/`ownIbans` sourcing)
- The own-company exclusion (`isOwnCompany`, `src/modules/contacts/core/own-company.ts`,
  owned by H1) gains new rules that change what a caller can rely on being filtered upstream
- The duplicate-job-enqueue cause behind section 4a's documented race is diagnosed/fixed
  elsewhere, at which point that section's residual gap can be reassessed
Last verified: 2026-09-22, revised same day after coordinator review: rule 1 no longer
self-matches and every bank rule now requires no address (fix 1); own IBAN/VAT id are now
stripped before `isOwnCompany`/`isLikelyBank` run, not only before the final write (fix 2)

## Status

Accepted

## Context

The owner's own outgoing invoice (document 12) produced five `document_contacts` rows from
three pipeline runs 22 seconds apart:

| contact | role | created |
|---|---|---|
| Musterfirma (the owner's own brand) | recipient | 08:54:14 |
| Beispielkunde Nord eGbR (the real customer) | sender | 08:54:14 |
| MUSTERBANK PAYMENTS (the owner's own bank) | mentioned | 08:54:14 |
| MUSTERBANK PAYMENTS | recipient | 08:54:25 |
| Beispielkunde Nord eGbR | recipient | 08:54:36 |

Three things went wrong at once:

1. **Reprocessing appends, never replaces.** `upsertFromExtraction`'s only write path is
   `DocumentContactRepository.link`, and nothing ever removes a document's existing links, so
   a document processed more than once (a retry, a re-run) accumulates every run's parties on
   top of the last. The same real customer ends up BOTH `sender` (run 1) and `recipient`
   (run 3) on the very same document - a straightforward contradiction the composite primary
   key `(document_id, contact_id, role)` cannot itself prevent, since `sender` and `recipient`
   are two different rows by definition.
2. **A bank became a contact, carrying the workspace's own IBAN.** "MUSTERBANK PAYMENTS" is the
   owner's own bank, stated in the invoice's footer/payment-details block. Nothing in the
   pipeline ever asked "is this party actually a bank, not a business relationship" - the
   analyzer extracts "every company named on the document" (H-contract.md's product-decision
   context), and a bank's own name is exactly that.
3. **The workspace's own brand became three separate contacts.** "Musterfirma" appears in the
   document's footer, without a postal code (a footer rarely repeats the sender's full
   address). Existing matching rule 5 (`name_normalized` + `postal_code`, both exact) cannot
   fire without a postal code, so every run's footer mention created a brand-new contact
   instead of matching the one from the previous run.

Consequence: `resolvePrimaryContact` (`src/persistence/use-cases/payments-use-cases.ts`) takes
"the first link with the expected role" for a document. With three `recipient` rows on this
one invoice, the first one returned was the owner's own brand, not the real customer - payment
matching would have looked for payments from the wrong party.

This ADR is H3's slice of a three-agent effort (H-contract.md): H1 extends the company profile
(aliases, IBANs, domains) that feeds `isOwnCompany`; H2 owns classifying the document kind and
deriving the counterparty's role/relation type in code (`planCounterparty`) instead of asking
the model an open-ended "list every company" question, and (in a later wave) wires all of this
into the processing pipeline. This phase covers only the writing side: given whatever parties
the pipeline decides to extract, how they become `document_contacts` rows without repeating
the observed defect - `replaceDocumentLinks` compiles and is fully tested now, but nothing in
the live pipeline calls it yet (that wiring is wave 2's job, after H1/H2/H3 all land on `main`).

## Decision

### 1. `replaceDocumentLinks` replaces, never appends

`ContactUseCases.replaceDocumentLinks` (`src/persistence/use-cases/contacts-use-cases.ts`) is
the pipeline's new one entry point for writing a document's contact links, superseding the
per-party `upsertFromExtraction` loop. In one transaction:

1. Every existing `document_contacts` row for the document is removed
   (`DocumentContactRepository.unlinkAllForDocument`, new).
2. Each given party is matched-or-created and diffed exactly like `upsertFromExtraction`
   already does (see "Reuse, not duplication" below) - EXCEPT own-company and bank parties,
   which are skipped before matching ever runs (see sections 3-4).
3. The surviving parties are reduced to one role per contact (section 2) and only THEN linked.

Doing the remove and the rewrite in the same transaction means a concurrent reader (the
document detail page, `resolvePrimaryContact`) never observes the document with zero links in
between - it sees either the previous run's complete link set or the new run's, never neither.
A reprocessing run therefore always produces exactly the links of its own run, closing the
"same contact ends up both sender and recipient across runs" defect at the root, independent
of whatever the other two fixes below additionally prevent within a single run.

No retry-on-unique-violation the way `upsertFromExtraction` has: that retry exists because
`upsertFromExtraction` is called once per party, from outside any single all-or-nothing
transaction, so a race with ANOTHER concurrent call for the same never-seen VAT id is a normal
occurrence worth recovering from. `replaceDocumentLinks` already commits its whole party list
atomically; a unique-constraint failure inside it aborts the whole transaction, and the caller
(the job queue) simply retries the whole document - the same failure mode every other
transactional use case in this codebase already has.

### 2. One role per contact per document, enforced in code

No schema change: the composite primary key on `document_contacts` stays
`(document_id, contact_id, role)` exactly as it is. Deliberately not changed to
`(document_id, contact_id)` with role as a plain column - that would collide with H1's own
migration landing on the same table set in the same wave (H-contract.md's "Two waves"
constraint: no wave-1 branch may need a schema change another wave-1 branch might also touch).
Instead, `replaceDocumentLinks` computes, in memory, which role wins when two or more parties
in the SAME call resolve to the same contact:

```
sender / recipient  (priority 3, equal to each other)
  > on_behalf_of     (priority 2)
    > mentioned       (priority 1)
```

`sender` and `recipient` are deliberately equal-ranked, not one preferred over the other: the
observed defect was exactly a party carrying both in the same run (a genuine extraction
contradiction), and there is no principled reason to prefer one label over the other when that
happens. The tie is broken by keeping whichever the extraction listed first - deterministic,
but not meaningfully "correct" in either direction; H2's `planCounterparty`
(H-contract.md section 2) is the real fix for this ambiguity going forward, since it derives
`ourRole`/`counterpartyRole` from the document's kind in code rather than trusting the model's
own role labels for a document kind that has a reliable answer.

Contacts that resolve to different roles are still each individually matched/created/diffed
(fields get filled, proposals get raised) even when their role ultimately loses the priority
reduction - only the LINK written is deduplicated to the winning role, not the underlying
contact-record work.

### 3. `isLikelyBank`: conservative bank detection

New pure module `src/modules/contacts/core/bank-detection.ts`. Missing a bank is a cosmetic
annoyance (one extra contact, correctable by deleting it); swallowing a real customer as a
"bank" would silently drop a genuine business relationship from the contact list.

**Revised after review** (the module's first version made rule 1 compare a party against
`allParties` INCLUDING ITSELF, and did not gate rules 1-3 on address at all - internally
inconsistent with its own header comment, and it broke on two real cases: an incoming fee
invoice FROM a bank, whose own sender/recipient party legitimately restates its own name as
its own `bankName` and self-matched rule 1; and a bank's own letter, sent from its own
letterhead address, which rule 3's name-token check would still flag despite having a real
address, since the original rule 3 only excluded VAT id, not address). The property that
actually distinguishes a footer bank mention from a real business party (including a real
invoice sent BY a bank) is address, not name or VAT status: a document naming its payee's bank
prints that bank's name/IBAN/BIC in a payment-details block, never the bank's own building's
street address. The function is therefore gated on that single property FIRST, then matches
only when:

0. `party` has NO address at all (`addressLine1`/`addressLine2`/`postalCode`/`city` all
   blank) - if it does, none of the rules below can fire, whatever the party's name, VAT
   status, or bank fields say. A real invoice sent by a bank (an account-fee invoice) has this
   party carry a full address, so it is never caught here, no matter what else it looks like.
1. The party's normalized name equals the normalized `bankName` of ANOTHER party in the same
   extraction, excluding itself by reference - the exact "MUSTERBANK PAYMENTS" footer case: the
   invoice's own sender/recipient party carried `bankName: "MUSTERBANK PAYMENTS"`, and the analyzer
   separately extracted "MUSTERBANK PAYMENTS" as its own party. Self-exclusion matters because a
   party can legitimately restate its own name as its own `bankName` (an attribution quirk,
   not a footer artifact) - without excluding self, that would match rule 1 regardless of the
   address gate's own address check on a DIFFERENT, hypothetical no-address case.
2. The party carries a bank field (`iban`/`bic`/`bankName`) AND has nothing else that would
   make it a real business relationship: no VAT id, no customer number, no register data
   (address is already excluded by rule 0's gate).
3. The party's name matches a bank-name token (`Bank`, `Sparkasse`, `Volksbank`, `Raiffeisen`,
   `Kreditbank`, `Bausparkasse`, `Payments`, `Payment Services`) AND has no VAT id.

Rule 2's slightly wider condition set (also excluding a customer number or register data)
reflects that a bare IBAN/BIC/bank-name party with genuinely nothing else attached is a
stronger signal on its own, even without a bank-sounding name (a bank stated only as an
account holder's institution, with no name of the bank itself extracted). A party with a full
address is never a bank here, whatever it is called or however bare its other fields are -
"Deutsche Bank Immobilien GmbH" with a full address and a VAT id was always the intended
non-match; "Sparkasse Oberland" writing an ordinary letter from its own letterhead address is
now equally protected, and so is a genuine incoming invoice FROM a bank charging account fees.

`replaceDocumentLinks` calls `isLikelyBank` against the FULL, SANITIZED party list for the
current run (`allParties` - see section 4 below for why sanitized), so rule 1 can see across
parties within one document while excluding self, and increments `skippedBank` for every
party it filters - a document with a detected bank ends up with fewer links than parties
given, never a contact record for the bank itself.

### 4. Our own identifiers are stripped BEFORE any identity check

`replaceDocumentLinks` calls `isOwnCompany` (`src/modules/contacts/core/own-company.ts`, owned
by H1) and `isLikelyBank` before matching, the same defense-in-depth H2's pipeline code is
also expected to apply before ever calling this method. `ownCompany` is `null`-safe (a
workspace with no company profile filled in simply never filters anything, `isOwnCompany`'s
own existing contract).

**Revised after review**: the first version ran these two identity checks on the RAW extracted
party and only stripped our own IBAN from a party AFTER deciding to keep it. That is backwards
for exactly the same reason this whole feature exists: the model's attribution of an
identifier to a PARTICULAR party is an unreliable signal, not a settled fact. On an outgoing
invoice, the only IBAN printed is OURS, as the payee - the model has to guess which extracted
party that payment-details block "belongs to" when reasoning about the document as a whole,
and can attach it to the customer party instead of recognizing it as our own. Two concrete
failure shapes this creates if identity checks run first:

- H1 is expected to add an `isOwnCompany` rule "party IBAN is one of ours -> own company"
  (H-contract.md section 1's `isOwnCompany` decision order, rule 2). A real customer whose
  party the model mis-attributed our own
  IBAN to would be silently skipped as "own company" - the real customer vanishes from the
  contact list entirely, the more dangerous failure direction (a missed exclusion is merely
  cosmetic; a wrongful one is data loss).
- `isLikelyBank` rule 2 would call a bare customer name plus our own misattributed IBAN a
  bank (if the model also missed extracting that party's address), for the same underlying
  reason.

The fix: `replaceDocumentLinks` builds a SANITIZED copy of every party FIRST -
`stripOwnIdentifiers` drops `iban` when it equals (normalized) any entry of `ownIbans`, and
drops `vatId` when it equals (normalized) `ownCompany.vatId` - before `isOwnCompany` or
`isLikelyBank` ever see any party, and before matching/creation runs. `allParties` passed to
`isLikelyBank` is the sanitized list too, so rule 1's footer-reference check compares against
already-sanitized `bankName`/name values consistently. Our own identifiers therefore never
decide whether a party is us or is a bank inside link writing; only the party's OWN identity
(name, aliases, domain, postal code - none of which come from a payment-details block that
could plausibly describe a different party) does that. Whichever party is kept after these
checks already has its own-identifier fields stripped, so no separate "strip afterward" step
is needed anymore - sanitizing once, up front, covers both the identity checks and the final
written contact.

This means `isOwnCompany`'s VAT-id rule (the only rule the module has today, alongside postal
code + name similarity) is effectively unreachable from inside `replaceDocumentLinks` for the
specific value that would trigger it: a party whose VAT id equals `ownCompany.vatId` always
has that field nulled out before `isOwnCompany` runs. This is intentional, not an oversight -
the workspace's own company is still correctly excluded whenever its documents also carry a
matching NAME (or, once H1 lands its planned alias/domain rules, an alias or domain), which is
the common case for a real letterhead; a document that identifies the workspace's own company
ONLY by VAT id and by nothing else recognizable is an edge case accepted as a residual gap
rather than reopening the door to a misattributed VAT id being trusted.

The rest of a party's fields are kept when an own identifier is stripped from it - a shallow
copy with only the matching field(s) set to `null`, never dropping the whole party.

### 4a. A known, accepted race: two concurrent runs of the same document

`replaceDocumentLinks` guarantees atomicity WITHIN one call (its own remove-then-insert is one
transaction), not ACROSS two concurrent calls for the same document. If the job queue ever
enqueues two `process-document` jobs for the same document (a separate, not-yet-diagnosed
cause; not this ADR's concern), two concurrent `replaceDocumentLinks` transactions running
under Postgres's default READ COMMITTED isolation can each fail to see the other's freshly
inserted rows (a statement's MVCC snapshot is fixed when that statement starts, including
after it was blocked and resumes on a lock release) - the practical result is that the SECOND
transaction's `unlinkAllForDocument` removes only the rows that existed before both started,
never the first transaction's newly-inserted rows, so both transactions' link sets end up
coexisting instead of the second cleanly replacing the first. That reproduces the same kind of
same-document contradiction (e.g. a contact ending up both `sender` and `recipient`) this ADR
exists to eliminate - transient, not a permanent regression (the next real reprocessing run
still cleans it up), but worth naming as a residual gap rather than silently assuming
"transaction" already means "safe across concurrent calls too". Not fixed here: the fix
belongs with whatever eliminates the duplicate-enqueue in the first place.

### 5. `relationType`: written on create, or when still unset, never overwritten

Matches the module's existing no-silent-overwrite discipline for every other field
(decisions/0019-contacts.md): after the role-priority reduction picks a winning party per
contact, its `relationType` (already decided by H2's `planCounterparty` in code, from the
document's kind - never asked of the model, H-contract.md section 2) is written only when the
contact's current `relation_type` is `null`. A contact whose relationship a human has already
set (or a previous, already-decided run has set) keeps it, even if a later run's
`planCounterparty` would suggest something different - the same reasoning that already governs
every other comparable field on a contact.

### 6. Matching rule 6, `name_only_unique`: loosened carefully

`pickBestMatch` (`src/modules/contacts/core/matching.ts`) gains one new, explicitly weak rule,
tried last: when the extraction carries NO postal code at all, an exact `name_normalized`
match against EXACTLY ONE existing candidate is a match. More than one candidate sharing that
name stays ambiguous and yields no match, the same ambiguity handling every other rule in this
function already has. This rule only ever fires when rule 5 (name + postal code) could not
even be attempted (no postal code on the extraction) - the two rules never compete for the
same extraction.

This alone would have stopped the three "Musterfirma" rows in the observed defect: a footer
mention with no postal code, run against a workspace that (by the second run) already has
exactly one "Musterfirma" contact, now matches it instead of creating a second. Loosened no
further than exact-name-plus-uniqueness: still name-only (no fuzzy similarity, no match weaker
than what `normalizeName` already folds together for every rule here), and still strictly
ambiguous (not "no match") the moment a second same-named contact exists in the workspace -
the same conservative posture as every other weak rule in this function.

### 7. Reuse, not duplication

`upsertFromExtraction`'s matching/fill-or-propose/create logic is extracted into a shared
internal helper (`upsertContactOnly`) that does everything except write the document link
itself. `attemptUpsertFromExtraction` (the transaction body behind `upsertFromExtraction`) is
now a thin wrapper: call `upsertContactOnly`, then link with the one role it was given.
`replaceDocumentLinks`'s transaction body calls the same `upsertContactOnly` for every
surviving party, then applies its own role-priority reduction before linking. No matching,
diffing, or verification logic is duplicated between the two entry points.

### 8. `resolvePrimaryContact` needs no change

`payments-use-cases.ts`'s `resolvePrimaryContact` ("first link with the expected role, else
any non-`mentioned` link, else the first") was ambiguous specifically because a document could
carry more than one `sender` or `recipient` link (the observed defect). With
`replaceDocumentLinks` guaranteeing at most one link per contact per document AND no bank/
own-company contacts ever linked, a document normally carries at most one `sender` and one
`recipient` link once wave 2 wires this method into the pipeline - `resolvePrimaryContact`'s
existing fallback chain becomes unambiguous on its own, with no code change needed there. This
is not yet observable in the live pipeline: wave 2 (after H1/H2/H3 all land on `main`) is what
actually calls `replaceDocumentLinks` instead of the old per-party loop.

## Consequences

- Positive: reprocessing a document is now idempotent with respect to its own links - the
  exact observed five-row pileup from three runs of one document is now impossible, proven by
  a unit test replaying that table's three runs in sequence and asserting exactly one link
  remains.
- Positive: a workspace's own bank can no longer become a "Firmenkontakt" carrying the
  workspace's own IBAN, closing the specific data-integrity issue that made `resolvePrimaryContact`
  pick a bank/own-brand contact over the real counterparty - and a real incoming invoice sent
  BY a bank (an account-fee invoice) is no longer at risk of losing its own sender to the same
  heuristic (fix 1).
- Positive: no schema change and no migration - avoids a wave-1 migration collision with H1's
  own `workspaces` column additions landing in the same window (H-contract.md).
- Positive: a party the model mis-attributed one of our own identifiers to (an IBAN or VAT id
  that is genuinely ours, printed on the document, but pinned by the model to the wrong
  extracted party) can no longer be silently skipped as "own company" or misclassified as a
  bank - only the party's own identity (name, aliases, domain, postal code) ever decides that,
  and the misattributed identifier is stripped before it can decide anything or land on a
  contact (fix 2).
- Negative / accepted risk: `isLikelyBank`'s conservativeness means a bank stated with almost
  no other information but ALSO a bank-unrelated name (no address, no VAT id, no bank-name
  token, but also no `iban`/`bic`/`bankName` field extracted at all) is not caught - accepted,
  since the alternative (a looser heuristic) risks the worse failure of dropping a genuine new
  business contact that simply has not given its address yet.
- Negative / accepted risk: stripping our own VAT id before `isOwnCompany` runs makes that
  module's existing VAT-id rule unreachable for the one value that would trigger it inside
  `replaceDocumentLinks` - accepted, since the workspace's own company is still excluded
  whenever a document also identifies it by name (the common case), and trusting a
  model-attributed VAT id to decide identity is exactly the failure mode fix 2 closes (see
  section 4's final paragraph for the full reasoning).
- Negative / accepted risk: the `sender`/`recipient` tie-break (section 2, "first seen wins")
  is not a principled resolution of a genuine extraction contradiction, only a deterministic
  one - accepted for wave 1, since H2's `planCounterparty` (deriving the expected role from
  the document's kind rather than trusting the model) is the actual fix for why that
  contradiction happens in the first place, and lands with wave 2's pipeline wiring.
- Negative / accepted risk: two concurrent `replaceDocumentLinks` calls for the same document
  (a duplicate-enqueued job, a separate, undiagnosed cause) can each fail to see the other's
  freshly-inserted rows under READ COMMITTED, leaving both runs' link sets coexisting instead
  of one cleanly replacing the other - see section 4a. Not fixed here.
- Implementation status: **implemented, not yet wired into the live pipeline**.
  `replaceDocumentLinks`, `unlinkAllForDocument`, `isLikelyBank`, and the `name_only_unique`
  matching rule all ship in this change with full unit/DB test coverage; nothing in
  `src/modules/documents`' processing pipeline calls `replaceDocumentLinks` yet (wave 2's job,
  H-contract.md).

## Supersedes / Superseded By

- None. Extends decisions/0019-contacts.md's matching order and verification semantics
  (adds rule 6, keeps rules 1-5 unchanged) rather than superseding it.
