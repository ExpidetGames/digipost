# src/modules/contacts

Document type: reference
Lifecycle: active
Owner: src/modules/contacts
Scope: The "Firmenkontakte" domain (normalization, matching, verification/fill-or-propose
semantics, the workspace's own-company exclusion check, C1) AND its UI: the
`/dashboard/contacts` list and `/dashboard/contacts/[id]` detail pages, their Server
Actions, and their read models (C3, decisions/0019-contacts.md)
Canonical responsibility: The single source for the contact enums
(`CONTACT_SOURCES`/`CONTACT_RELATION_TYPES`/`DOCUMENT_CONTACT_ROLES`/`CONTACT_PROPOSAL_STATUSES`),
the pure normalizers, the matching order, the fill-or-propose diff, `isOwnCompany`, the
manual create/update Zod schemas, and (C3) the contacts UI's own read models, Server Actions,
and components
Maintenance triggers:
- The matching order, its thresholds, or which fields count as "comparable" change
- A new legal-form suffix needs stripping, or `normalizeName`'s algorithm changes
- The IBAN/VAT format checks change (a new country's format, a stricter/looser rule)
- C2 (pipeline integration) lands and this module's UI gains a way to see auto-created
  contacts and proposals arrive from a real document, not just from an e2e fixture
- The list read model's known N+1 gap (see "Known gaps" below) is closed by a future,
  count-bearing addition to `ContactUseCases.listForWorkspace`
Last verified: 2026-09-20, F5 (hardening, decisions/0027-hardening-and-deletion.md): a
defense-in-depth fix from the adversarial review pass - `DocumentContactRepository.listForDocument`/
`listForContact` (`src/persistence/repositories/{contracts,drizzle}/contacts-repository.ts`)
now take `workspaceId` and enforce it with an explicit join filter (to `documents`/`contacts`
respectively), rather than relying only on every caller having already validated the id
against the workspace. No caller-visible behavior changed (every existing caller already did
that validation); a DB test now proves a mismatched `workspaceId` returns nothing even for
real, linked ids. Also confirmed (unchanged): contacts merge/delete stay member-level
(`documents.write`), an explicit product decision this ADR records, not an oversight.
Previously, C3 (contacts UI). 2026-09-22, H1 (decisions/0034-extended-company-profile.md,
wave 1 of the "AI is told what to look for" feature): `OwnCompanyProfile`
(`core/types.ts`) gained `aliases`/`ibans`/`domains`/`taxNumber`/`registerCourt`/
`registerNumber`; `isOwnCompany` (`core/own-company.ts`) gained three new rules (register
court+number, whole-name/alias equality, own web/e-mail domain) ahead of its original
postal-code+similarity rule - see that ADR's own "Why NO IBAN rule" section for the one
signal deliberately left OUT despite `ibans` being real, validated data on the same type.

## Purpose

A workspace keeps "Firmenkontakte" (company contacts) extracted from its documents: the
sender of an invoice, the recipient a letter is addressed to, a debt-collection agency
writing on behalf of a creditor, or a company merely mentioned in the text. Only `name` is
required on a contact - every other field (address, VAT id, IBAN, ...) is optional, because
extraction from a scanned document must never fail just because one field could not be read.

This module (`src/modules/contacts`) is the **domain layer only** for phase C1: pure,
framework-free functions with no I/O, no database, and no UI. It answers three questions,
each with its own file under `core/`:

1. **Normalization** (`normalizers.ts`): how to turn "DE 123 456 789" and "DE123456789" into
   the same value, and "Musterwerk GmbH" and "musterwerk" into the same value, while never
   touching German umlauts (ä/ö/ü/ß).
2. **Matching** (`matching.ts`): given a freshly extracted contact and every contact already
   in the workspace, which one (if any) is "the same company", and how confident is that
   match (`strong` vs `weak`)?
3. **Verification / fill-or-propose** (`verification.ts`, `own-company.ts`): once a contact
   is matched, which of its fields may the pipeline fill in directly, and which contradicting
   values must instead become a reviewable proposal - plus, before any of this even runs,
   whether the extracted "contact" is actually the workspace's own company and should be
   skipped entirely.

`src/persistence/use-cases/contacts-use-cases.ts` is where all of this becomes stateful
(repositories, transactions, the `upsertFromExtraction` entry point C2's pipeline calls) -
this module's own `core/` never imports from `src/persistence` at all, so it stays testable
without a database and reusable from C2's pipeline code and C3's UI alike. See
`decisions/0019-contacts.md` for the full model, the matching order, the verification
semantics, and the fraud rationale behind never silently overwriting a verified value.

## Public interfaces

`index.ts` (neutral entrypoint - domain-only, see "UI (C3)" below for `server.ts`/
`client.ts`/`actions.ts`, C3's addition):

- Enums: `CONTACT_SOURCES`/`ContactSource`, `CONTACT_RELATION_TYPES`/`ContactRelationType`,
  `DOCUMENT_CONTACT_ROLES`/`DocumentContactRole`, `CONTACT_PROPOSAL_STATUSES`/`ContactProposalStatus`.
- Types: `ExtractedContactData` (what C2's pipeline must hand `upsertFromExtraction`),
  `ComparableContactField`/`COMPARABLE_CONTACT_FIELDS`, `ContactMatchCandidate`,
  `OwnCompanyProfile`.
- Normalizers: `normalizeVatId`, `normalizeIban`, `normalizeName`, `normalizePlainText`,
  `nameSimilarity`.
- Matching: `pickBestMatch`, `normalizeExtractedForMatching`, `MATCH_RULES`, `MatchResult`,
  `MatchRule`, `MatchStrength`, `NormalizedExtractedContact`.
- Verification: `computeContactUpdatePlan`, `ContactFieldPatch`, `FieldProposal`,
  `ExistingContactForDiff`.
- Own-company: `isOwnCompany`, `OWN_COMPANY_NAME_SIMILARITY_THRESHOLD`.
- Bank detection (decisions/0035-contact-links-replace-and-bank-detection.md): `isLikelyBank` -
  used by `replaceDocumentLinks` (`src/persistence/use-cases/contacts-use-cases.ts`) to skip a
  party that is plausibly the workspace's own bank or the counterparty's, never a real business
  contact, before it ever reaches matching.
- Format checks: `checkContactFormats`, `isValidIbanFormat`, `isPlausibleVatId`,
  `CONTACT_FORMAT_WARNING`/`ContactFormatWarning`.
- Schemas: `manualContactCreateSchema`, `manualContactUpdateSchema` (and their inferred
  `ManualContactCreateInput`/`ManualContactUpdateInput` types), plus (C3) `updateContactInputSchema`/
  `UpdateContactInput`, `verifyContactInputSchema`, `deleteContactInputSchema`,
  `mergeContactsInputSchema`, `acceptProposalInputSchema`, `rejectProposalInputSchema`,
  `unlinkDocumentInputSchema`, `contactListQuerySchema` - `actions.ts`'s own input schemas.
- (C3) `CONTACT_ACTION_ERROR_CODES`/`ContactActionErrorCode` - the Server Action layer's
  stable error-code set.

## Structure

- `core/types.ts` - the enums, `ExtractedContactData`, `ContactMatchCandidate`,
  `OwnCompanyProfile`. The single source `src/persistence/schema/contacts.ts` imports its
  enum constants from (the same "module owns the enum, schema imports it" pattern
  `workspaces.ts` already follows for `TIERS`/`ROLES`).
- `core/normalizers.ts` - `normalizeVatId`/`normalizeIban` (uppercase, strip whitespace),
  `normalizeName` (lowercase, strip punctuation, strip a trailing legal-form suffix, keep
  umlauts), `normalizePlainText` (loose display-field comparison), `nameSimilarity` (token
  Jaccard, used by both matching rule 4 and `isOwnCompany`).
- `core/matching.ts` - `pickBestMatch`: vat id -> register court+number -> iban (ambiguous if
  shared by more than one contact) -> customer number + name similarity -> name + postal
  code -> name alone when the extraction has no postal code at all and exactly one existing
  contact shares it (`name_only_unique`, weak, decisions/0035-contact-links-replace-and-bank-detection.md
  - the rule that stops a postal-code-less footer mention from spawning a new duplicate
  contact on every reprocessing run), strongest first, `null` when nothing matches
  (decisions/0019-contacts.md's full rationale for rules 1-5 and their ambiguity handling).
- `core/bank-detection.ts` - `isLikelyBank`: gated on having NO address at all (a footer bank
  mention never carries the bank's own street address, unlike a real invoice sent BY a bank),
  then name-token/footer-reference (excluding self)/no-business-signal heuristics deciding a
  party is the workspace's own bank (or the counterparty's) rather than a real
  "Firmenkontakt" - see decisions/0035 for the exact rule order.
- `core/verification.ts` - `computeContactUpdatePlan`: for each comparable field the
  extraction provided, fills an empty current value directly, proposes a contradicting
  non-empty one, and ignores a value equal after normalization. Identical behavior whether
  the contact is verified or not (see decisions/0019-contacts.md) - the verified/unverified
  distinction only affects whether `verified_at` gets reset, which is a whole-row concern the
  persistence use case handles, not this pure diff.
- `core/own-company.ts` - `isOwnCompany`, decision order (decisions/0034-extended-company-
  profile.md): VAT id match, register court+number match, whole-name equality against the own
  name or an alias (never a substring), own web/e-mail domain, postal code + a stricter
  name-similarity bar than matching rule 4 (weakest, the original decisions/0019 rule) -
  stricter specifically because a false positive here would silently drop a real business
  partner's mail. Deliberately NOT a rule: a party's own `iban` matching one of
  `ownCompany.ibans` - see that ADR's "Why NO IBAN rule" section.
- `core/format-checks.ts` - `isValidIbanFormat` (mod-97 checksum), `isPlausibleVatId`
  (German-exact, other countries loosely), `checkContactFormats` (both, as non-blocking
  warnings) - never throws, never used to reject an extraction.
- `core/error-codes.ts` - `CONTACT_FORMAT_WARNING`, the only module-level error-code set this
  phase needs (the persistence use case's own `CONTACT_ERROR` lives beside it in
  `src/persistence/use-cases/contacts-use-cases.ts`, matching every other owner area).
- `core/schemas.ts` - `manualContactCreateSchema`/`manualContactUpdateSchema`: only `name` is
  required; a malformed IBAN/VAT id is a hard validation error here (a human is present to
  fix it), unlike `upsertFromExtraction`'s "never fail" rule.

`core/error-codes.ts` also carries C3's own `CONTACT_ACTION_ERROR_CODES`/`ContactActionErrorCode`
(the Server Action layer's stable error-code set, mirroring `CONTACT_ERROR` from
`src/persistence/use-cases/contacts-use-cases.ts` plus `invalid_input` and
`src/platform/access`'s `WorkspaceAccessErrorCode`, same pattern as
`src/modules/documents/core/error-codes.ts`'s `DOCUMENT_ACTION_ERROR_CODES`), and
`core/schemas.ts` also carries C3's action input schemas (`updateContactInputSchema`,
`verifyContactInputSchema`, `deleteContactInputSchema`, `mergeContactsInputSchema`,
`acceptProposalInputSchema`, `rejectProposalInputSchema`, `unlinkDocumentInputSchema`,
`contactListQuerySchema`). `core/view-types.ts` is a new C3 file: UI-facing DTOs (dates as
ISO strings), kept separate from C1's `core/types.ts` so this phase's additions never touch
that file.

C2 (pipeline integration) is expected to add its own extraction-prompt code (likely under
`src/platform/mistral` or a new file here, its call) - not yet landed.

`src/persistence/use-cases/contacts-use-cases.ts`'s `replaceDocumentLinks`
(decisions/0035-contact-links-replace-and-bank-detection.md) is ready to become the pipeline's
one entry point for writing a document's contact links, superseding the per-party
`upsertFromExtraction` loop `documents-use-cases.ts`'s `processOcrDocument` currently runs
(one `upsertFromExtraction` call per extracted party): it removes every existing link for the
document and rewrites them from the given parties in one transaction (never appends). Every
party is first sanitized (`stripOwnIdentifiers`: our own IBAN/VAT id, both misattribution-prone
model outputs, are dropped from a party BEFORE anything else runs, never after), then a party
that is the workspace's own company (`isOwnCompany`) or its bank (`isLikelyBank`) is skipped -
running these identity checks on the sanitized copy is what stops a party the model
mis-attributed one of our own identifiers to from being wrongly treated as us or as a bank.
Two or more surviving parties resolving to the same contact are reduced to one linked role
(`sender`/`recipient` > `on_behalf_of` > `mentioned`), and `relationType` is written only on
create or when the contact's own value is still `null`. Its matching/fill-or-propose logic is
the same `upsertContactOnly` helper `upsertFromExtraction` itself now calls internally - no
duplicated logic between the two entry points. `upsertFromExtraction` itself is unchanged for
its existing callers/tests. Nothing calls `replaceDocumentLinks` yet: switching
`processOcrDocument` over to it is a separate, later change (H-contract.md's "wave 2").

## UI (C3): routes, Server Actions, read models

- **Routes**: `src/app/(app)/dashboard/contacts/page.tsx` (list: search over name/VAT
  id/customer number, `relation_type`/"Nur unbestätigte" filters, per-row linked-document and
  pending-proposal counts, an "unbestätigt" badge, a "Kontakt anlegen" toggle, and a global
  "Änderungsvorschläge" entry point listing every pending proposal workspace-wide - scope
  item 3's "global entry point" requirement) and
  `src/app/(app)/dashboard/contacts/[id]/page.tsx` (detail: all fields grouped, inline edit,
  verification state with who/when and a "Bestätigen" button, linked documents with a role
  badge and unlink, pending proposals with a prominent IBAN warning callout, "Zusammenführen"
  with a confirmation dialog, "Löschen" with confirmation, and, admin-only
  (decisions/0037-correction-buttons.md), "Das sind wir"/"Das ist unsere Bank" - each with its
  own German confirmation dialog, turning a mistaken contact into a company-profile alias/IBAN
  before deleting it). Both 404 for a contact/route outside the caller's own workspace, same
  pattern as the documents module's own pages.
- **`server.ts`** (new): `listContactsProjection`, `getContactDetailProjection`,
  `listMergeOptionsProjection`, `listPendingProposalsSummaryProjection`,
  `CONTACTS_PAGE_SIZE` - all in `server/read-models.ts`, calling only
  `getRequestServices().contacts`/`.workspaces` (via `@/modules/workspaces/server`'s
  `listTeamProjection`, reused to resolve a contact's `verifiedByUserId` to a display name,
  the same cross-module reuse `src/modules/documents/server/read-models.ts` already
  establishes for its assignee dropdown).
- **`actions.ts`** (new, `"use server"`): `createContactAction`, `updateContactAction`,
  `verifyContactAction`, `deleteContactAction`, `mergeContactsAction`, `acceptProposalAction`,
  `rejectProposalAction`, `unlinkDocumentAction` - each parses with Zod first (never checks
  permission on a malformed call), then `requirePermission`, then calls the use case and maps
  `UseCaseError` to `ContactActionErrorCode`, revalidating every affected path. See "Known
  gaps" below for the permission bundle judgment call and `verifyContactAction`'s own doc
  comment for why "verify without other changes" goes through `updateManual`.
  `markContactAsOwnCompanyAction`/`markContactAsOwnBankAction`
  (decisions/0037-correction-buttons.md) are the one exception to the "`documentsWrite`,
  member-level" rule every other action here follows: they require
  `PERMISSIONS.companyProfileManage` (admin-only, same bundle `updateCompanyProfileAction`
  itself uses), because they write to the shared company profile before deleting the contact -
  `getRequestServices().workspaces.addCompanyAlias`/`addCompanyIban` first, `deleteContact`
  only once that succeeds. See that ADR for the full orchestration and the
  `contact_missing_iban` refusal code.
- **`client.ts`** (new, `"use client"`): `ContactDetailClient`, `CreateContactSection` - the
  only two components a Next seam needs; every other component under `ui/` (`ContactForm`,
  `LinkedDocumentsList`, `ProposalList`, `MergeContactSection`) is an internal building block
  composed by one of those two.

## Known gaps (C3, flagged rather than fixed in `src/persistence/**`)

Both accepted per this phase's own file-scope boundary (`src/persistence/**` is C2's, not
C3's, for this round) - not silently patched over, and reported here per that boundary's own
instruction to report rather than add to persistence.

- **No count-bearing list method.** `ContactUseCases.listForWorkspace` (C1's contract) returns
  plain `Contact` rows, with no aggregated document/proposal counts. The list page's own
  `documentsCount`/`pendingProposalsCount` per row (`server/read-models.ts`'s
  `listContactsProjection`) are filled in with an explicit N+1: one `getById` call per row on
  top of the paginated list query. This is the same "acceptable at this product's scale, a
  small business's own contact book" tradeoff decisions/0019-contacts.md already applies to
  `ContactRepository.listAllForWorkspace` - `CONTACTS_PAGE_SIZE` (30) keeps a single page's
  worst case bounded. A future, count-bearing addition to `listForWorkspace` (or a dedicated
  repository method) would let this read model drop the N+1 entirely.
- **No `contacts.manage`-shaped permission.** `src/platform/access`'s `PERMISSIONS` has no
  bundle that precisely names "manage this workspace's contacts" - decisions/0019-contacts.md
  already flagged this gap for `updateCompanyProfile` and left the choice to whichever phase
  builds the UI. C2 (running at the same time as this phase) is expected to add
  `PERMISSIONS.companyProfileManage` to that same file
  (`src/platform/access/core/permissions.ts`) for its own settings page; adding a second new
  permission there concurrently, in a file neither phase's file-scope explicitly owns, would
  risk a needless merge conflict. Every contact Server Action is therefore gated behind the
  existing `PERMISSIONS.documentsWrite` (granted to every workspace member) instead - a
  judgment call to revisit once `src/platform/access` is free to add a dedicated bundle.

## Dependencies on other owners

`core/` itself has none - it is pure and self-contained by design (no `src/persistence` import
anywhere in it, so it stays independently unit-testable and safe to import from both the
persistence use case and a future UI). `actions.ts` (C3/H5) does have one, deliberately:
`markContactAsOwnCompanyAction`/`markContactAsOwnBankAction`
(decisions/0037-correction-buttons.md) call `src/modules/workspaces`'s
`WorkspaceUseCases.addCompanyAlias`/`addCompanyIban` (via `getRequestServices()`, the same
composition graph every Server Action already uses) before this module's own `deleteContact` -
the only place in this module that writes to a table it does not own, and it does so through
that table's owning use case, never directly.

## Consumers

`src/persistence/schema/contacts.ts` (the four enum constants, for its `pgTable(..., {
enum: ... })` columns), `src/persistence/schema/workspaces.ts`'s header comment (documents
why the company-profile columns it added have no persisted normalized counterpart - this
module's `isOwnCompany` normalizes on the fly instead), and
`src/persistence/use-cases/contacts-use-cases.ts` (everything: normalizers, `pickBestMatch`,
`computeContactUpdatePlan`, `isOwnCompany`, `isLikelyBank`, the manual schemas' field shape),
and (C3) this module's own `server.ts`/`actions.ts`/`ui/` (the enums, schemas, and action
error codes) plus `src/app/(app)/dashboard/contacts/**` and
`src/modules/dashboard-shell/core/nav-items.ts` (one "Kontakte" entry, visible to every
workspace member). C2's pipeline integration (switching `processOcrDocument` over to
`replaceDocumentLinks`, H-contract.md's "wave 2") is the next consumer, not yet landed.

## Tests

`tests/normalizers.test.ts` (table-driven: VAT id/IBAN whitespace-and-case normalization,
`normalizeName`'s legal-form stripping including "GmbH & Co. KG", umlaut preservation,
`nameSimilarity`), `tests/matching.test.ts` (every rule in `pickBestMatch`'s order including
the `name_only_unique` rule 6, each rule's ambiguity-yields-no-match case, that rule 6 never
fires when the extraction carries a postal code, and that a stronger rule wins over a weaker
one that would also match a different candidate), `tests/bank-detection.test.ts`
(`isLikelyBank`'s three rules: the footer-bankName-reference case (excluding self), a bare
IBAN/BIC party, a bank-token name with no VAT id, and the negatives - a full-address company
even when named "...Bank..." or "...Bausparkasse...", a normal customer carrying an IBAN and
an address, a real incoming fee invoice sent BY a bank whose own party self-attributes its
name as its own `bankName` but has an address, a bank's own letter from its own letterhead
address, and a party with none of the above signals at all), `tests/verification.test.ts`
(`computeContactUpdatePlan`'s fill/propose/no-op-when-equal-after-normalization branches,
including the numeric `paymentTermsDays` comparison), `tests/own-company.test.ts` (VAT id
match, name+postal-code match, and a near-miss - a different but similarly-named company at
the same postal code - that must NOT match), `tests/format-checks.test.ts` (IBAN checksum
against known-valid/invalid examples, German-exact and loose-foreign VAT id plausibility,
`checkContactFormats` never throwing), `tests/schemas.test.ts` (only `name` required, blank
optional fields treated as absent, malformed IBAN/VAT id rejected, every relation type
accepted, payment-terms coercion). All unit tests (`pnpm test`), no DB, no network.

C3's own UI tests, same "no DB, no network" rule: `tests/actions.test.ts` (every Server
Action, `vi.mock`ed access/request-services, mirrors
`src/modules/documents/tests/actions.test.ts`'s pattern; `markContactAsOwnCompanyAction`/
`markContactAsOwnBankAction`'s own cases (decisions/0037-correction-buttons.md) additionally
mock the `workspaces` use case and assert the orchestration order - `deleteContact` is never
called when `addCompanyAlias`/`addCompanyIban` rejects, and a cross-workspace/missing contact
id short-circuits before either is called), `tests/error-codes-i18n.test.ts` (every
`CONTACT_ACTION_ERROR_CODES` entry, including the two `WORKSPACE_ERROR` codes those two
actions surface unchanged and the module's own `contact_missing_iban`, resolves under both
`Contacts.form.errors` and `Contacts.detail.errors` in `de.json`, plus every comparable field
has a `Contacts.fieldLabels` entry), `tests/contact-list-query-schema.test.ts` (the list
page's URL-driven filter/pagination state), and four Testing Library component tests
(`@vitest-environment jsdom`): `tests/contact-form.test.tsx` (required-name validation, mapped
error rendering, an empty `paymentTermsDays`/`relationType` never sent as an empty string,
edit-mode prefill), `tests/proposal-list.test.tsx` (the IBAN warning callout renders only for
an `iban` field proposal, accept/reject call the right action and render a mapped error),
`tests/merge-contact-section.test.tsx` (client-side name search, the confirmation dialog's
copy naming both contacts and what moves, and the mapped `cannot_merge_self` error), and
`tests/contact-detail-client.test.tsx` (decisions/0037-correction-buttons.md: both correction
buttons hidden for a member, "Das ist unsere Bank" additionally hidden for a contact with no
usable IBAN, each confirmation's German copy, and the mapped-error/no-redirect path when a
correction is rejected).

The stateful side - repository scoping, the partial unique index on
`(workspace_id, vat_id_normalized)`, the real-Postgres concurrency guarantee for
`upsertFromExtraction`, `replaceDocumentLinks`'s full behaviour matrix (own-company/bank
skipping, own-IBAN stripping, one-role-per-contact, `relationType`'s no-silent-overwrite rule,
and a replayed version of the observed three-runs-in-22-seconds defect from
decisions/0035-contact-links-replace-and-bank-detection.md), and the integration flow (upload
a document, extract, link, match a second document from the same sender to the same contact) -
is `src/persistence/README.md`'s "Tests" section, not this file:
`src/persistence/tests/contacts-use-cases.test.ts` (unit, fakes, including the
`replaceDocumentLinks` describe block),
`src/persistence/tests/contacts-repository.db.test.ts` (now also `unlinkAllForDocument`'s
"removes every role" and workspace-scoping cases),
`src/persistence/tests/contacts-replace-document-links.db.test.ts` (real Postgres:
`replaceDocumentLinks`'s remove-and-rewrite and its `document_not_found` workspace scope),
`src/persistence/tests/contacts-use-cases-concurrency.db.test.ts`,
`src/persistence/tests/company-profile-corrections.db.test.ts`
(decisions/0037-correction-buttons.md: `addCompanyAlias`/`addCompanyIban` land normalized on
the real `workspaces` row and the contact row is really gone afterwards, idempotent
correction of two duplicate contacts, a too-generic alias leaves the contact undeleted, and a
cross-workspace contact id resolves `not_found` with nothing changed - all four `pnpm
test:docker` only), and `tests/integration/workflows/contacts-extraction.integration.test.ts`.

`tests/e2e/contacts.spec.ts` (C3, `pnpm test:e2e:docker`): manual create (always verified,
tagged `@smoke`), an unverified contact's badge and "Bestätigen" flow, a pending IBAN
proposal's warning callout and reject flow, and a merge moving a linked document's count from
the source to the target contact - test contacts/documents/proposals are seeded directly
against the test DB (`tests/e2e/helpers/contacts.ts`, the same shortcut
`tests/e2e/helpers/workspace.ts` already establishes for workspaces) rather than by driving
the OCR/extraction pipeline.
