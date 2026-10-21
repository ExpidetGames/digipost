# Contacts: company contact model, matching, and verification semantics

Document type: decision
Lifecycle: active
Owner: src/modules/contacts
Scope: The `contacts`/`document_contacts`/`contact_change_proposals` data model, the
workspace's own company profile (`workspaces.company_*`), the matching order used to decide
whether an extracted contact is one already known to the workspace, the verification
semantics that govern when the pipeline may write to a contact versus when it must propose a
change instead, the own-company exclusion, and what C2 (pipeline integration) and C3
(contacts UI) will add on top of this phase's domain model
Canonical responsibility: Active source for why contacts are workspace-scoped
"Firmenkontakte" with only `name` required, why `document_contacts` carries a `role` column
instead of a single sender reference, the exact five-rule matching order and its strength/
ambiguity handling, the no-silent-overwrite rule and the invoice-fraud rationale behind it,
why `contacts.iban_normalized` has no unique index while `vat_id_normalized` does, and how
the workspace's own company is excluded from ever becoming a contact of itself
Maintenance triggers:
- The matching order, its thresholds, or which fields count as "comparable" for the
  fill-or-propose diff change
- The verification semantics (what counts as verification, when `verified_at` resets) change
- A contact-adjacent table's schema changes, or a new one is added
- C2 (pipeline integration) or C3 (contacts UI) land and extend what this ADR describes as
  still missing
Last verified: 2026-09-20, C1 (contacts data model and domain)

## Status
Accepted

## Context

Digipost's inbox already stores the OCR'd text, sender, and category of every scanned
document (decisions/0015-documents-and-quotas.md, decisions/0016-processing-pipeline-and-ai.md),
but it has no durable model of *who* keeps writing to a workspace: which supplier this
invoice is from, which authority sent this letter, what that supplier's IBAN or VAT id is,
whether it has changed since the last invoice. Building that model (a workspace's
"Firmenkontakte") is the first of three contact phases (C1, this one: data model and domain;
C2: pipeline integration, extracting structured contact data from a document and calling into
this phase's `upsertFromExtraction`; C3: the contacts UI, including the proposal
review/accept/reject screen). C1 deliberately ships no UI and does not touch the extraction
prompt - it exists so C2 and C3 have a stable, well-tested contract to build on, per this
repository's usual phase-by-phase approach (compare decisions/0015's P2a shipping the
documents data model before P2b's pipeline used it).

The data this model captures comes from scanned paper, run through OCR and an LLM
(decisions/0016). That source is inherently unreliable and, in the specific case of banking
details, a target for fraud: a supplier invoice whose IBAN has quietly changed between two
otherwise-identical-looking letters is one of the most common invoice-fraud patterns in
practice. A contact model that let the pipeline silently overwrite a human-verified value
with whatever the next scan produced would make Digipost an active participant in that risk,
not a safeguard against it. This is the central design constraint behind everything in this
ADR: **the pipeline may add information; it may never silently change existing information a
human has (implicitly or explicitly) already vouched for.**

## Decision

### 1. `contacts`: workspace-scoped, only `name` required

`src/persistence/schema/contacts.ts` (owner `src/modules/contacts`): every field beyond
`name` is nullable - identity (`legal_form`, address, `country` defaulting to `"DE"`),
tax/register (`vat_id`, `tax_number`, `register_court`, `register_number`, `leitweg_id`),
banking (`iban`, `bic`, `bank_name`, `account_holder`, `sepa_creditor_id`), communication
(`phone`, `email`, `website`, `contact_person`), and relationship (`customer_number`,
`supplier_number`, `payment_terms_days`, `relation_type`, `notes`). This mirrors the
architecture brief's explicit requirement: extraction from a scanned document must never
fail merely because one field could not be read.

Two groups of columns are maintained entirely by application code, never typed by a human or
extracted verbatim:

- **Matching columns** (`name_normalized`, `vat_id_normalized`, `iban_normalized`): computed
  by `@/modules/contacts`'s pure normalizers (`normalizeName`/`normalizeVatId`/`normalizeIban`)
  every time a contact is created or one of these three source fields changes. There is no
  SQL-generated column here (unlike `documents.search_vector`,
  decisions/0015-documents-and-quotas.md): "strip legal-form suffixes" has no single SQL
  expression that reproduces it, so this needed real application code, computed in
  `src/persistence/use-cases/contacts-use-cases.ts` before every write.
- **Provenance/trust columns** (`source`, `verified_at`, `verified_by_user_id`,
  `first_seen_document_id`): see "Verification semantics" below.

