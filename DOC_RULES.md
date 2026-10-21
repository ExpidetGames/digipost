# Documentation Governance

Document type: reference
Lifecycle: active
Owner: template maintainer
Scope: Documentation ownership, placement, lifecycle, discovery, supersession, and templates for this repository
Canonical responsibility: Repository-wide documentation governance
Maintenance triggers:
- Documentation ownership, lifecycle, or discovery rules change
- A new durable owner boundary (module, shared, platform, or persistence owner) is introduced
- The ADR or ownership rules change
Last verified: 2026-09-14 against WEBAPP_TEMPLATE_SPEC.md §12 and AGENTS.md

One Next.js project, one `AGENTS.md`, one `decisions/` directory, no `apps/` workspace
split.

## 1) Ownership and Placement

Documentation lives with the boundary that owns the documented responsibility:

- Repository root: project-wide context, governance, and this file's own scope
  (`README.md`, `AGENTS.md`, `DOC_RULES.md`, `STRUCTURE.md`, `decisions/`).
- Owner root (`src/modules/<capability>/`, `src/shared/<purpose>/`, `src/platform/<concern>/`, or
  `src/persistence/` as a single owner with internal layers, per `WEBAPP_TEMPLATE_SPEC.md`
  §3): that owner's implementation architecture, interfaces, invariants, and local
  workflow, in its own `README.md`.
- Decision scope: an ADR lives in `decisions/` regardless of which owner it concerns;
  there is no per-owner ADR directory. `decisions/README.md` indexes all of them.

There is no general `docs/` folder. It does not exist today and must not be created.
Implementation documentation does not move to the repository root merely to make
discovery easier; it stays with its owner.

## 2) Layered Discovery

Discovery proceeds from broad scope to the nearest owner:

1. `README.md` (project purpose, setup, commands, env variables).
2. `AGENTS.md` (this repository's agent rules) and `STRUCTURE.md` (structure policy
   and its machine-readable blocks).
3. The nearest owner `README.md`.
4. `decisions/README.md`, then the specific ADR, for anything touching a documented
   decision.

`README.md` and `AGENTS.md` route readers to owning boundaries; they do not need to list
every owner-local document. An owner `README.md` may add stricter local rules but cannot
weaken repository-wide safety or governance rules.

## 3) Canonical Sources and Precedence

- One claim has one canonical active source.
- A document's declared canonical responsibility applies only within its stated scope.
- Owner-local implementation documentation takes precedence over broader explanation for
  that owner's own implementation details.
- Repository-wide safety rules (`AGENTS.md`) always remain applicable regardless of what
  a more local document says.
- A superseded document keeps only a short provenance/redirect, not a duplicate full
  active document, once its replacement exists.
- When sources conflict or ownership is unclear, verify against current code and ask
  rather than silently picking a preferred source.

## 4) Document Identity and Metadata

Every new or materially rewritten durable document (not a code comment, not a commit
message) declares this header before its body:

```md
# <Title>

Document type: how-to | reference | explanation | decision | tracker
Lifecycle: draft | proposed | active | needs-verification | deprecated | superseded | archived
Owner: <owning boundary or accountable person>
Scope: <what this document covers>
Canonical responsibility: <claims for which this is the active source>
Maintenance triggers:
- <changes requiring review>
Last verified: <date and basis, when factual freshness matters>
```

`Last verified` is required whenever the document makes a factual, implementation,
operational, or provider-state claim whose freshness matters.

## 5) Content by Type

The structure matches the document's declared type, not a universal checklist.

- **How-to**: Goal, Prerequisites, Steps, Verification, Troubleshooting (only if
  relevant).
- **Reference**: exhaustive, factual, no narrative: entities/APIs, fields/parameters
  with types and defaults, error/status codes and their triggers, versioning notes if
  applicable.
- **Explanation**: conceptual overview, structure and responsibilities, key flows (a
  diagram is proposed, not mandatory; the reader decides if it helps), tradeoffs, known
  limits.
