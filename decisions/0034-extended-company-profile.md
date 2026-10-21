# Extended company profile: "Das sind wir"

Document type: decision
Lifecycle: active
Owner: src/modules/workspaces (schema/repository/use case/UI); `isOwnCompany` itself is
src/modules/contacts
Scope: The seven new `workspaces.company_*` columns (aliases, IBANs, domains, tax number,
register court/number, free profile text), `OwnCompanyProfile`'s extended shape, the
`isOwnCompany` decision order this phase adds to, the generic-alias guard, and the
onboarding/settings UI around all of it
Canonical responsibility: Active source for why the own-company match needed more than a
name/postal-code/VAT-id triple, the exact rule order `isOwnCompany` now follows (including
which signal was deliberately left out and why), the whole-name-only alias rule and the
generic-alias guard, and what is deliberately not built yet
Maintenance triggers:
- `isOwnCompany`'s rule order, thresholds, or which fields it compares change
- The generic-alias guard's token list or minimum length changes
- A "Das sind wir" one-click button (turning an extracted party directly into a profile entry)
  is built - this ADR's own "Consequences" section flags it as deliberately deferred
- Wave 2 (H2) wires `OwnCompanyContext`/the analyzer prompt to the new profile fields
Last verified: 2026-09-22, H1 (wave 1 of the "AI is told what to look for" feature, alongside
H2's extraction building blocks and H3's contact-link rules)

## Status

Accepted

## Context

The owner's own real outgoing invoice produced, across three consecutive processing runs, five
contact links from three parties - including the owner's own bank (MUSTERBANK, extracted from the
document's own footer as a party named "MUSTERBANK PAYMENTS", carrying the owner's own IBAN) filed
as a business contact, and the owner's own company filed under its brand name three times as
three separate duplicate rows. `isOwnCompany` (decisions/0019-contacts.md) only ever knew three
things about the workspace's own company: its exact legal name (`workspaces.name`), a postal
code, and a VAT id. On the actual documents this workspace produces:

- The letterhead reads "musterfirma" - a brand name, no address printed at all, nothing for the
  postal-code+similarity rule to even compare against, and no VAT id present either.
