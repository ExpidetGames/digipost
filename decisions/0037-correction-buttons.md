# Correction buttons: "Das sind wir" / "Das ist unsere Bank"

Document type: decision
Lifecycle: active
Owner: src/modules/contacts (the two Server Actions, the confirmation UI); the two
`WorkspaceUseCases` methods they call are owned by src/modules/workspaces
Scope: `markContactAsOwnCompanyAction`/`markContactAsOwnBankAction`
(`src/modules/contacts/actions.ts`), `WorkspaceUseCases.addCompanyAlias`/`addCompanyIban`
(`src/persistence/use-cases/workspaces-use-cases.ts`), and the two buttons on
`/dashboard/contacts/[id]` (`src/modules/contacts/ui/contact-detail-client.tsx`)
Canonical responsibility: Active source for why these two corrections write back into the
company profile instead of only deleting the contact, why they are admin-only while plain
contact deletion stays member-level, how "Das ist unsere Bank" is refused for a contact with
no usable IBAN, and what this phase deliberately does not build
Maintenance triggers:
- `addCompanyAlias`/`addCompanyIban`'s idempotency or validation rules change
- A third "turn a mistake into profile knowledge" correction is added, which should follow the
  same "profile update first, delete only on success" shape this ADR establishes
- The decision to hide (rather than show-then-reject) "Das ist unsere Bank" for a contact with
  no usable IBAN is revisited
Last verified: 2026-09-22, initial version (H5, follow-up to decisions/0034 and 0035)

## Status

Accepted

## Context

decisions/0034 and decisions/0035 fixed the pipeline going forward: a workspace's own bank and
its own brand name no longer become contacts on a fresh extraction. They did nothing about the
rows the ORIGINAL defect already created in the owner's own workspace - three "Musterfirma" rows
(the owner's own brand, decisions/0034's own "Context" section) and "MUSTERBANK PAYMENTS" (the
owner's own bank, carrying the owner's own IBAN, decisions/0035's own "Context" section) are
still sitting in the contact book. Plain "Löschen" (`deleteContactAction`,
decisions/0019-contacts.md) would remove them, but does nothing to stop the SAME mistake from
recurring the next time a document names the workspace under a brand the profile does not know
yet, or the next time its own bank shows up in a payment-details footer - decisions/0034's
`isOwnCompany` alias/domain rules and decisions/0035's `isLikelyBank` heuristics are exactly as
good as the company profile they are checked against.

The product decision: a correction on a contact that turns out to be the workspace itself, or
the workspace's own bank, should turn that one-off observation into PERMANENT knowledge (an
alias, or an own IBAN) so the same brand or bank never comes back as a contact again - not just
delete the symptom. This phase builds exactly two such buttons on `/dashboard/contacts/[id]`,
next to the existing "Löschen" action.

## Decision

### 1. Two narrow `WorkspaceUseCases` methods, reusing `updateCompanyProfile`'s own validation

`addCompanyAlias({ workspaceId, alias })` and `addCompanyIban({ workspaceId, iban })`
(`src/persistence/use-cases/workspaces-use-cases.ts`) each lock the workspace row
(`repos.workspace.lockForUpdate`, the same "two of several duplicate corrections clicked in
quick succession must not both read the profile before either one's write lands" reasoning
`invite`'s own lock already documents), merge the one new entry into the CURRENT list, and run
it through the exact same normalization/validation `updateCompanyProfile` itself uses:
`normalizeCompanyAliases` + `isGenericCompanyAlias` (throwing `alias_too_generic`) for the
alias, `isValidIbanFormat` + `normalizeIban` (throwing `invalid_iban`) for the IBAN, and
`MAX_COMPANY_PROFILE_LIST_ENTRIES` for both. No new validation rule is introduced; a value this
phase would reject is exactly one `/dashboard/settings/company`'s own form would also reject.

Both are idempotent: adding a name that already matches an existing alias case-insensitively,
or an IBAN that already normalizes to an existing entry, is a no-op success (the merged list is
unchanged, no duplicate is written) - this is what lets an admin click through the three
"Musterfirma" duplicates one at a time without the second and third click failing on an
already-present alias. `workspaces` is the only table these two methods write to
("only the owning module writes its own tables", AGENTS.md); they live beside
`updateCompanyProfile`, not in `src/modules/contacts`.

### 2. `src/modules/contacts` orchestrates: profile update first, delete only on success

`markContactAsOwnCompanyAction`/`markContactAsOwnBankAction`
(`src/modules/contacts/actions.ts`) are the only code that calls both areas' use cases in
sequence, through the same `getRequestServices()` composition graph every Server Action already
uses:

1. `contacts.getById(workspaceId, contactId)` - throws `not_found` for a contact that does not
   exist or belongs to a different workspace, exactly as every other contact action does. This
   also reads the contact's own current `name`/`iban`, so the value written to the profile is
   never taken from client input, only from the workspace's own already-scoped data.
2. `workspaces.addCompanyAlias`/`addCompanyIban` - if this throws (a too-generic alias, a
   malformed/blank IBAN, the 20-entry cap), the function returns that error immediately and
   NEVER reaches step 3. Nothing is deleted.
3. `contacts.deleteContact(workspaceId, contactId)` - only reached once step 2 has committed.

This is plain sequential `await`, not a cross-owner database transaction spanning two tables
(`workspaces` and `contacts` are each written by their own owning use case, in their own
transaction) - the ordering itself is what guarantees "nothing is deleted on a rejected
profile update", not a shared rollback. A crash between step 2 and step 3 (the profile
committed, the delete never ran) leaves a harmless, correctable leftover: the contact still
exists, now redundant with its own alias/IBAN, deletable by hand with the plain "Löschen"
button - an accepted, narrow residual gap, the same shape decisions/0035 section 4a already
accepts for a different two-step sequence.

