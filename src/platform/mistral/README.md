# src/platform/mistral

Document type: reference
Lifecycle: active
Owner: src/platform/mistral
Scope: Mistral OCR and chat-completion access: the plain-fetch client, request/response
shapes, error classification, and env-based provider selection (real vs. fake vs.
not-configured)
Canonical responsibility: The only holder of `MISTRAL_API_KEY`; the only code that talks to
`api.mistral.ai`
Maintenance triggers:
- Mistral's OCR/chat API request or response shape changes
- A new AI provider is added, or the provider-selection logic changes
- `MISTRAL_API_KEY`/`AI_PROVIDER`/`MISTRAL_OCR_MODEL`/`MISTRAL_CHAT_MODEL` change
  (`src/platform/env/server/env.ts`)
- The analyzer's system prompt's own-company ("das sind wir") context format, or the
  parties/invoice JSON contract, changes (decisions/0021-extraction-direction-and-invoice-fields.md, C2)
- The payment arbiter's prompt or JSON contract changes (decisions/0023-payment-matching.md, F3a)
Last verified: 2026-09-23, decisions/0063-no-category-no-assignment-no-routing.md: the
`category` field is removed from the analyzer prompt, `AnalysisResult`, `GuidedAnalysisResult`,
and their validation - `@/persistence/repositories/contracts`'s `CATEGORY_KEYS` is gone, so
this owner's prompts no longer reference it. Previously, 2026-09-22, wave 2 of decisions/0036-guided-extraction.md
(`feature/guided-extraction-wiring`): `src/persistence/use-cases/documents-use-cases.ts`'s
`processOcrDocument` now calls `server/mistral-analyzer.ts`'s `analyzeGuided` instead of
`analyze` (the latter stays present, unused, pending a later cleanup). Two review corrections
landed in `server/prompts.ts`'s exclusion clause: no tenant brand name appears anywhere in it any
more (an earlier draft named "PayPal, Stripe, MUSTERBANK" - MUSTERBANK is one specific customer's own bank,
and this one prompt serves every tenant; a generic "die Bank in der Fußzeile" example replaces
it), and the payment-provider half of that clause is left out specifically for
`platform_settlement`/`payout_report` (`buildExclusionText(kind)`) - for those two kinds the
counterparty being asked for IS a payment provider, so excluding payment providers in the same
breath invited a `null` counterparty. Previously verified 2026-09-22, wave 1 of
decisions/0036-guided-extraction.md (`feature/guided-extraction`, additive, `main`'s own pipeline
behaviour unchanged on that branch): `server/prompts.ts` gained two prompt builders beside the
existing `buildAnalyzerSystemPrompt` - `buildGuidedDerivedSystemPrompt` (states the document's
`kind` and the workspace's own role as an established fact, asks for exactly one counterparty
object with no `role` field) and `buildGuidedOpenSystemPrompt` (today's "list every party"
narrowed to "at most 2 real business partners", an explicit bank/authority exclusion, an added
`reminderDirection` question for `kind: "reminder"`, zero parties for `kind: "bank_statement"`).
Both build an extended "DAS SIND WIR" own-company block (`@/modules/documents`'s
`OwnCompanyContext`, now carrying aliases/own IBANs/domains/free profile text, required since
wave 2) entirely in the system prompt, capping the free text at 1000 characters and running it
through `prompt-guard.ts`'s `neutralizeDelimiterLookalikes` (now exported, previously
module-private) as defense-in-depth against a forged delimiter reaching the prompt through that
field. `server/mistral-analyzer.ts`'s `createMistralDocumentAnalyzer` gained a second method,
`analyzeGuided`, beside the untouched `analyze` - both share one `fetchAnalyzerContent` helper
for the HTTP request and outer `JSON.parse`, `analyzeGuided`'s own result validated by
`@/modules/documents`'s new `validateGuidedAnalysisResult`. `server/get-ai-adapters.ts`'s
"not configured" analyzer gained the same method (fails the same way for both). Previously
verified 2026-09-20, F3a (decisions/0023-payment-matching.md): added the real
`PaymentArbiter` adapter (`server/mistral-payment-arbiter.ts`), its German prompt
(`server/payment-arbiter-prompts.ts`), and its env-based getter
(`server/get-payment-arbiter.ts`, re-exported from `server.ts`) - the same trio shape
`server/mistral-intake-classifier.ts`/`server/intake-prompts.ts`/`server/get-intake-classifier.ts`
already established for F1a, reusing `mistral-fetch.ts`/`core/schemas.ts`'s
`mistralChatResponseSchema` unmodified. `@/modules/payments`'s `validateArbiterResult` (not this
owner) is what turns the adapter's raw answer into a trusted `MatchSuggestion`; this owner's
adapter only produces the raw, unvalidated `PaymentArbiterRawResult`. Previously verified
2026-09-20 against C2 (decisions/0021-extraction-direction-and-invoice-fields.md):
`server/mistral-analyzer.ts`'s `analyze()` now also takes an `ownCompany` context
(`@/modules/documents`'s `OwnCompanyContext`) and passes it into
`server/prompts.ts`'s `buildAnalyzerSystemPrompt`, which now asks for `parties` (up to 3,
with a `role` hint) and `invoice` (invoice-shaped fields, only for an invoice/reminder/
receipt-like document) in the same one JSON response as before - never a second model call.
The prompt spells out the workspace's own name/address/VAT id so the model can label that
party `recipient` (or `sender`, for the workspace's own outgoing invoices) instead of
guessing; the response is still run through `@/modules/documents`'s `validateAnalysisResult`
unchanged in kind, just validating more fields. This file does not parse amounts itself -
that stays `@/modules/documents/core/amount-parsing.ts`'s job, called from
`validateAnalysisResult`, so both this real adapter and the fake analyzer give every caller
the same amount-parsing guarantee. P2b (processing pipeline), decisions/0016-processing-pipeline-and-ai.md

## Purpose

Implements `src/modules/documents`'s `OcrEngine`/`DocumentAnalyzer` ports against the real
Mistral API: `POST /v1/ocr` (OCR, `include_blocks: true`, the PDF sent as a base64
`data:` URL since object storage is private) and `POST /v1/chat/completions`
(title/sender/date/summary and field extraction - no category,
decisions/0063-no-category-no-assignment-no-routing.md - `temperature: 0`, `response_format: { type:
"json_object" }`, JSON parsed and validated through `src/modules/documents`'s
`validateAnalysisResult`). Plain `fetch`, no vendor SDK - `AbortSignal.timeout`, an
injectable `fetchImpl` for tests, and error classification (401/403 permanent
`ai_auth_failed`; 429 transient `ai_rate_limited`; 5xx/timeout/network transient
`ai_unavailable`/`ai_timeout`; an unparseable response permanent `ai_invalid_response`).
Never logs a request/response body or the API key.

`server/get-ai-adapters.ts` also picks the actual bound adapter by env, the same lazy
memoized-singleton pattern `src/platform/object-storage/server/get-object-storage.ts` uses:
the real Mistral adapters, `src/modules/documents`'s deterministic fakes, or a "not
configured" adapter that throws `ai_not_configured` on first use (a misconfigured
production deploy must fail loudly, never silently simulate AI output).