- A ChatGPT-generated invoice addresses the recipient as "Erika Maria Beispiel GbR" - a short
  form of the full stored name ("Mustermann Max Karl Konstantin, Erika Maria Beispiel
  GbR"), whose normalized-name similarity falls well under the 0.8 threshold `isOwnCompany`
  already required.
- The document's own bank footer names "MUSTERBANK PAYMENTS" as a party, carrying the workspace's
  own IBAN - a bank is not a business contact of the workspace, and its own account number
  showing up in the contact book at all is itself a data-quality problem regardless of how it
  got there.

The product decision, made with the owner: let an admin enter structured data about the
company (other names it appears under, its own bank accounts, its own web/e-mail domains, tax
and register data) plus free text that only ever HELPS the model find things, never decides
anything on its own. This ADR is the H1 slice of a three-agent feature (H-contract.md,
resolved to `src/modules/documents`'s own `party-roles.ts`/H2 and `src/modules/contacts`'s
`replaceDocumentLinks`/`bank-detection.ts`/H3, both landing separately) - H1's own job ends at
the repository row, `OwnCompanyProfile`, and `isOwnCompany` itself.

## Decision

### 1. Seven new `workspaces` columns, all optional with a safe default

`company_aliases`/`company_ibans`/`company_domains` (`text[]`, `not null default '{}'`),
`company_tax_number`/`company_register_court`/`company_register_number`/`company_profile_text`
(nullable `text`). Every existing workspace row before this migration simply has empty arrays
and null text - the migration is a plain `ADD COLUMN`, never a backfill, exactly like the six
`company_*` columns decisions/0019 added before it.

### 2. `OwnCompanyProfile` gains six fields, in this exact storage/normalization split

```ts
export type OwnCompanyProfile = {
  name: string;
  postalCode: string | null;
  vatId: string | null;
  aliases: string[];          // already normalized with normalizeName
  ibans: string[];            // already normalized with normalizeIban
  domains: string[];          // already lowercased, host only
  taxNumber: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
};
```

The DATABASE columns and the IN-MEMORY `OwnCompanyProfile` shape deliberately store aliases
differently:

- `workspaces.company_aliases` stores what the admin actually typed, only trimmed and
  de-duplicated case-insensitively (keeping the first occurrence's own casing) - so the
  settings form shows back "Musterfirma", not "musterfirma", on the next page load.
- `OwnCompanyProfile.aliases` (built by `toOwnCompanyProfile` in
  `src/persistence/use-cases/documents-use-cases.ts`, wave 1's one sanctioned edit to that file)
  applies `normalizeName` to each stored alias, because `isOwnCompany`'s alias rule is a
  normalized whole-name comparison and must not re-normalize on every call.

`company_ibans`/`company_domains`, by contrast, are stored ALREADY normalized
(`normalizeIban`/`normalizeCompanyDomain` respectively) - unlike an alias, normalizing an IBAN
or a domain loses nothing worth showing back to the admin, so there is no separate
display-vs-comparison split for those two.

### 3. `isOwnCompany`'s new decision order

Strongest first, the first rule that fires wins, `ownCompany`'s free `profileText` never
consulted (there is no code path for it to read - `OwnCompanyProfile` does not even carry that
field, only `OwnCompanyContext`, the analyzer's prompt-facing shape, does):

1. VAT id match (normalized) - unchanged from decisions/0019.
2. `registerCourt` AND `registerNumber` BOTH match (compared loosely, case/whitespace
   insensitive) - as unambiguous as a VAT id, present on some companies when a VAT id is not.
3. Normalized party name equals the normalized company name, OR equals any entry of
   `ownCompany.aliases` - **whole-name equality only, never a substring**: "Software" must
   never match "Mobile Software AG". This is what fixes both observed defects (the brand name,
   the short-form name).
4. Party `website`/`email` host equals any entry of `ownCompany.domains`.
5. Postal code exact match AND normalized-name similarity at or above the existing 0.8
   threshold - the original, decisions/0019 rule, now the last and weakest resort rather than
   the only structured-data rule available.
6. Otherwise not own.

### 4. Why NO IBAN rule

The obvious sixth rule - "a party's own `iban` matching one of `ownCompany.ibans` means it is
us" - was drafted, tested, and then explicitly REMOVED after review, before this ADR shipped.
`ownCompany.ibans` is real: the column, the mod-97 validation, and the settings UI all exist
and are exercised by this phase's own tests. It is simply never one of `isOwnCompany`'s match
rules, and `ExtractedContactData`/`isOwnCompany`'s own parameter type does not even offer an
`iban` field to read.

The reasoning: on a real outgoing invoice, the only IBAN printed on the document is OURS (as
the payee expecting to be paid) - but WHICH extracted party the model attaches that IBAN to in
its `parties` array is exactly the kind of per-run-unreliable signal decisions/0031 and 0032
already found the model's own role labels to be (three consecutive runs of one real invoice
producing three different party lists). If `isOwnCompany` trusted a party-level IBAN match, a
real customer the model mislabeled with our own IBAN would be silently treated as "own company"
and vanish from the contact book entirely - the single most dangerous failure mode this whole
feature exists to prevent, and strictly worse than the defect it was built to fix (a spurious
extra contact is merely untidy; a disappeared real customer is a lost business relationship).

The document's own payment IBAN, by contrast, stays a strong, DOCUMENT-level fact used
elsewhere in this same feature (H2's reminder-direction override: "if the document's payment
IBAN is one of ours, the reminder is outgoing"), and H3's `replaceDocumentLinks` independently
strips our own IBAN off of any party's record before it is ever written to a contact - both of
those are safe precisely because neither one uses an IBAN to decide WHO a party is, only what
to do once the party's identity is already known some other way.

### 5. The generic-alias guard

`updateCompanyProfile` (`src/persistence/use-cases/workspaces-use-cases.ts`) rejects an alias,
with the stable error code `alias_too_generic`, when it is either:

- shorter than 3 characters after trimming, or
- normalizes (lowercase, punctuation collapsed to spaces, umlauts/ß kept intact - the same
  shape `@/modules/contacts`'s own `normalizeName` suffix list uses, though this is a separate,
  local token list rather than a reuse of that private list, since the two checks solve
  different problems: stripping a suffix off a longer name versus rejecting an alias that IS
  nothing but a legal form) to a bare legal-form token: "gbr", "gmbh", "gmbh co kg", "ag", "kg",
  "ohg", "ug", "ug haftungsbeschraenkt", "e k"/"ek", "e v"/"ev", and a few more.

Since `isOwnCompany`'s alias rule (§3.3) is a whole-name match, an alias that is only "GbR" or
only "GmbH" would match every company sharing that legal form in Germany - obviously wrong. The
guard runs in the persistence use case (not only in the Zod schema, which only validates
SHAPE - array length, per-entry max length): every alias is checked and normalized BEFORE any
write, so a single bad entry never leaves the rest of the profile partially saved.

### 6. IBAN/domain validation, same "reject before any write" shape

Each IBAN is checked against `@/modules/contacts`'s existing `isValidIbanFormat` (mod-97
checksum) before being normalized and stored; a failure throws `invalid_iban`. Each domain is
normalized (`normalizeCompanyDomain`: strip scheme, leading `www.`, path/query/fragment, and
port, then lowercase - `"https://www.musterfirma.de/x"` becomes `"musterfirma.de"`) and then
checked against a loose host-shape pattern; a failure throws `invalid_domain`. Both mirror the
alias guard's own "normalize and validate every entry before touching the repository" shape,
and both are unit-tested directly (the pure functions) as well as through
`updateCompanyProfile`'s own behavior.

### 7. UI: onboarding stays short, the settings form gets everything

`/onboarding`'s form collects only the new `aliases` field beyond what decisions/0021 already
asked for (name, address, optional VAT id) - the product decision was to keep onboarding fast;
a new admin can add IBANs, domains, tax/register data, and the free-text field later, from
`/dashboard/settings/company`. The free-text field's exact label/placeholder (German, formal
"Sie", per the owner's own wording):

- Label: "Was soll die KI über Ihr Unternehmen wissen?"
- Help text: "Hilft der KI, Sie von Ihren Kunden, Lieferanten und Ihrer Bank zu unterscheiden.
  Nennen Sie zum Beispiel Markennamen, Ihre Bank und womit Sie Ihr Geld verdienen."
- Placeholder: "Wir treten als \"musterfirma\" auf, nicht mit dem vollen GbR-Namen. Unsere Bank
  ist MUSTERBANK, sie ist weder Kunde noch Lieferant."

Both forms use a plain textarea, one entry per line, for the three list fields (aliases/IBANs/
domains) rather than individual add/remove rows - simplest implementation for a field that
rarely holds more than a handful of entries, and consistent with this module's existing
one-`<textarea>`-per-list-field convention (`contact-form.tsx`'s own notes field). Both forms
are gated behind the SAME `PERMISSIONS.companyProfileManage` bundle decisions/0021 already
established - no new permission bundle needed.

## Consequences

- Positive: the observed defect's exact three failure modes (brand-name letterhead, short-form
  invoice recipient, own-bank-as-contact) are each closed by a specific, independently-tested
  rule (§3.3 for the first two - once "musterfirma"/the short GbR name are entered as aliases -
  and, together with H3's separate `isLikelyBank` and IBAN-stripping, the third).
- Positive: the whole-name-only alias rule plus the generic-alias guard together prevent the
  most obvious new false-positive risk this feature introduces (an over-broad alias silently
  swallowing unrelated companies) - both are unit-tested with the exact cases named in this
  ADR ("Software" not matching "Mobile Software AG"; "GbR" alone rejected outright).
- Positive: dropping the IBAN rule (§4) before shipping, rather than after a real false
  positive, is the deliberate outcome of an explicit review pass during this same phase - the
  reasoning is recorded here specifically so the temptation to re-add it later (an IBAN match
  "feels" like an obviously strong signal) is caught by this ADR first, not by a fresh
  false-positive report.
- Negative: `company_ibans`/`company_domains` are collected and validated but, until wave 2
  (H2/H3) lands, have exactly two consumers that were built in a DIFFERENT wave-1 branch
  (H2's reminder-direction override, H3's bank-detection/IBAN-stripping) - within THIS branch
  alone, they are inert data the admin can enter but nothing yet reads for a decision beyond
  `isOwnCompany`'s own (deliberately IBAN-free) rules above.
- Negative/deferred, explicitly out of scope for this phase (agreed with the owner): no
  one-click "Das sind wir" / "Das ist unsere Bank" button that would turn an already-extracted
  party directly into a profile entry (a later, separate task); no fuzzy/similarity-based alias
  matching (whole-name equality only, by design); no automatic learning of aliases from
  repeated extractions (a human must type each one in); no cleanup of the existing polluted
  contact rows the observed defect already created (a later, orchestrator-run task, out of
  every one of this feature's three agents' scope).
- Implementation status: **implemented** (H1, wave 1). Schema
  (`src/persistence/schema/workspaces.ts`), repository contract/adapter
  (`src/persistence/repositories/{contracts,drizzle}/workspaces-repository.ts`), the use case
  (`src/persistence/use-cases/workspaces-use-cases.ts`'s extended `updateCompanyProfile`, the
  pure `normalizeCompanyDomain`/`isLikelyCompanyHost`/`normalizeCompanyAliases`/
  `isGenericCompanyAlias` functions), `OwnCompanyProfile`/`isOwnCompany`
  (`src/modules/contacts/core/{types,own-company}.ts`), and the onboarding/settings UI
  (`src/modules/workspaces/ui/{onboarding-form,company-profile-form}.tsx`) all land in this
  phase, covered by unit, component, and `.db.test.ts` tests (this repository's `pnpm verify`
  plus `pnpm test:docker`, both green). **Not implemented yet, explicitly out of scope for
  H1**: wave 2's wiring of `OwnCompanyContext`/the analyzer prompt to the new fields
  (`src/modules/documents/core/ports.ts` stays H2's file untouched by this phase), and every
  item in the "Negative/deferred" bullet above.

## Supersedes / Superseded By
- Extends decisions/0019-contacts.md's "Own-company exclusion" section (`isOwnCompany`'s
  original two-rule order); does not supersede it.