**Indexes**: a unique index on `(workspace_id, vat_id_normalized) where vat_id_normalized is
not null` (a VAT id genuinely identifies one legal entity; two contacts in the same workspace
sharing one is a data error, not a valid state, and this index is also what makes the
concurrency guarantee in "Matching order" below possible at all). No unique index on
`(workspace_id, iban_normalized)`: a bank account can legitimately be shared by two distinct
legal entities (a factoring arrangement, a tax advisor collecting payments for several
clients, a shared group treasury account), so two different, correctly-modeled contacts
sharing one IBAN is a real, non-error state a unique constraint would incorrectly forbid. A
plain (non-unique) index on `(workspace_id, iban_normalized)` still exists, for the matching
rule below. Plus `(workspace_id, name_normalized, postal_code)` and `(workspace_id, name)`
for matching and the list view respectively.

### 2. `document_contacts`: a role column, not a single sender reference

`document_contacts (document_id, contact_id, role)`, composite primary key over all three,
both foreign keys `on delete cascade`. The obvious simpler design - one `sender_contact_id`
column on `documents` - was rejected because it is factually wrong for a meaningful share of
real German business mail: a debt-collection agency writes on behalf of the original
creditor; a lawyer writes on behalf of a client; an insurer or tax advisor is CC'd on a letter
that also names the actual counterparty. All of these routinely put two or more distinct
companies on one physical letter, and the inbox must still be able to say which one **sent**
it (`role: "sender"`) as distinct from who it is merely **about**
(`"on_behalf_of"`/`"mentioned"`) or who it was addressed **to** (`"recipient"`). A join table
with a role column is the only shape that represents this correctly; the composite primary
key means the same document/contact pair can appear more than once only with different roles,
never duplicated in the same role.

Indexing: the composite primary key's own index already covers "every contact for a
document" (`document_id` is its leftmost column); only the reverse direction
(`document_contacts_contact_idx` on `contact_id`) needed its own index.

### 3. `contact_change_proposals`: the no-silent-overwrite rule

When the pipeline extracts a value for a field that already holds a different, non-empty
value on the matched contact, it is never written directly - a
`contact_change_proposals` row is inserted instead (`contact_id`, `document_id`, `field`,
`current_value`, `proposed_value`, `status` `pending|accepted|rejected`, `created_at`,
`decided_at`, `decided_by_user_id`), left `pending` until a human calls `acceptProposal` or
`rejectProposal`. This is the direct, load-bearing consequence of this ADR's central
constraint (see "Context"): a changed IBAN on an otherwise-familiar-looking supplier invoice
is a textbook invoice-fraud pattern, and an automated system that quietly adopted the new
value would be actively dangerous, not merely imprecise. Recording a proposal instead turns a
potential fraud into a visible, reviewable decision (C3 builds the review UI; this phase only
builds the storage and the accept/reject use-case methods).

`workspace_id` is denormalized onto this table (redundant with `contact_id`'s own workspace,
resolvable via a join) purely so `listProposals`'s "every pending proposal in this workspace"
query never needs one, matching the same tradeoff `documents.workspace_id` makes despite
`documents.category_id` also implying a workspace indirectly. `document_id` is nullable,
`on delete set null`: a proposal is a fraud-relevant audit record that should outlive its
source document being deleted later (accepted as a tradeoff over the alternative of cascading
the proposal away with the document, which would erase exactly the kind of history most worth
keeping).

### 4. Matching order (`@/modules/contacts`'s `pickBestMatch`, pure, unit-tested)

