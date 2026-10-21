# Universal intake: one recognizer for every document, statement, and report

Document type: decision
Lifecycle: active
Owner: src/modules/intake
Scope: The principle behind Digipost's single intake pipeline for every file type it
accepts (scanned paper mail, bank statements, payout/settlement reports, invoices, and
anything else), the deterministic-vs-AI recognition boundary, the taxonomy this phase
introduces, the verify-then-confirm-then-fingerprint flow, content-level duplicate
detection, and exactly what this phase (F1a) implements versus what later phases add
Canonical responsibility: Active source for why file format only decides HOW content is
read while an AI model (checked by code) decides WHAT the content IS, which formats are
instead recognized deterministically and why, the fixed `documentKind`/`platform`/semantic-
field taxonomies, and the "AI proposes, code verifies" contract every classifier
implementation must uphold
Maintenance triggers:
- The document-kind taxonomy, settlement-platform list, or semantic-field list changes
- A new self-identifying (deterministic) format is added, or an existing one's detection
  rule changes
- F1b (persistence, confirmation UI, upload route) or F2 (fingerprint/duplicate wiring) land
  and extend or change what this decision describes as "not yet implemented"
Last verified: 2026-09-20, F1a (universal intake recognizer, core only)

## Status
Accepted

## Context

Digipost launched (P0-P5) as a scanner for paper mail: photograph or upload a PDF/JPEG/PNG,
OCR it, categorize it with a small LLM, route it to a person. The product's next step is
broader: a small business's actual bookkeeping inputs also include bank statements
(CAMT.053 XML exports, bank-specific CSV exports like Musterbank's or Sparkasse's, PDF
statements), payment-provider payout reports (Stripe), platform settlement reports (Apple
App Store, Google Play), the company's own outgoing invoices, and, realistically, whatever
else someone drops into the same inbox. Building a separate, bespoke importer per format
would multiply both the code and the number of places a categorization decision could be
made inconsistently.

The alternative this ADR adopts: **one intake, one recognizer**. The file format decides
only the mechanical question of how to read bytes into structured content (PDF pages via
OCR, XML via a parser, CSV/TSV via a tabular reader). What that content actually IS - a
letter, an invoice, a bank statement, a Stripe payout report - is decided at the content
level, by the same AI-assisted recognition step, regardless of which format carried it in.
This keeps the categorization logic, its taxonomy, and its trust boundary in exactly one
place, rather than duplicated per format-specific importer.

## Decision

### 1. The format-only-decides-how-to-read principle, and its one exception

For any file that does not identify itself unambiguously, this application never lets the
file's format influence what content it is judged to represent. A PDF letter, a CSV bank
export, and an XML settlement report all funnel into the same `IntakeClassifier.classify`
call, on either OCR text or a tabular sample, and the same fixed taxonomy of possible
outcomes applies to all of them.

**The one deliberate exception**: a format that identifies itself unambiguously at the
structural level is recognized deterministically, never by asking a model.

- **CAMT.053** (ISO 20022 Bank-to-Customer Statement) declares its own namespace
  (`urn:iso:std:iso:20022:tech:xsd:camt.053.001.0X`) at the XML root. No other document type
  plausibly declares this namespace by accident; asking a model "is this a bank statement"
  when the file already says so in its own header would only add latency, cost, and a
  (small but real) chance of error for zero informational gain.
- **ZUGFeRD/Factur-X/XRechnung** hybrid invoices embed their own machine-readable XML twin
  as a named PDF attachment (`factur-x.xml`, `zugferd-invoice.xml`, `xrechnung.xml`). The
  attachment's mere presence, under one of those names, is the identifying signal.

Everything else - a scanned letter, a bank CSV export with no shared format across banks, a
Stripe or Apple report, a plain invoice PDF - has no such self-declaring structure, so it
goes through the AI-assisted path.

### 2. The taxonomy (`src/modules/intake/core/classification.ts`)

