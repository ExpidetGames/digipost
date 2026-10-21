# Guided extraction: classify first, derive our role, ask one narrow question

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The order in which the processing pipeline classifies a document versus extracts its
parties, the new `CounterpartyPlan`/`planCounterparty` lookup table, the two guided analyzer
prompts (`"derived"`/`"open"`), the new `DocumentAnalyzer.analyzeGuided` method, a reminder's own
direction rule, and the self-counterparty guard against a misclassified kind
Canonical responsibility: Active source for why the analyzer is now told the document's kind and
its own role instead of being asked to find and label every party itself, for the plan table that
decision is built on, and for the deterministic guard against the residual "wrong kind" risk that
decision introduces
Maintenance triggers:
- `planCounterparty`'s table changes (a `DocumentKind` moves between `"derived"`/`"open"`/`"none"`,
  or a `"derived"` kind's `ourRole`/`counterpartyRole`/`relationType` changes)
- The guided prompts' JSON contract, exclusion wording, or brand-name policy changes
- A reminder's direction rule changes, or a reminder starts entering payment matching
- The self-counterparty guard's sanitizing rule changes (kept in sync with
  `src/persistence/use-cases/contacts-use-cases.ts`'s own `stripOwnIdentifiers` - see
  `core/self-counterparty-check.ts`'s header comment)
Last verified: 2026-09-22, wave 2 (`feature/guided-extraction-wiring`, off `main` at `e203052`
after all three wave-1 branches merged): `processOcrDocument` switched over, the review
corrections applied (no brand names in the prompt, `isOwnCompany`'s IBAN rule stays removed, the
existing `isInvoiceShaped` rule kept exactly with only the reminder exception), and the
self-counterparty guard added

## Status

Accepted

## Context

The owner's own outgoing invoice, reprocessed three consecutive times with the same document,
prompt, and model (`ministral-8b-latest`), produced 5 distinct contact links across those three
runs, including:

- **the owner's own bank** ("MUSTERBANK PAYMENTS", a payment-provider footer line) linked as a
  business contact, and
- **the owner's own company**, under its brand name ("Musterfirma"), linked as a contact of
  itself, three separate times with slightly different party lists.

decisions/0031 and decisions/0032 had already established, from this exact same document, that
`documents.kind` (a separate classifier call) stayed correct across every run while the
analyzer's own per-party `role` hints did not - `kind` is a reliable signal, a role label is not.
Both ADRs used that finding to fix the SYMPTOM (direction flips based on unreliable role labels)
by making `kind` outrank the party roles when `decideDirection` runs. Neither fixed the root
cause: the analyzer was still being asked the wrong question in the first place -
"list every company mentioned on this document and guess what each one is" - which is exactly
how a payment provider's footer line and the workspace's own letterhead end up on that list at
all. Worse, `kind` itself was only computed AFTER the analyzer ran (the OCR branch classifies
`kind` from the same OCR text, but historically as a follow-up step, not a precondition) - too
late to change what the analyzer was asked.

The fix decided with the owner: **classify the document's kind first, derive the workspace's own
role from that kind in code, and ask the model exactly one narrow question** - "who is the
counterparty" - phrased differently depending on the kind, rather than the same generic
"list everyone" question for every document.

## Decision

1. **Classify `kind` before the analyzer runs, not after** (wave 2). The OCR branch's existing
   `IntakeClassifier` call moves earlier in `processOcrDocument`. A self-identified ZUGFeRD
   invoice's kind-guessing fallback had to change shape, not just move: the OLD fallback guessed
   from the (ungated) analyzer's own extracted parties, which only existed because the analyzer
   had already run - exactly the ordering this ADR eliminates. `resolveZugferdKind` reads the CII
   XML's own seller/buyer names directly instead (`extractZugferdInvoiceFields` already extracts
   both) and needs no model call at all, matching the "self-identifying format, no classifier"
   rule camt.053/MT940 already follow.