Given a freshly extracted contact and every contact currently in the workspace
(`ContactRepository.listAllForWorkspace` - unpaginated, acceptable at this product's scale, a
small business's own contact book), tried strongest first:

1. **`vat_id_normalized` exact match** - strong. A VAT id is the least ambiguous identifier
   available and, backed by the unique index (§1), can match at most one contact.
2. **`register_court` + `register_number` exact match (both required)** - strong. A
   Handelsregister entry is just as unambiguous as a VAT id but often present when a VAT id
   is not (e.g. a company between VAT registration and its first invoice).
3. **`iban_normalized` exact match** - strong, but only when exactly one contact in the
   workspace currently shares that IBAN. Since IBANs are not unique per §1, more than one
   candidate sharing an IBAN is genuinely ambiguous (which of the two entities on that shared
   account is this from?) - `pickBestMatch` treats that as no match at all rather than
   guessing, deliberately erring toward creating a new contact (correctable via `mergeContacts`
   later) over misfiling a document under the wrong company.
4. **`customer_number` exact match plus a normalized-name similarity above a low bar** - weak.
   "Ihre Kundennummer" (the workspace's own number at the supplier) is a real identifier but
   reused often enough across unrelated senders (sequential/small numeric ranges) that it is
   only trusted alongside at least a loose name match. Ambiguous (more than one candidate
   satisfies both) yields no match, same reasoning as rule 3.
5. **`name_normalized` + `postal_code` both exact** - weak, the last resort before creating a
   new contact. Same ambiguity handling.

No rule matching means a new contact is created. `matchStrength` (`"strong"`/`"weak"`,
returned by `upsertFromExtraction`) is exposed specifically so a future UI (C3, or a
confidence-based auto-verification policy) can treat a weak match with appropriately more
caution than a strong one - not acted on anywhere yet in this phase.

**Concurrency**: two `upsertFromExtraction` calls racing for the same never-seen-before VAT
id can both observe "no match" (Postgres's read-committed isolation means neither transaction
sees the other's not-yet-committed insert) and both attempt to create a new contact; exactly
one insert succeeds, the other raises the unique-constraint violation from §1's index. Rather
than surfacing that as a failure, `upsertFromExtraction` catches it and retries its entire
match-and-apply logic exactly once - the retry now sees the winner's committed row and
matches against it instead of colliding again. This is proved against real Postgres, not only
asserted (`src/persistence/tests/contacts-use-cases-concurrency.db.test.ts`), following the
same "prove it under real concurrency, not just a fake" discipline
decisions/0015-documents-and-quotas.md's quota check and
decisions/0017-billing-tiers-and-packages.md's warning markers already established. A weak
match (rules 4-5) has no equivalent database-level guarantee - two concurrent extractions
with no shared strong identifier can race into two separate contacts for what is actually the
same company. This is an accepted, known limitation (also proved by a test, not just left
undocumented): weak matches exist to reduce duplicate contacts in the common case, not to
guarantee zero duplicates, and `mergeContacts` exists precisely to correct the rare case where
one slips through.

### 5. Verification semantics

- A contact created by the pipeline (`upsertFromExtraction`, no match found) has
  `source: "auto"` and `verified_at: null`.
- A human creating (`createManual`) or saving (`updateManual`) a contact by hand always sets
  `verified_at`/`verified_by_user_id` - they were looking directly at the form when they did
  it, which is as much "verification" as this product needs to track.
- **Accepting a proposal also counts as verification.** `acceptProposal` applies the
  proposed value to the contact's field AND sets `verified_at`/`verified_by_user_id` to the
  deciding admin - at least as deliberate a review as `createManual`/`updateManual`'s own rule
  (arguably more so: the human was shown the specific old-vs-new values and chose to accept
  them). `rejectProposal` never touches the contact's own fields or its verification state.
- **Fill-empty-only, on every contact, regardless of verified state.** When the pipeline
  matches an existing contact, for every field the extraction provided: an empty current
  value is filled directly; a non-empty, contradicting current value never is - a proposal is
  recorded instead. This behavior is identical whether the contact is currently verified or
  not (`@/modules/contacts`'s `computeContactUpdatePlan` makes no distinction) - a verified
  contact having its own genuinely-empty field filled in by a later document is a strict
  improvement in the workspace's data, not a place §3's fraud concern applies, since nothing
  is being changed, only added. This resolves what might otherwise look like a stated
  contradiction: the PRD's "unverified contacts may be filled" and "verified contacts are
  only ever filled" turn out to describe the exact same rule, worded from each state's own
  perspective.
- **Any pipeline-made write resets `verified_at` to `null`**, including a fill-empty write on
  a previously-verified contact. A contact that a human verified last month and that the
  pipeline has since touched again is a contact worth a human looking at again - re-verifying
  costs nothing (the fields did not become wrong, they only grew), and silently keeping the
  old `verified_at` would let a workspace believe a contact was "reviewed as of" a point in
  time after which its data actually changed.

### 6. Own-company exclusion

`workspaces` gains `company_address_line1`, `company_address_line2`, `company_postal_code`,
`company_city`, `company_country` (default `"DE"`), and `company_vat_id`, all nullable
(`workspaces.name` already holds the company name, so it is not duplicated here). No
persisted "normalized" counterparts of these columns exist, unlike `contacts`'s own
`*_normalized` columns: a workspace has exactly one company profile, never searched or
matched against at scale the way the contact list is, so `@/modules/contacts`'s pure
`isOwnCompany(extracted, ownCompany)` normalizes both sides on the fly at comparison time
instead of maintaining a denormalized column purely to save a handful of normalizer calls per
document.

`isOwnCompany` matches strongest first: a VAT id match alone (strong), or a postal-code exact
match combined with a normalized-name similarity at or above a bar stricter than the general
matching rule 4/5's own threshold (weak) - deliberately stricter, because a false positive
here would silently drop a real business partner's mail from the contact list entirely
(mistaken for the workspace's own address), a materially worse failure than the reverse (the
workspace's own address showing up as a contact once, harmless and correctable by deleting
it). C2's pipeline is expected to call `isOwnCompany` before `upsertFromExtraction` for a
document's own recipient-side extraction, so the workspace's own company is never filed as a
contact of itself.

`src/persistence/use-cases/workspaces-use-cases.ts` gained `getCompanyProfile`/
`updateCompanyProfile`; neither enforces admin-only access itself (this repository's use
cases never enforce authorization - "the last line of defense" is input validation, not
permissions, matching `setRoutingRule`'s own documented pattern). **C2 must gate
`updateCompanyProfile` behind an admin-only permission via `src/platform/access` when it
builds the onboarding step/settings page** - see "Consequences" for the exact function names
and the judgment call about which permission to use, since this phase does not add one.

### 7. Manual input validation vs. extraction leniency

`@/modules/contacts`'s `manualContactCreateSchema`/`manualContactUpdateSchema` (Zod) validate
a human-entered contact, including a hard rejection of a malformed IBAN (mod-97 checksum) or
an implausible VAT id (German-exact `DE` + 9 digits, other countries checked only loosely) -
a human is present to fix it immediately, so failing fast is the better UX. `upsertFromExtraction`
never runs these checks to reject anything: `checkContactFormats`/`isValidIbanFormat`/
`isPlausibleVatId` exist as pure, non-blocking functions a future UI could use to flag "this
extracted IBAN looks malformed" without ever failing the extraction itself, consistent with
the architecture brief's "extraction must never fail for a missing [or malformed] field".

## Consequences

- Positive: the fraud-prevention property (§3/§5) is structural, not a UI convention - the
  persistence use case itself (`upsertFromExtraction`) has no code path that overwrites a
  non-empty field, so a future UI bug cannot accidentally reintroduce silent overwriting; it
  would have to bypass `contacts-use-cases.ts` entirely.
- Positive: the matching order and the fill-or-propose diff are both pure, dependency-free
  functions (`@/modules/contacts/core/matching.ts`, `verification.ts`) - fully unit-tested
  without a database, and reusable unchanged by C2's pipeline code and C3's UI.
- Positive: `mergeContacts` (moves links and proposals, fills the target's empty fields from
  the source's non-empty ones, deletes the source, one transaction) is the designed recovery
  path for the one known gap in matching: two contacts created for what turns out to be the
  same company (a weak-match race, decision 4's "Concurrency", or simply two different
  scanned senders that happen to look different enough that no rule caught it).
- Negative: `mergeContacts`'s current contract (`{ workspaceId, sourceId, targetId }`) has no
  `actingUserId` and therefore never touches the target's verification state - a merge does
  not re-verify the surviving contact even though a human decided to perform it. This was a
  deliberate scope cut for C1 (the brief's own signature omits an acting user); C3's merge UI
  can add `actingUserId` as an additive, backward-compatible change to `mergeContacts`'s input
  type when it wants the merge to also count as verification.
- Negative: `updateCompanyProfile` has no permission bundle wired to it yet -
  `src/platform/access`'s `PERMISSIONS` today has `membersManage`/`billingManage`/
  `routingManage`/`documentsRead`/`documentsWrite`, none of which precisely names "manage the
  workspace's own company profile". C2, when it builds the settings page's Server Action,
  should either add a new bundle entry (e.g. `PERMISSIONS.companyProfileManage`, admin-only,
  mirroring how `routingManage` was added ahead of its own UI in P2b) or deliberately reuse an
  existing admin-only one (`billingManage` is the closest existing precedent for "workspace
  settings, not document work") - this phase intentionally leaves that choice to C2 rather
  than editing `src/platform/access` speculatively, per this phase's own file-scope
  boundaries.
- Negative: weak matches (rules 4-5) provide no database-level duplicate prevention the way
  the VAT id unique index does for strong matches - documented and tested as an accepted
  limitation in decision 4, not a defect.
- Implementation status: **implemented** (C1). Schema (`src/persistence/schema/contacts.ts`,
  the `workspaces.company_*` columns), repositories (`contracts/contacts-repository.ts`,
  `drizzle/contacts-repository.ts`), the use case
  (`src/persistence/use-cases/contacts-use-cases.ts`, `workspaces-use-cases.ts`'s company
  profile methods), the composition root, and `src/modules/contacts`'s pure `core/` all land
  in this phase, covered by unit, `.db.test.ts`, and integration tests (this module's own
  `README.md` and `src/persistence/README.md`'s "Tests" sections). **Not implemented yet,
  explicitly out of scope for C1**: any UI, any Server Action, extraction-prompt integration
  (C2 wires the Mistral prompt to produce `ExtractedContactData` and calls `isOwnCompany`
  then `upsertFromExtraction` from the processing pipeline), the proposal review screen, the
  merge UI, and the company-profile onboarding step/settings page (C2/C3).

## Supersedes / Superseded By
- None