- **Decision (ADR)**: see §6 below.

Architecture documents (explanation type, describing a subsystem or data flow) cover one
clear boundary, mirror the real module/component structure rather than arbitrary
headings, propose a diagram (least detail that still explains the system), and list
inbound/outbound interfaces explicitly.

## 6) ADRs

- Location: `decisions/NNNN-kebab-title.md`, four-digit zero-padded sequence number,
  indexed in `decisions/README.md`.
- Layout, at minimum: `## Status`, `## Context`, `## Decision`, `## Consequences`, plus
  the metadata header from §4 above (`Document type: decision`).
- Status values: `Proposed`, `Accepted`, `Rejected`, `Deprecated`, `Superseded`. This is
  separate from the header's `Lifecycle` field: `Lifecycle` describes the document's own
  governance state (`active` for a currently-binding ADR, `superseded` once replaced);
  `Status` describes the decision itself.
- **ADRs are immutable once accepted.** Never rewrite an accepted ADR's `Decision` or
  `Consequences` after the fact. A changed decision gets a new ADR; the old one is marked:

  ```md
  Lifecycle: superseded

  ## Status
  Superseded

  Superseded by: <relative link>
  Superseded on: <date>
  ```

  and the new ADR links back with a `## Supersedes / Superseded By` section. Both links
  are bidirectional: the reader can start at either end.
- A decision whose implementation has not landed yet is still `Status: Accepted` if it is
  binding going forward; say explicitly in `Consequences` that the implementation is
  **planned** and name what still runs the old way (or does not exist yet), rather than
  leaving the document silent about the gap between decision and code.
- Merge trivially related decisions into one ADR when they are two facets of the same
  choice; do not force a merge between decisions that happen to share a topic but have
  independent Context/Consequences.

## 7) Writing Style

- English, precise, no marketing tone.
- No em dash character ("—"); use a comma, a colon, or parentheses instead.
- Match the document type: how-tos guide, references state facts, explanations build
  understanding, ADRs record a decision and its tradeoffs.
- Introduce a term once, then reuse it exactly; do not introduce a synonym for something
  already named.
- Explicit states and transitions; never imply a state machine, write it out.
- Keep exact technical detail (codes, durations, formulas) rather than paraphrasing it
  away; a reference or ADR that loses precision to read more smoothly is worse, not
  better.

## 8) Supersession and Archival

- **Superseded**: see §6. Applies to any durable document, not only ADRs.
- **Archived**: no archive exists in this repository, and none should be created
  speculatively; git history is the record of what a removed document used to say. If one
  is ever needed, it requires a complete provenance block (original path, archived-on
  date, reason, last known verification, replacement, retention owner) and semantic
  review before creation.
- **Deletion** is separate from archival and always requires explicit user approval.

## 9) Templates

### 9.1 Reference
```md
# <Title>

Document type: reference
Lifecycle: active
Owner: ...
Scope: ...
Canonical responsibility: ...
Maintenance triggers:
- ...
Last verified: ...

## Entities / APIs
- <Name>: ...

## Parameters / Fields
- `<field>`: type, allowed values, default, meaning

## Errors / Status Codes
- `<code>`: meaning, trigger
```

### 9.2 Explanation
```md
# <Title>

Document type: explanation
Lifecycle: active
Owner: ...
Scope: ...
Canonical responsibility: ...
Maintenance triggers:
- ...
Last verified: ...

## Conceptual Overview
...

## Structure & Responsibilities
- ...

## Key Flows
...

## Tradeoffs
- ...

## Known Limits
- ...
```

### 9.3 Decision (ADR)
```md
# <Title>

Document type: decision
Lifecycle: active
Owner: ...
Scope: ...
Canonical responsibility: ...
Maintenance triggers:
- ...
Last verified: ...

## Status
Proposed | Accepted | Rejected | Deprecated | Superseded

## Context
...

## Decision
...

## Consequences
...

## Supersedes / Superseded By
- <link, if applicable>
```