`documentKind`, one of: `letter`, `incoming_invoice`, `outgoing_invoice`, `reminder`,
`receipt`, `bank_statement`, `payout_report`, `platform_settlement`, `contract`,
`authority_letter`, `other`. Fixed and closed for this phase, the same "small business
mail/bookkeeping content" scope decisions/0015's category taxonomy already covers for
scanned mail, extended with the financial-report kinds this phase adds.

`platform` (only meaningful for `payout_report`/`platform_settlement`): `stripe`, `apple`,
`google`, `paypal`, `amazon`, `other`.

`SEMANTIC_FIELDS`: a single, flat, closed list of the fields our own domain cares about
across every tabular source alike (`bookingDate`, `valueDate`, `amount`, `currency`,
`creditDebit`, `counterpartyName`, `counterpartyIban`, `reference`, `description`,
`endToEndId`, `fee`, `gross`, `net`, `payoutId`, `customerName`, `customerEmail`,
`invoiceNumber`, `chargeId`, `productName`, `quantity`, `countryOfSale`). A model's
`columnMapping` output maps these to the ACTUAL column names in a given source's header - a
per-`documentKind` schema was considered and rejected: one small, closed vocabulary is
easier for both the model and the verification step to reason about consistently than a
different shape per report type, and a bank statement and a payout report share enough
fields (dates, amounts, references) that splitting them would mostly duplicate work.

### 3. "The AI proposes, the code verifies" - two enforcement points

**Point one: column-name hallucination.** A model's `columnMapping`/`amountSign` output
names columns by string. Nothing stops a model from inventing a plausible-sounding column
name that is not actually present in the source. `parseIntakeClassification`
(`core/classification.ts`) is the one function every classifier implementation (real and
fake alike) funnels its raw output through; given the sample's actual header, it drops any
mapping entry or amount-sign reference naming a column that does not exist, rather than ever
persisting or acting on a hallucinated reference. This mirrors
`src/modules/documents/core/analysis-validation.ts`'s `validateAnalysisResult`, which
already does the equivalent job (category must be one of the fixed keys, dates must be
plausible ISO dates) for the OCR-categorization pipeline.

**Point two: does the mapping actually hold for the data.** A model can confidently propose
a mapping that looks right on the 10-row sample it saw but breaks on row 4,000 of the real
file (a date format that only shows up later, an amount column that turns out to mix
currencies). `validateMapping` (`core/mapping-validator.ts`) applies a mapping to every row
of the full source, not just the sample, and is strict: every date must parse, every amount
must parse, the declared amount-sign shape must actually hold row by row, and (when the
source states a total) the mapped amounts must sum to it. Any single problem anywhere makes
the whole result a list of problems, never a partial success silently missing some rows -
nothing financial is ever imported from a mapping that has not passed this gate in full.

### 4. Verify-then-confirm-then-fingerprint (the flow F1b implements)

This phase (F1a) builds the pure functions the flow below needs; F1b wires them into an
actual upload path and UI:

1. A file arrives. `sniffFileKind` decides how to read it (OCR for PDF/image, XML parse,
   tabular sample).
2. Self-identifying formats (camt.053, embedded ZUGFeRD/Factur-X XML) are recognized and
   parsed deterministically - no model call, no confirmation needed beyond the normal
   review a financial import gets anyway.
3. Everything else goes to `IntakeClassifier.classify`, and the result passes through
   `parseIntakeClassification`'s hallucination check.
4. For a tabular source, the proposed mapping is checked by `validateMapping` against the
   FULL file before anything is shown to the user as "ready to import".
5. The user reviews and confirms the classification/mapping **once** for a given source
   layout. F1b then stores that confirmation keyed by `TabularSample.fingerprint` (this
   phase already computes it: a sha256 over the normalized header, delimiter, and column
   count) - the next file with the same fingerprint imports without another model call or
   another confirmation prompt, until the source's layout itself changes.
6. Nothing financial is ever imported from a model's answer alone, without having passed
   through both verification points above and, for a new source layout, an explicit human
   confirmation.

### 5. Content-level duplicate detection (`core/duplicate.ts`)