2. **`planCounterparty(kind)`** (`src/modules/documents/core/party-roles.ts`, wave 1, pure,
   dependency-free): a lookup table, not a model call.

   | kind | mode | ourRole | counterpartyRole | relationType |
   |---|---|---|---|---|
   | `outgoing_invoice` | derived | sender | recipient | `customer` |
   | `incoming_invoice` | derived | recipient | sender | `supplier` |
   | `receipt` | derived | recipient | sender | `supplier` |
   | `platform_settlement` | derived | recipient | sender | `null` |
   | `payout_report` | derived | recipient | sender | `null` |
   | `authority_letter` | derived | recipient | sender | `authority` |
   | `bank_statement` | none | - | - | - |
   | `reminder` | open | - | - | `null` |
   | `letter`, `contract`, `other` | open | - | - | `null` |

   `relationType` comes from this table alone, in every future wave, never from a model answer -
   the same "a kind is a reliable signal, a role label is not" reasoning decisions/0032 already
   established for direction, now applied one level earlier, to role assignment itself.

3. **Two prompt shapes, chosen by `plan.mode`** (`src/platform/mistral/server/prompts.ts`):
   - **`"derived"`** (`buildGuidedDerivedSystemPrompt`): states the kind and the workspace's own
     role as an established FACT ("Dies ist eine Ausgangsrechnung des Unternehmens des Nutzers.
     Das Unternehmen des Nutzers ist der Absender.") and asks for exactly ONE counterparty object
     - the one in `plan.counterpartyRole` - with no `role` field in the answer at all, because
     the role is never in question. Explicitly excludes banks, tax offices, and register courts,
     and explicitly tells the model to ignore the workspace's own letterhead/address/contact
     details wherever they appear on the page when looking for the counterparty.
   - **`"open"`** (`buildGuidedOpenSystemPrompt`, covers `"open"` and `"none"` plan modes):
     today's "list every party" question narrowed to "the document's real business partners, at
     most 2" (down from 3), the same bank/authority exclusion, and - only for `kind ===
     "reminder"` - an added `"reminderDirection": "received" | "sent" | null` question. For
     `"none"` mode (`bank_statement`) it asks for zero parties outright: a bank statement is the
     workspace's own account activity, not correspondence with a business partner.
   - **Payment providers are excluded from that same clause for every kind EXCEPT
     `platform_settlement`/`payout_report`** (added after review, wave 2): for those two kinds
     the counterparty being asked for IS a payment provider (the platform that issued the
     settlement/payout) - excluding payment providers in that same breath invites exactly the
     wrong answer, a `null` counterparty, for the one case that needs one.
   - **No tenant brand names anywhere in this prompt** (added after review, wave 2): an earlier
     draft named "PayPal, Stripe, MUSTERBANK" in the exclusion clause. MUSTERBANK is one specific
     customer's own bank, and this ONE prompt serves every tenant - a workspace's own bank or
     payment provider belongs in ITS OWN profile text (below), never hardcoded into code every
     other tenant's documents are also analyzed against. A generic example ("die Bank in der
     Fußzeile") replaces the named one.
   - Both prompts place the workspace's own structured profile (name, address, VAT id, and now
     also aliases/own IBANs/domains/free profile text, `OwnCompanyContext`) entirely in the
     SYSTEM prompt, never inside the untrusted `wrapUntrustedSection` document-text block; the
     free profile text is capped at 1000 characters and run through the same
     `neutralizeDelimiterLookalikes` defense `prompt-guard.ts` already applies to the untrusted
     OCR text, as defense-in-depth against a forged delimiter reaching the prompt through that
     free-text field.

4. **`DocumentAnalyzer.analyzeGuided`** (additive beside the existing `analyze`, no longer called
   by `processOcrDocument` since wave 2 - `analyze` itself is still present, unused, pending a
   later cleanup once nothing else needs it): `{ text, fileName, ownCompany, kind, plan }` ->
   `{ category, title, sender, documentDate, summary, counterparty, parties, invoice,
   reminderDirection }`. Implemented in both the real Mistral adapter and the fake analyzer,
   validated by `validateGuidedAnalysisResult` (`core/analysis-validation.ts`) with the same
   never-throws, degrade-to-safe-defaults guarantee `validateAnalysisResult` already gives every
   caller - `plan.mode`, not the model's own JSON shape, decides which of
   `counterparty`/`parties`/`reminderDirection` the answer is even allowed to populate.

5. **A reminder's direction stays the model's own call, with one override.** Unlike every other
   invoice-shaped kind, a reminder has no fixed "who sent this" shape - either party can be the
   one chasing payment. The `"open"` prompt still asks the model directly
   (`resolveReminderDirection`, `core/reminder-direction.ts`, wave 1, pure): a payment IBAN that
   normalizes to one of the workspace's own IBANs overrules the model's answer to `"outgoing"`
   (we are chasing our own payment); a payment IBAN present but not one of ours overrules it to
   `"incoming"`; only with no payment IBAN at all does the model's own answer stand (or
   `"unknown"` when it gave none). This is the same "structured data decides, free text/model
   answers only help" principle `isOwnCompany` already applies to company identity, applied here
   to one IBAN comparison instead.

6. **A reminder's `payment_status` will always be `"not_applicable"`**, regardless of direction
   or amount: the original invoice a reminder chases is already tracked as its own open item, and
   counting the reminder too would double the receivable. The reminder's amount is still
   extracted and shown - it simply never drives `listInvoiceCandidates` or payment matching, and
   is never linked back to the original invoice it concerns (a separate, later task, listed under
   "Deliberately out of scope" below).

   **Payment status.** Three kinds are never payment-matched, whatever direction and amount were
   found: `reminder` (above), `platform_settlement` and `payout_report`. The latter two were
   added at orchestrator review after wave 2: `planCounterparty` now gives them a deterministic
   `incoming` direction, where before they mostly stayed `unknown`. An `incoming` document is
   matched against DEBITS (`src/modules/payments/core/direction.ts`), but the money in a
   settlement or payout report flows TO the workspace, so as an open item it would sit as
   "offen" forever or be paired with an unrelated outgoing payment of the same amount. These
   documents are reconciled by the settlement flow (decisions/0026), not by invoice matching.
   Every other kind keeps decisions/0025's rule (`direction !== "unknown" && amount !== null`).
   Consequence the owner should know: `receipt` and `authority_letter` now reach that rule more
   reliably than before (their direction is deterministic now instead of depending on the
   model's role labels or the text fallback), so a receipt or an assessment notice with an
   amount becomes an open item that payment matching tries to pair with its debit. That is the
   intended purpose of payment matching (a Beleg for every booking); it is recorded here because
   it is a visible change, not a silent one.

7. **`isOwnCompany` still has NO IBAN rule** (reaffirmed after review, H-contract.md section 1's
   step 2, removed before this ADR's own creation): the model's attribution of an IBAN to a
   specific party is unreliable - on a real outgoing invoice the only IBAN printed is ours, and it
   may be hung on the customer party instead. The workspace's own IBAN on the DOCUMENT (its
   `paymentIban` field) stays a fact, used by `resolveReminderDirection` above; the workspace's
   own IBAN on a PARTY decides nothing about that party's identity anywhere in this codebase.
   `replaceDocumentLinks` (decisions/0035) strips a matching own IBAN (and own VAT id) from every
   party before any identity or bank check runs at all - never reintroduced.

8. **The self-counterparty guard** (added after review, "promised to the owner": the residual
   weak spot of "the kind decides the roles" is a WRONG KIND, not a wrong role - an incoming
   invoice misclassified as outgoing would otherwise silently turn the supplier into "our
   customer". In `"derived"` mode, after sanitizing the extracted counterparty EXACTLY the way
   `replaceDocumentLinks` does (`core/self-counterparty-check.ts`'s `isCounterpartySelf`, strips
   a matching own IBAN/VAT id first - deliberately duplicated rather than importing H3's private
   helper, see that file's own header comment), if what remains still resolves to the workspace's
   OWN company via `isOwnCompany` (a whole-name/alias match, a domain match, matching register
   data, or postal-code-plus-similarity - never an identifier that was just stripped), the guard
   fires: `direction` becomes `"unknown"`, nothing is linked, and `kind` is left exactly as
   classified (a human can still correct it from the inbox filter). Made visible on
   `/dashboard/documents/[id]`: whenever `isDerivedCounterpartyKind(kind)` is true and
   `direction` is `"unknown"` - the only way that combination can happen once `"derived"` mode
   exists at all - a short hint tells the user to check whether the document's kind is right.

## Two waves (both complete)

- **Wave 1** (`feature/guided-extraction`): every building block above landed as additive,
  unit-tested code with `main`'s pipeline behaviour unchanged - `processDocument` still called
  the old `analyze()`, `directionFromKind` still treated `reminder` as `"incoming"`, and
  `document_contacts` links were still written by the old per-party loop. Two sibling branches
  built the workspace company-profile columns (`OwnCompanyProfile`'s new
  aliases/ibans/domains/taxNumber/registerCourt/registerNumber fields, `isOwnCompany`'s extended
  decision order, decisions/0034) and the contact-link rewrite (`replaceDocumentLinks`,
  `isLikelyBank`, decisions/0035) in parallel; `OwnCompanyContext`'s four new fields were OPTIONAL
  for this reason, so wave 1 compiled independently of either.
- **Wave 2** (`feature/guided-extraction-wiring`, off `main` at `e203052` once all three wave-1
  branches merged): `processOcrDocument` switched over - classify `kind` first,
  `planCounterparty(kind)`, `analyzeGuided` instead of `analyze`, the now-required
  `OwnCompanyContext` fields filled from the merged company-profile columns,
  `replaceDocumentLinks` instead of the per-party `upsertFromExtraction` loop, `reminder` removed
  from `directionFromKind`, `resolveReminderDirection` wired in, plus the three review corrections
  and the self-counterparty guard (decision points 3/6/7/8 above). `analyze()` and
  `buildAnalyzerSystemPrompt`/`AnalysisResult`/`validateAnalysisResult` were left in place, no
  longer reachable from `processOcrDocument` but still exercised by their own unit tests, rather
  than deleted in the same change that switched the pipeline over - a separate, low-risk cleanup
  once nothing else needs them (`buildAnalyzerUserPrompt` is NOT one of these: `analyzeGuided`
  reuses it unchanged for the untrusted-OCR-text wrapping both prompt styles share).

## Consequences

- Positive: a payment provider, a bank, a tax office, or the workspace's own company can no
  longer become the extracted "counterparty" of an invoice-shaped document by construction - the
  prompt never asks a question broad enough to produce that answer for those six kinds, and
  explicitly excludes them for the remaining `"open"` kinds too.
- Positive: for the six `"derived"` kinds, the counterparty's role is no longer a per-run,
  per-model coin flip - it is a lookup, decided once, in code, from a signal
  (`documents.kind`) already proven stable across runs of the same document (decisions/0031).
- Positive: `parties`/`counterparty` extraction and invoice-field extraction still happen on the
  SAME analyzer call as category/title/sender/date/summary (architecture brief's product
  decision 8, decisions/0021's "never a second model call") - guided extraction narrows the
  QUESTION, not the number of model calls.
- Positive: `receipt`/`platform_settlement`/`payout_report`/`authority_letter` now resolve a
  direction DETERMINISTICALLY (from `plan.ourRole`) for the first time - none of these four kinds
  ever had a `directionFromKind` entry before this ADR, so their direction used to depend entirely
  on the model correctly labelling an own-company party role (unreliable per decisions/0031) or
  the weaker text-evidence fallback, and in practice often stayed `"unknown"` - most consequential
  for `platform_settlement`/`payout_report`, whose counterparty is a payment provider the OLD
  ungated prompt had no special help recognizing at all. This also means these four kinds now
  reliably reach `isInvoiceShaped`/payment matching whenever an amount was extracted, which they
  previously often did not - a real, visible change in finance behaviour the review explicitly
  asked to have called out (H2-wave2.md's correction 3), not something this ADR silently expands.
  `outgoing_invoice`/`incoming_invoice` are unaffected: `directionFromKind` already forced their
  direction deterministically before this ADR (decisions/0031/0032).
- Negative: a misclassified `kind` now has a larger effect than before - for a `"derived"` kind,
  the model is never even asked to reconsider whether it agrees the workspace is really the
  stated role, so a wrong `kind` propagates further into role/relationType assignment than it
  used to. Bounded by decision point 8's self-counterparty guard for the one case that guard can
  detect (the counterparty resolving to the workspace itself); a wrong `kind` between two THIRD
  parties (e.g. `receipt` misclassified as `authority_letter`) is not detectable this way and
  remains visible/correctable only from the inbox filter, the same accepted trade-off
  decisions/0032 already made for direction, extended one level further.
- Negative: the `"open"` prompt now returns at most 2 parties, down from 3 - a document that
  genuinely has 3 distinct business partners loses the third. Judged an acceptable trade-off: the
  overwhelming majority of the pollution observed in the field (banks, payment providers, the
  workspace's own company) came from the generic "list everyone" framing itself, not from a
  document legitimately needing a third slot.
- Neutral: the self-counterparty guard only catches ONE specific failure shape (the counterparty
  resolving to the workspace's OWN company) - it says nothing about whether the counterparty it
  DID accept is the right one. It is a cheap, deterministic backstop for the shape of failure that
  was actually observed and promised to the owner, not a general correctness proof.
- Neutral: `on_behalf_of` stays unused (no third-party extraction is built by any of the three
  parallel branches); no UI is added for a human to say "this is actually us"/"this is actually
  our bank" - both stay explicit, separate, later tasks.

## Deliberately out of scope (this ADR and its two sibling branches)

- The `on_behalf_of` role staying unused - no third party is extracted by any wave.
- "Das sind wir" / "Das ist unsere Bank" correction buttons for a human to flag a
  still-mislabelled row after the fact.
- Cleanup of the already-polluted `document_contacts` rows the owner's own document produced -
  a later, one-off data-migration task, not a code change.
- Linking a reminder to the original invoice it concerns.
- A "take over as open item" action that would let a reminder itself enter payment matching.
- Any new automatic deletion of anything (AGENTS.md's own rule: nothing is auto-deleted except
  the one documented rejected-intake retention cron).

## Supersedes / Superseded By

Amends both of the following without invalidating their own reasoning - both ADRs' underlying
finding (`kind` is reliable, per-party role labels are not) is exactly what this ADR generalizes
one step earlier, from "which signal wins when they conflict" to "what question gets asked at
all":

- **decisions/0031-direction-from-kind-and-short-invoice-numbers.md**: wave 2 removes `reminder`
  from `directionFromKind`'s implied-direction set entirely (this ADR's decision 5) - a
  reminder's direction is no longer inferred from its kind at all, it is asked of the model
  directly and then overruled by the payment-IBAN check. `directionFromKind`'s other two
  entries (`outgoing_invoice`/`incoming_invoice`) are unaffected by this ADR: for those kinds,
  wave 2's `planCounterparty` mode `"derived"` fixes `ourRole` (and therefore direction) outright,
  making `decideDirection`'s own kind-based fallback moot for them in practice, but not wrong -
  `decideDirection` keeps working exactly as decisions/0031 describes for every kind that still
  reaches it in `"open"` mode (a letter, a contract, an authority letter that stays unresolved,
  and - after this ADR - a reminder that reaches it with no payment IBAN at all).
- **decisions/0032-kind-outranks-party-roles.md**: its priority order (kind before party roles)
  remains exactly as decided for every kind that stays in `"open"` mode. For a `"derived"` kind,
  this ADR makes that priority order unnecessary rather than wrong: the model is never asked for
  a role at all, so there is no unreliable role label left to outrank.