Both actions require `PERMISSIONS.companyProfileManage` (admin-only), NOT `documentsWrite` (the
member-level bundle every other action on this page uses, including plain "Löschen"): these two
buttons change the SHARED company profile, a workspace-wide identity decision every member's
future document processing depends on, not a one-document correction. A member does not see
either button; the Server Action re-checks the same permission server-side regardless of what
the client renders (AGENTS.md's "never trust the client" review rule) - see `tests/actions.test.ts`.

### 3. "Das ist unsere Bank" without a usable IBAN: hidden, and refused server-side

A contact with no IBAN, or one that fails the mod-97 format check
(`isValidIbanFormat`), has nothing "Das ist unsere Bank" could meaningfully save. Two
independent guards, not one:

- The UI (`contact-detail-client.tsx`) never renders the button at all for such a contact
  (`hasUsableIban`).
- `markContactAsOwnBankAction` re-checks the identical condition server-side BEFORE calling
  `addCompanyIban`, returning the stable code `contact_missing_iban` (a new entry in
  `CONTACT_ACTION_ERROR_CODES`) rather than either failing silently or deleting a contact with
  nothing to remember. This is the same "never trust the UI alone" defense in depth every
  permission check in this codebase already gets, applied to a data-completeness check instead
  of an authorization one.

Both guards run the same check (`isValidIbanFormat` on the contact's own `iban` field), so the
server-side path is normally unreachable through the UI - it exists for the same reason
`updateCompanyProfile`'s own validation is re-checked in the use case even though the Server
Action's Zod schema already validated shape: "use cases/actions are the last line of defense"
(this file's own header comment convention).

### 4. What this phase deliberately does not build

- No automatic re-processing of already-processed documents once an alias/IBAN is added -
  a corrected contact's OWN past document links are removed along with it (the existing
  `document_contacts` cascade, decisions/0019), but no job is enqueued to re-run
  `replaceDocumentLinks` against every other document in the workspace that might now also
  match the new alias/IBAN. A future run processes correctly; past runs are not revisited.
- No fuzzy/similarity-based learning - the alias/IBAN added is EXACTLY the contact's current
  `name`/`iban` field, verbatim (after the same normalization every other entry point already
  applies), never a generalized or corrected form of it.
- No cleanup tooling beyond these two buttons - an admin still corrects one contact at a time,
  by hand, the same granularity `deleteContactAction`/`mergeContactsAction` already have.
- No new database migration and no new table - both new use-case methods write to the existing
  `workspaces.company_aliases`/`company_ibans` columns decisions/0034 already added.

## Consequences

- Positive: the exact two polluted-contact shapes decisions/0034/0035's own "Context" sections
  describe (a brand-name duplicate, a bank-as-contact carrying the workspace's own IBAN) now
  have a one-click fix that ALSO prevents the same mistake from recurring, closing the gap
  those two ADRs explicitly left open ("no cleanup of the existing polluted contact rows...a
  later, separate task" - decisions/0034's "Consequences", decisions/0035's "Context").
- Positive: idempotent alias/IBAN addition means correcting several duplicate contacts sharing
  one brand/bank works one click at a time with no special "already exists" handling needed in
  the UI.
- Positive: admin-only, defense-in-depth on both the permission and the IBAN-completeness
  check, matches this codebase's established "never trust the client" posture exactly.
- Negative / accepted risk: the two-step sequence is not atomic across the `workspaces` and
  `contacts` tables - a crash between the profile write and the contact delete leaves a
  redundant-but-harmless contact behind, correctable by hand (section 2 above).
- Negative / accepted, explicitly deferred: no automatic re-processing of other documents after
  a correction (section 4) - a real limitation for a workspace with many affected documents,
  accepted as out of scope the same way the owner and orchestrator scoped it going in
  (H5's own task brief: "no automatic re-processing of documents after a click").
- Implementation status: **implemented**. `addCompanyAlias`/`addCompanyIban`
  (`src/persistence/use-cases/workspaces-use-cases.ts`), `markContactAsOwnCompanyAction`/
  `markContactAsOwnBankAction` (`src/modules/contacts/actions.ts`), the two buttons and their
  German confirmation copy (`src/modules/contacts/ui/contact-detail-client.tsx`), covered by
  unit tests (both use cases), Server Action tests (permission gate, orchestration order,
  error mapping), a component test (visibility, confirmation copy), and a `.db.test.ts`
  proving the normalized write and the scoped delete against real Postgres.

## Supersedes / Superseded By

- None. Builds on decisions/0034-extended-company-profile.md's `updateCompanyProfile`
  validation and decisions/0035-contact-links-replace-and-bank-detection.md's own-company/bank
  observations; supersedes neither.