## Public interfaces

- `index.ts` (neutral, no `server-only`, no I/O): `MISTRAL_ERROR_CODES`/`MistralErrorCode`,
  `MistralRequestError` (carries `code` and `transient`) - safe for
  `src/persistence/use-cases/documents-use-cases.ts` to import and reclassify into
  `src/platform/jobs`'s `TransientJobError`/`PermanentJobError`.
- `server.ts` (`import "server-only"`): `getOcrEngine()`, `getDocumentAnalyzer()` (what the
  composition root binds - it never chooses between adapters itself),
  `isFakeAiProviderActive()` (the UI's "Testmodus: KI-Simulation aktiv" hint),
  `resetAiAdaptersForTests()`, plus (F1a) `getIntakeClassifier()`/
  `resetIntakeClassifierForTests()` and (F3a) `getPaymentArbiter()`/
  `resetPaymentArbiterForTests()` - each a separate getter file for the reason given in that
  file's own header comment, all re-exported from this one privileged entrypoint.

## Structure

- `core/errors.ts` - `MISTRAL_ERROR_CODES`, `MistralRequestError`.
- `core/schemas.ts` - lenient Zod schemas for the OCR and chat-completion responses:
  `blocks`/`dimensions` may be null or missing entirely on an OCR page (falls back to
  distributing markdown paragraphs down the page, `src/modules/documents/core/searchable-pdf.ts`).
- `server/mistral-fetch.ts` - the one place an HTTP request to `api.mistral.ai` is actually
  made; classification of the response/error into a `MistralRequestError`.
- `server/mistral-ocr-engine.ts` - `createMistralOcrEngine`, the real `OcrEngine`.
- `server/prompt-guard.ts` (R1 security review, suspected/medium) - `wrapUntrustedSection`/
  `describeGuardedSection`, the one shared helper every prompt file below uses to delimit its
  own untrusted section: a per-call random nonce in the delimiter
  (`<<<LABEL-<hex> START>>>`/`<<<LABEL-<hex> END>>>`) plus neutralizing any literal `<<<`/`>>>`
  run already present in the untrusted text, so it can never contain what looks like a real
  boundary marker (forged or copied from an older, fixed-marker version of these prompts). See
  that file's own header comment for why the system-prompt-facing `describeGuardedSection`
  describes the marker PATTERN generically rather than the exact nonce (the system and user
  prompt for one request are built by two separate function calls the adapters below combine;
  threading the literal nonce between them would need a call-site change). Wave 1 of
  decisions/0036-guided-extraction.md exported the previously module-private
  `neutralizeDelimiterLookalikes` so `prompts.ts`'s guided system prompt can apply the same
  defusing to a free-text field that never goes through `wrapUntrustedSection` at all (the
  workspace's own company-profile description, which must stay OUTSIDE the untrusted
  document-text section but is still admin-entered free text reaching a prompt).
- `server/prompts.ts` - the German analyzer system prompt: instructs the model (via
  `describeGuardedSection`) that the document text, wrapped by `buildAnalyzerUserPrompt` via
  `wrapUntrustedSection`, is untrusted data to analyze, never an instruction to follow (a
  prompt-injection mitigation, not a guarantee - what IS guaranteed is that the *output*
  always conforms to the expected shape, via `validateAnalysisResult`) - this original prompt
  and `buildAnalyzerSystemPrompt` itself are no longer called by `processOcrDocument` since
  decisions/0036-guided-extraction.md's wave 2, only by their own unit tests.
  decisions/0036-guided-extraction.md added `buildGuidedDerivedSystemPrompt`/
  `buildGuidedOpenSystemPrompt` beside it (wired into `processOcrDocument` since wave 2) - see
  this file's own "Last verified" entry above for what each one asks and the two review
  corrections (no brand names, no payment-provider exclusion for `platform_settlement`/
  `payout_report`).
- `server/mistral-analyzer.ts` - `createMistralDocumentAnalyzer`, the real `DocumentAnalyzer`.
  decisions/0036-guided-extraction.md added `analyzeGuided` beside `analyze`, sharing a
  `fetchAnalyzerContent` helper for the request/outer-JSON.parse plumbing; only the system
  prompt (picked by `plan.mode`) and the validator (`validateGuidedAnalysisResult` instead of
  `validateAnalysisResult`) differ between the two methods. `processOcrDocument` calls
  `analyzeGuided` exclusively since wave 2.
- `server/get-ai-adapters.ts` - the env-based provider selection described above.
- `server/intake-prompts.ts` / `server/mistral-intake-classifier.ts` / `server/get-intake-classifier.ts` -
  F1a's `IntakeClassifier` adapter, prompt, and getter (decisions/0020-universal-intake.md);
  see `@/modules/intake/README.md`'s "The Mistral adapter" section for the detail this file
  does not duplicate.
- `server/payment-arbiter-prompts.ts` - F3a's German payment-arbiter system/user prompt
  (decisions/0023-payment-matching.md): explicitly tells the model it is ranking a FIXED
  candidate list (never searching for one of its own) and that the transaction's remittance
  text is untrusted data, never an instruction.
- `server/mistral-payment-arbiter.ts` - `createMistralPaymentArbiter`, the real
  `PaymentArbiter` (`@/modules/payments`'s port). Returns the RAW, unvalidated
  `PaymentArbiterRawResult` - `@/modules/payments`'s `validateArbiterResult` (not this file) is
  what turns it into a trusted `MatchSuggestion`, so every `PaymentArbiter` implementation is
  validated identically in exactly one place.
- `server/get-payment-arbiter.ts` - F3a's env-based provider selection, mirroring
  `get-ai-adapters.ts`/`get-intake-classifier.ts` exactly (`AI_PROVIDER` precedence, `globalThis`
  memoization, a "not configured" adapter in production with no key).

## Env vars

Read only here and in `src/platform/env` (`STRUCTURE.md`'s `env-access` rule, which confines
only `MISTRAL_API_KEY`, the credential): `MISTRAL_API_KEY` (optional), `AI_PROVIDER`
(optional `"mistral" | "fake"`), `MISTRAL_OCR_MODEL`/`MISTRAL_CHAT_MODEL` (optional, default
to Mistral's own model names `mistral-ocr-latest`/`mistral-small-latest`).
`docker/compose.test.yml` sets `AI_PROVIDER: fake` explicitly so every test always exercises
the deterministic fakes, never the network.

## Dependencies on other owners

`@/platform/env/server` (`serverEnv`), `@/modules/documents` (this owner implements that
module's `OcrEngine`/`DocumentAnalyzer` ports and reuses its `validateAnalysisResult` and its
deterministic fakes - a platform owner implementing a module's port and importing that
module's neutral entrypoint is allowed by the direction matrix, WEBAPP_TEMPLATE_SPEC.md §4),
`@/modules/intake` (F1a: implements `IntakeClassifier`, reuses `parseIntakeClassification`),
`@/modules/payments` (F3a: implements `PaymentArbiter`, reuses its types for the prompt
builders and `MAX_ARBITER_CANDIDATES` for the same candidate-count guard the module's own
`validateArbiterResult` enforces).

## Consumers

`src/persistence/composition/create-request-services.ts` (`getOcrEngine()`/
`getDocumentAnalyzer()`, bound into `documents: createDocumentUseCases({ ... })`).
`src/modules/documents/ui/document-detail-client.tsx` (indirectly, via
`isFakeAiProviderActive()` read by the detail page seam for the "Testmodus" banner).
`getIntakeClassifier()` (F1a) and `getPaymentArbiter()` (F3a) are not yet wired into
`create-request-services.ts` - each is additive, composition-root-adjacent code kept in this
owner specifically so it does not require editing that in-flight file; F1b/F3b's own
composition-root work is the next consumer of either.

## Tests

- `tests/mistral-fetch.test.ts`: request shape (method, headers, body), response parsing,
  and classification of every status code this owner distinguishes, plus timeout and network
  failure, all against an injected `fetchImpl` - no network.
- `tests/mistral-ocr-engine.test.ts`: the request body (base64 `data:` URL,
  `include_blocks: true`), response mapping to camelCase, and fixtures for blocks
  present/null/missing.
- `tests/prompt-guard.test.ts` (R1) - the shared `wrapUntrustedSection`/`describeGuardedSection`
  helper: matching nonce on both ends of one wrap call, a different nonce per call, and
  neutralization of both a literal old-style fixed marker and an attempted nonce-shaped
  forgery injected into the untrusted text. Wave 1 of decisions/0036-guided-extraction.md added
  a direct `neutralizeDelimiterLookalikes` suite (now a public export).
- `tests/prompts.test.ts` / `tests/intake-prompts.test.ts` (R1) - each prompt file's own
  system-prompt guarded-section description and user-prompt delimiter wrapping/neutralization,
  on top of `payment-arbiter-prompts.test.ts` below (already covered this before R1).
  decisions/0036-guided-extraction.md added `buildGuidedDerivedSystemPrompt`/
  `buildGuidedOpenSystemPrompt` suites: the derived prompt states the kind/role as a fact (no
  `?` anywhere in it) and asks for exactly one `counterparty` with no `role` field; the open
  prompt no longer contains "alle auf dem Dokument genannten", asks for at most 2 parties, adds
  `reminderDirection` only for `kind: "reminder"`, and mode `"none"` asks for zero parties; both
  place a free-text company-profile description in the system prompt (never inside the
  untrusted section) and neutralize a forged prompt-guard delimiter inside that free text. Wave
  2 added: no tenant brand ("PayPal"/"Stripe"/"MUSTERBANK") appears in either prompt's exclusion
  clause, and the payment-provider half of that clause is absent specifically for
  `platform_settlement`/`payout_report` (present for every other kind, e.g. `receipt`).
- `tests/mistral-analyzer.test.ts`: `temperature: 0`, `response_format: json_object`, the
  untrusted-text delimiters, valid/invalid/non-JSON model content, and error propagation. Wave 1
  of decisions/0036-guided-extraction.md added an `analyzeGuided` suite: derived/open system-
  prompt selection, a well-formed derived-mode answer's counterparty (no `role` key),
  degradation on missing fields and non-JSON content, `MAX_GUIDED_PARTIES` truncation, and error
  propagation.
- `src/modules/documents/tests/analysis-validation.test.ts` (owned by `src/modules/documents`,
  the shared validator both adapters call): implausible date ->
  `null`, a prompt-injection-shaped field value never escapes the validated shape.
- `tests/mistral-intake-classifier.test.ts` (F1a): `temperature: 0`, `response_format:
  json_object`, hallucinated-column-name dropping, non-JSON degradation, error propagation.
- `tests/mistral-payment-arbiter.test.ts` (F3a): `temperature: 0`, `response_format:
  json_object`, the candidate list and untrusted-data delimiters in the user prompt, a
  well-typed and a wrong-typed raw response, the `MAX_ARBITER_CANDIDATES` guard (no request
  sent at all when exceeded), an empty candidate list (no request sent), and error
  propagation.
- `tests/payment-arbiter-prompts.test.ts` (F3a, updated R1): the system prompt's "ranker, not
  searcher" and untrusted-remittance-text instructions, that the user prompt places the
  transaction's own remittance text inside the random-nonce `<<<INPUT-<hex> START>>>`/
  `<<<INPUT-<hex> END>>>` delimiters, and neutralization of a delimiter-shaped forgery injected
  into the remittance text.
- `tests/get-payment-arbiter.test.ts` (F3a): the same env-boundary/caching pattern
  `src/platform/object-storage/tests/get-object-storage.test.ts` established - `AI_PROVIDER=fake`,
  no-key-outside-production, no-key-in-production (`ai_not_configured`), and caching across
  calls.

## Known limits

No production Mistral account is provisioned; `MISTRAL_API_KEY` is unset in every
environment this repository controls (local, CI, the Docker test stack), so the real
adapters (`server/mistral-ocr-engine.ts`/`server/mistral-analyzer.ts`/
`server/mistral-intake-classifier.ts`/`server/mistral-payment-arbiter.ts`) are exercised only
by their own unit tests against an injected `fetchImpl`, never against the live API. Sending
real customer document content to Mistral (an EU provider) in production needs a
data-processing agreement and a privacy-policy update first - explicitly out of scope for
this phase (decisions/0016-processing-pipeline-and-ai.md's "Consequences").