Two independent, deliberately different keys:

- `fileHash`: sha256 of the raw uploaded bytes - catches the exact same file uploaded twice.
- `semanticInvoiceKey`: sha256 of (invoice number, normalized sender, amount) - catches the
  same invoice arriving as a different file (a re-scan, a re-sent PDF with different
  metadata/timestamps, a slightly different rendering). Deliberately excludes the file's own
  bytes; that is what `fileHash` already covers.

Both are pure functions in this phase; F2 wires them into an actual check against
previously stored documents.

### 6. Safety: XXE and entity expansion

Every XML entry point (`detectCamt053`, `parseCamt053`) calls `assertSafeXml`
(`core/xml-safety.ts`) first: a fast text scan rejecting any document that declares a
DOCTYPE or a custom ENTITY, before a single byte reaches the XML parser. This was verified
necessary, not merely a defense-in-depth nicety, against the actual `fast-xml-parser`
version this application depends on: with entity processing enabled (needed to decode the
five predefined XML entities, `&amp; &lt; &gt; &apos; &quot;`), the library resolves a
DTD-declared custom entity when one is present - meaning nothing about the parser's own
configuration prevents XXE or a billion-laughs expansion chain on its own. `assertSafeXml`
running first, unconditionally, is what does. Tested against a synthetic external-entity
fixture and a synthetic entity-expansion-chain fixture; both are rejected before any
expansion is attempted (`src/modules/intake/tests/fixtures/malicious-xxe.xml`,
`malicious-billion-laughs.xml`).

## Consequences

- Positive: adding a new format this application should recognize (a new bank's CSV export,
  a new payment provider's payout report) never needs a new categorization code path - only
  a new fixture the fake classifier's header-signature table recognizes for tests, and the
  real model already generalizes over unseen-but-similar tabular layouts via the same
  prompt.
- Positive: the fixed, closed `SEMANTIC_FIELDS`/`DOCUMENT_KINDS`/`SETTLEMENT_PLATFORMS`
  vocabularies make both the model's job and `validateMapping`'s verification job bounded
  and testable - there is no open-ended schema a model could invent structure for.
- Positive: camt.053 and embedded ZUGFeRD XML never pay the cost (latency, spend, small
  error rate) of a model call for a question their own structure already answers
  unambiguously.
- Negative: the fingerprint-based "confirm once" flow (item 4 above) is not yet implemented
  - this phase only computes the fingerprint; nothing yet persists a confirmed source or
    skips re-classification for a recognized one. Every tabular file re-classifies via the
    model (or the fake) until F1b lands.
- Negative: `sampleTabular`'s CSV/TSV dialect detection and `mapping-validator.ts`'s slash-
  date handling are heuristic and have known, documented limits (`src/modules/intake/README.md`'s
  "Known Limits") - an unusual dialect or a European slash-dated source may need explicit
  caller-supplied hints this phase does not add UI for.
- Negative: today's upload route (`POST /api/documents`, decisions/0015) only accepts
  PDF/JPEG/PNG and caps a request body at 4 MB (Vercel's platform limit). A yearly CAMT.053
  or CSV export can exceed that; F1b's upload-route work will need either a raised limit for
  these content types specifically or a chunked/streamed upload path - not decided by this
  ADR, called out here as a known consequence for that phase to resolve.
- Implementation status: **F1a implemented** (this phase): `src/modules/intake`'s pure
  domain layer (file-kind sniffing, camt.053 detection/parsing, embedded-XML extraction,
  tabular sampling, the classifier port and its lenient/verifying parse, the deterministic
  fake, the mapping validator, duplicate-detection helpers) and
  `src/platform/mistral`'s real `IntakeClassifier` adapter. **Not yet implemented**: any
  schema/persistence for a document's kind/direction or a confirmed source fingerprint (F2),
  the user-facing confirmation UI, the upload route accepting XML/CSV/TSV (F1b), and wiring
  `fileHash`/`semanticInvoiceKey` into an actual stored-document duplicate check (F2).

## Supersedes / Superseded By
- None
