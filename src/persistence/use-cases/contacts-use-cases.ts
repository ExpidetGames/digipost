// Owner: src/modules/contacts (decisions/0019-contacts.md). Inputs are normalized and
// re-checked here even though a future Server Action layer (C3) will already have parsed
// them with Zod: use cases are the last line of defense (WEBAPP_TEMPLATE_SPEC.md §5.4). No
// `next/*`, `react`, `src/platform/*/client`, or a module's own `server.ts`/`client.ts` -
// only `Repositories`/`UnitOfWork` from `src/persistence/repositories/contracts` and pure
// logic from `@/modules/contacts`'s neutral `index.ts` (persistence may import modules,
// WEBAPP_TEMPLATE_SPEC.md §4's direction matrix).
//
// `upsertFromExtraction` is the pipeline's (C2) one entry point and the method worth reading
// closely first: it fetches every contact in the workspace (`ContactRepository.listAllForWorkspace`
// - acceptable at this product's scale, see that method's own doc comment), runs the pure
// `pickBestMatch` against them, and then either creates a new contact or applies
// `computeContactUpdatePlan`'s fill/contradiction diff to the matched one - all inside one
// transaction that also links the document. If that transaction fails on a unique-constraint
// violation (two concurrent uploads for the same never-seen-before VAT id both decided "no
// match" and both tried to insert), it is retried exactly once: the winner's row is now
// visible, so the retry matches instead of colliding again
// (`src/persistence/tests/contacts-use-cases-concurrency.db.test.ts` proves this against real
// Postgres, not only asserted here).
import {
  COMPARABLE_CONTACT_FIELDS,
  computeContactUpdatePlan,
  isLikelyBank,
  isOwnCompany,
  normalizeExtractedForMatching,
  normalizeIban,
  normalizeName,
  normalizeVatId,
  pickBestMatch,
  type ComparableContactField,
  type ContactProposalStatus,
  type ContactRelationType,
  type DocumentContactRole,
  type ExtractedContactData,
  type MatchStrength,
  type OwnCompanyProfile,
} from "@/modules/contacts";
import { isDbError } from "@/persistence/foundation/db-errors";
import type {
  ContactChangeProposalRow,
  ContactFieldsPatch,
  ContactRow,
  CreateContactRow,
  Repositories,
  UnitOfWork,
} from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";

export const CONTACT_ERROR = {
  invalidInput: "invalid_input",
  notFound: "not_found",
  documentNotFound: "document_not_found",
  proposalNotFound: "proposal_not_found",
  cannotMergeSelf: "cannot_merge_self",
} as const;
export type ContactErrorCode = (typeof CONTACT_ERROR)[keyof typeof CONTACT_ERROR];

export type Contact = {
  id: string;
  workspaceId: string;
  name: string;
  legalForm: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  taxNumber: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  leitwegId: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  accountHolder: string | null;
  sepaCreditorId: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  contactPerson: string | null;
  customerNumber: string | null;
  supplierNumber: string | null;
  paymentTermsDays: number | null;
  relationType: ContactRelationType | null;
  notes: string | null;
  source: "auto" | "manual";
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  firstSeenDocumentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ContactDocumentLink = {
  documentId: string;
  role: DocumentContactRole;
  originalFileName: string;
  documentCreatedAt: Date;
};

export type ContactProposal = {
  id: string;
  contactId: string;
  documentId: string | null;
  field: string;
  currentValue: string | null;
  proposedValue: string | null;
  status: ContactProposalStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByUserId: string | null;
};

export type ContactDetail = Contact & { documents: ContactDocumentLink[]; pendingProposals: ContactProposal[] };

export type ListContactsInput = {
  q?: string;
  relationType?: ContactRelationType;
  verified?: boolean;
  page: number;
  pageSize: number;
};

/** Every editable field a human can set by hand - the same set `@/modules/contacts`'s
 * `manualContactCreateSchema`/`manualContactUpdateSchema` validate, plus the workspace/actor
 * context only the use case (never the module) knows about. */
export type ManualContactFields = Partial<Record<ComparableContactField, string | number>> & { relationType?: ContactRelationType };

export type CreateManualContactInput = ManualContactFields & { workspaceId: string; actingUserId: string; name: string };
export type UpdateManualContactInput = ManualContactFields & { workspaceId: string; actingUserId: string; contactId: string; name: string };

export type UpsertFromExtractionInput = {
  workspaceId: string;
  documentId: string;
  role: DocumentContactRole;
  extracted: ExtractedContactData;
};

export type UpsertFromExtractionResult = {
  contactId: string;
  created: boolean;
  /** `null` when `created` is `true` (there was nothing to match against). */
  matchStrength: MatchStrength | null;
  proposalsCreated: number;
};

/** One party the processing pipeline extracted from a document, ready for
 * `replaceDocumentLinks` - `relationType` is decided in code from the document's `kind`
 * (`@/modules/documents/core/party-roles.ts`'s `planCounterparty`), never from the model, so
 * it arrives already resolved here rather than being computed by this use case. */
export type ReplaceDocumentLinksParty = {
  role: DocumentContactRole;
  relationType: ContactRelationType | null;
  extracted: ExtractedContactData;
};

export type ReplaceDocumentLinksInput = {
  workspaceId: string;
  documentId: string;
  /** `null` when the workspace has not filled in its company profile yet - `isOwnCompany`
   * then never matches anything, same as its existing callers. Only used for the
   * `isOwnCompany` check; own-IBAN detection uses `ownIbans` below instead (H-contract.md's
   * "Two waves": this use case must compile against `main`'s current `OwnCompanyProfile`
   * regardless of what a concurrent branch adds to it, so the caller passes its own IBANs
   * separately rather than this reading `ownCompany.ibans`). */
  ownCompany: OwnCompanyProfile | null;
  ownIbans: readonly string[];
  parties: ReplaceDocumentLinksParty[];
};

export type ReplaceDocumentLinksResult = {
  /** Number of distinct contacts this document ends up linked to (after the "one role per
   * contact" reduction below) - NOT the number of parties given. */
  linked: number;
  created: number;
  proposalsCreated: number;
  skippedOwnCompany: number;
  skippedBank: number;
};

export interface ContactUseCases {
  listForWorkspace(workspaceId: string, filter: ListContactsInput): Promise<{ items: Contact[]; hasMore: boolean }>;
  /** Throws `not_found` for a contact that does not exist in this workspace. */
  getById(workspaceId: string, id: string): Promise<ContactDetail>;
  /** A human creating a contact by hand always counts as verification (`verified_at = now`,
   * `verified_by_user_id`) - they just looked at it. */
  createManual(input: CreateManualContactInput): Promise<Contact>;
  /** A full replace of every editable field (the caller re-supplies the whole form, so a
   * field the human cleared genuinely becomes `null` - unlike `upsertFromExtraction`'s
   * partial fill-only-if-empty patch). Also counts as verification, for the same reason as
   * `createManual`. */
  updateManual(input: UpdateManualContactInput): Promise<Contact>;
  deleteContact(input: { workspaceId: string; contactId: string }): Promise<void>;
  /** Validates both `documentId` and `contactId` resolve to `workspaceId` before linking
   * (`invalid_input` otherwise) - idempotent, linking the same `(document, contact, role)`
   * twice is a no-op. */
  linkDocument(input: { workspaceId: string; documentId: string; contactId: string; role: DocumentContactRole }): Promise<void>;
  unlinkDocument(input: { workspaceId: string; documentId: string; contactId: string; role: DocumentContactRole }): Promise<void>;
  /** Moves every document link and proposal from `sourceId` to `targetId`, fills `targetId`'s
   * empty fields from `sourceId`'s non-empty ones, then deletes `sourceId` - all in one
   * transaction. Rejects merging a contact into itself (`cannot_merge_self`). Does not touch
   * `targetId`'s verification state (no acting user is part of this contract today; C3's
   * merge UI can pass one through in a later, additive change if it should also re-verify). */
  mergeContacts(input: { workspaceId: string; sourceId: string; targetId: string }): Promise<Contact>;
  listProposals(workspaceId: string, filter?: { status?: ContactProposalStatus }): Promise<ContactProposal[]>;
  /** Applies the proposed value to the contact (recomputing `vat_id_normalized`/
   * `iban_normalized` when that field changed) and marks the contact verified again by
   * `decidedByUserId` - accepting a proposal is a human explicitly reviewing and approving
   * that exact field, at least as deliberate as `createManual`/`updateManual`'s own
   * verification rule. */
  acceptProposal(input: { workspaceId: string; proposalId: string; decidedByUserId: string }): Promise<void>;
  /** Marks the proposal rejected; never touches the contact's own fields or verification
   * state. */
  rejectProposal(input: { workspaceId: string; proposalId: string; decidedByUserId: string }): Promise<void>;
  /** The processing pipeline's (C2) one entry point - see this file's header comment. */
  upsertFromExtraction(input: UpsertFromExtractionInput): Promise<UpsertFromExtractionResult>;
  /** G-wave contact-links fix (H-contract.md section 3, decisions/0035): the pipeline's ONE
   * entry point for writing a document's contact links, replacing the per-party
   * `upsertFromExtraction` loop it used to run. REPLACES every existing link for this
   * document (removes all, then writes the given `parties`) rather than appending to
   * whatever earlier runs left behind - see this method's implementation doc comment for the
   * full guarantee list (own-company/bank filtering, one role per contact, own-IBAN
   * stripping, `relationType`'s no-silent-overwrite rule). Throws `document_not_found` if
   * `documentId` does not resolve to `workspaceId`. */
  replaceDocumentLinks(input: ReplaceDocumentLinksInput): Promise<ReplaceDocumentLinksResult>;
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    legalForm: row.legalForm,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    postalCode: row.postalCode,
    city: row.city,
    country: row.country,
    vatId: row.vatId,
    taxNumber: row.taxNumber,
    registerCourt: row.registerCourt,
    registerNumber: row.registerNumber,
    leitwegId: row.leitwegId,
    iban: row.iban,
    bic: row.bic,
    bankName: row.bankName,
    accountHolder: row.accountHolder,
    sepaCreditorId: row.sepaCreditorId,
    phone: row.phone,
    email: row.email,
    website: row.website,
    contactPerson: row.contactPerson,
    customerNumber: row.customerNumber,
    supplierNumber: row.supplierNumber,
    paymentTermsDays: row.paymentTermsDays,
    relationType: row.relationType as ContactRelationType | null,
    notes: row.notes,
    source: row.source as "auto" | "manual",
    verifiedAt: row.verifiedAt,
    verifiedByUserId: row.verifiedByUserId,
    firstSeenDocumentId: row.firstSeenDocumentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProposal(row: ContactChangeProposalRow): ContactProposal {
  return {
    id: row.id,
    contactId: row.contactId,
    documentId: row.documentId,
    field: row.field,
    currentValue: row.currentValue,
    proposedValue: row.proposedValue,
    status: row.status as ContactProposalStatus,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedByUserId: row.decidedByUserId,
  };
}

/** Every `COMPARABLE_CONTACT_FIELDS` entry from `input`, trimmed, with a blank/absent value
 * mapped to `null` - a FULL replace, never a sparse patch: both `createManual` (a fresh row,
 * where "omitted" and "null" already mean the same thing) and `updateManual` (an edit form
 * that always re-supplies its whole state, where a field the human cleared must actually
 * become `null`, not stay whatever it was before) want this same "authoritative snapshot"
 * shape. Contrast `computeContactUpdatePlan`'s `fillPatch` (`@/modules/contacts`), the one
 * place that genuinely needs a sparse "only these fields changed" patch, for
 * `upsertFromExtraction`'s asymmetric fill-empty-only rule. */
type ComparableFieldsSnapshot = Required<Pick<CreateContactRow, ComparableContactField>>;

function mapComparableFieldsForReplace(
  input: Partial<Record<ComparableContactField, string | number | null | undefined>>,
): ComparableFieldsSnapshot {
  const result: Partial<Record<ComparableContactField, string | number | null>> = {};
  for (const field of COMPARABLE_CONTACT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      result[field] = null;
    } else if (typeof value === "string") {
      result[field] = value.trim() ? value.trim() : null;
    } else {
      result[field] = value;
    }
  }
  // Each field's value type is preserved unchanged from `input` (only trimmed/nulled) - safe
  // to assert the precise per-field record type a generic keyed loop cannot express to the
  // structural type checker on its own.
  return result as ComparableFieldsSnapshot;
}

function normalizedCountry(raw: string | number | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed.toUpperCase() : "DE";
}

function toDiffShape(row: ContactRow): Record<ComparableContactField, string | number | null> {
  const shape = {} as Record<ComparableContactField, string | number | null>;
  for (const field of COMPARABLE_CONTACT_FIELDS) {
    shape[field] = row[field] as string | number | null;
  }
  return shape;
}

export function createContactUseCases(deps: { repos: Repositories; uow: UnitOfWork; now?: () => Date }): ContactUseCases {
  const now = deps.now ?? (() => new Date());

  async function requireContact(repos: Repositories, workspaceId: string, id: string): Promise<ContactRow> {
    const row = await repos.contact.findById(workspaceId, id);
    if (!row) throw new UseCaseError(CONTACT_ERROR.notFound);
    return row;
  }

  /**
   * Matches-or-creates a contact from one extraction and applies the fill-or-propose diff -
   * every part of `upsertFromExtraction`'s job EXCEPT writing the document link itself, so
   * `replaceDocumentLinks` (below) can reuse this exact matching/no-silent-overwrite logic
   * while deferring which role (if any) actually gets linked to its own "one role per
   * contact" reduction (H-contract.md section 3). `attemptUpsertFromExtraction` is the thin
   * wrapper that also links, for `upsertFromExtraction`'s own single-party contract.
   */
  async function upsertContactOnly(
    repos: Repositories,
    name: string,
    extracted: ExtractedContactData,
    documentId: string,
    workspaceId: string,
  ): Promise<{ contactId: string; created: boolean; matchStrength: MatchStrength | null; proposalsCreated: number }> {
    const normalized = normalizeExtractedForMatching(extracted);
    const candidates = await repos.contact.listAllForWorkspace(workspaceId);
    const match = pickBestMatch(normalized, candidates);

    let contactId: string;
    let created = false;
    let matchStrength: MatchStrength | null = null;
    let proposalsCreated = 0;

    if (match) {
      matchStrength = match.strength;
      contactId = match.contactId;
      const existing = candidates.find((c) => c.id === match.contactId);
      if (!existing) throw new Error("pickBestMatch returned a contact id absent from its own candidate list");

      const { fillPatch, proposals } = computeContactUpdatePlan(toDiffShape(existing), extracted);
      if (Object.keys(fillPatch).length > 0) {
        // `fillPatch`'s module-side type (`@/modules/contacts`'s `ContactFieldPatch`) types
        // every comparable field uniformly as `string | number` (it is built generically
        // over `COMPARABLE_CONTACT_FIELDS`, persistence-free by design); this cast recovers
        // the precise per-field type `ContactFieldsPatch` needs, safe because each field's
        // runtime value is the same trimmed extraction value either way.
        const patch: ContactFieldsPatch = { ...(fillPatch as Partial<ComparableFieldsSnapshot>), verifiedAt: null };
        if ("vatId" in fillPatch) patch.vatIdNormalized = fillPatch.vatId ? normalizeVatId(String(fillPatch.vatId)) : null;
        if ("iban" in fillPatch) patch.ibanNormalized = fillPatch.iban ? normalizeIban(String(fillPatch.iban)) : null;
        await repos.contact.updateFields(workspaceId, contactId, patch);
      }
      for (const proposal of proposals) {
        await repos.contactProposal.create({
          workspaceId,
          contactId,
          documentId,
          field: proposal.field,
          currentValue: proposal.currentValue,
          proposedValue: proposal.proposedValue,
        });
        proposalsCreated++;
      }
    } else {
      const fields = mapComparableFieldsForReplace(extracted);
      const createInput: CreateContactRow = {
        workspaceId,
        name,
        ...fields,
        country: normalizedCountry(extracted.country),
        source: "auto",
        verifiedAt: null,
        firstSeenDocumentId: documentId,
        nameNormalized: normalized.nameNormalized,
        vatIdNormalized: normalized.vatIdNormalized,
        ibanNormalized: normalized.ibanNormalized,
      };
      const row = await repos.contact.create(createInput);
      contactId = row.id;
      created = true;
    }

    return { contactId, created, matchStrength, proposalsCreated };
  }

  /** The transaction body `upsertFromExtraction` runs, extracted into its own function so it
   * can be retried once after a unique-constraint race (see this file's header comment). */
  async function attemptUpsertFromExtraction(
    repos: Repositories,
    name: string,
    extracted: ExtractedContactData,
    documentId: string,
    workspaceId: string,
    role: DocumentContactRole,
  ): Promise<UpsertFromExtractionResult> {
    const result = await upsertContactOnly(repos, name, extracted, documentId, workspaceId);
    await repos.documentContact.link({ documentId, contactId: result.contactId, role });
    return result;
  }

  /** `sender`/`recipient` outrank `on_behalf_of`, which outranks `mentioned`
   * (H-contract.md section 3's "one role per contact per document" rule). `sender` and
   * `recipient` are deliberately equal-ranked: the observed defect was exactly a contact
   * ending up with BOTH in the same run (a genuine extraction contradiction), and the tie is
   * broken by keeping whichever the extraction listed first, not by preferring one role over
   * the other. */
  const ROLE_PRIORITY: Record<DocumentContactRole, number> = { sender: 3, recipient: 3, on_behalf_of: 2, mentioned: 1 };

  /** Drops `iban` when it is one of `normalizedOwnIbans`, and `vatId` when it equals
   * `normalizedOwnVatId` (both already normalized) - the rest of the party is kept. Called
   * BEFORE `isOwnCompany`/`isLikelyBank` ever see the party (see `attemptReplaceDocumentLinks`
   * and decisions/0035's "our identifiers are stripped before identity checks" section): the
   * model's attribution of an identifier to a party is exactly the unreliable kind of signal
   * this whole feature moves away from (on an outgoing invoice the only IBAN printed is OURS,
   * as payee, and the model may hang it on the customer party instead), so our own
   * identifiers must never be allowed to decide whether a party IS us or IS a bank, and must
   * never land on a contact either way. */
  function stripOwnIdentifiers(
    extracted: ExtractedContactData,
    normalizedOwnIbans: ReadonlySet<string>,
    normalizedOwnVatId: string | null,
  ): ExtractedContactData {
    const trimmedIban = extracted.iban?.trim();
    const ownIban = trimmedIban ? normalizedOwnIbans.has(normalizeIban(trimmedIban)) : false;
    const trimmedVatId = extracted.vatId?.trim();
    const ownVatId = normalizedOwnVatId !== null && trimmedVatId ? normalizeVatId(trimmedVatId) === normalizedOwnVatId : false;
    if (!ownIban && !ownVatId) return extracted;
    return { ...extracted, ...(ownIban ? { iban: null } : {}), ...(ownVatId ? { vatId: null } : {}) };
  }

  /** The transaction body `replaceDocumentLinks` runs. Deliberately not retried on a
   * unique-constraint race the way `attemptUpsertFromExtraction` is: this already runs as
   * one all-or-nothing transaction removing and rewriting every link, so a race here aborts
   * the whole reprocessing attempt rather than partially rewriting it - the caller (the job
   * queue) simply retries the whole document. */
  async function attemptReplaceDocumentLinks(
    repos: Repositories,
    input: ReplaceDocumentLinksInput,
  ): Promise<ReplaceDocumentLinksResult> {
    const { workspaceId, documentId, ownCompany, ownIbans, parties } = input;
    const normalizedOwnIbans = new Set(ownIbans.map((iban) => normalizeIban(iban)));
    const normalizedOwnVatId = ownCompany?.vatId?.trim() ? normalizeVatId(ownCompany.vatId) : null;

    // Sanitize every party BEFORE any identity check runs - `isOwnCompany`/`isLikelyBank`
    // below, and the matching/creation logic afterward, only ever see the sanitized copy.
    const sanitizedParties = parties.map((party) => ({
      role: party.role,
      relationType: party.relationType,
      extracted: stripOwnIdentifiers(party.extracted, normalizedOwnIbans, normalizedOwnVatId),
    }));
    const allSanitizedExtracted = sanitizedParties.map((p) => p.extracted);

    await repos.documentContact.unlinkAllForDocument(workspaceId, documentId);

    let created = 0;
    let proposalsCreated = 0;
    let skippedOwnCompany = 0;
    let skippedBank = 0;
    const resolved: Array<{ contactId: string; role: DocumentContactRole; relationType: ContactRelationType | null }> = [];

    for (const party of sanitizedParties) {
      const { extracted, role, relationType } = party;
      const name = extracted.name?.trim();
      if (!name) continue; // defensive only: the pipeline never hands us an unnamed party.

      if (ownCompany && isOwnCompany(extracted, ownCompany)) {
        skippedOwnCompany++;
        continue;
      }
      if (isLikelyBank(extracted, allSanitizedExtracted)) {
        skippedBank++;
        continue;
      }

      const outcome = await upsertContactOnly(repos, name, extracted, documentId, workspaceId);
      if (outcome.created) created++;
      proposalsCreated += outcome.proposalsCreated;
      resolved.push({ contactId: outcome.contactId, role, relationType });
    }

    // One role per contact per document: keep the strongest role a resolved party carries
    // for the same contact, first-seen wins a tie at the same priority tier.
    const winners = new Map<string, { contactId: string; role: DocumentContactRole; relationType: ContactRelationType | null }>();
    for (const link of resolved) {
      const current = winners.get(link.contactId);
      if (!current || ROLE_PRIORITY[link.role] > ROLE_PRIORITY[current.role]) winners.set(link.contactId, link);
    }

    for (const winner of winners.values()) {
      await repos.documentContact.link({ documentId, contactId: winner.contactId, role: winner.role });
      // `relationType` is written only on create or when the existing value is still null -
      // never overwrites a value a human (or an earlier, already-decided run) has set.
      if (winner.relationType) {
        const contactRow = await repos.contact.findById(workspaceId, winner.contactId);
        if (contactRow && contactRow.relationType === null) {
          await repos.contact.updateFields(workspaceId, winner.contactId, { relationType: winner.relationType });
        }
      }
    }

    return { linked: winners.size, created, proposalsCreated, skippedOwnCompany, skippedBank };
  }

  return {
    async listForWorkspace(workspaceId, filter) {
      const result = await deps.repos.contact.list(workspaceId, filter);
      return { items: result.items.map(toContact), hasMore: result.hasMore };
    },

    async getById(workspaceId, id) {
      const row = await requireContact(deps.repos, workspaceId, id);
      const [links, proposals] = await Promise.all([
        deps.repos.documentContact.listForContact(workspaceId, id),
        deps.repos.contactProposal.listForContact(workspaceId, id),
      ]);
      return {
        ...toContact(row),
        documents: links.map((l) => ({
          documentId: l.documentId,
          role: l.role as DocumentContactRole,
          originalFileName: l.originalFileName,
          documentCreatedAt: l.documentCreatedAt,
        })),
        pendingProposals: proposals.filter((p) => p.status === "pending").map(toProposal),
      };
    },

    async createManual({ workspaceId, actingUserId, name, ...fields }) {
      const trimmedName = name.trim();
      if (!trimmedName) throw new UseCaseError(CONTACT_ERROR.invalidInput);

      const mapped = mapComparableFieldsForReplace(fields);
      const verifiedAt = now();
      const row = await deps.repos.contact.create({
        workspaceId,
        name: trimmedName,
        ...mapped,
        country: normalizedCountry(fields.country),
        relationType: fields.relationType ?? null,
        source: "manual",
        verifiedAt,
        verifiedByUserId: actingUserId,
        nameNormalized: normalizeName(trimmedName),
        vatIdNormalized: mapped.vatId ? normalizeVatId(String(mapped.vatId)) : null,
        ibanNormalized: mapped.iban ? normalizeIban(String(mapped.iban)) : null,
      });
      return toContact(row);
    },

    async updateManual({ workspaceId, actingUserId, contactId, name, ...fields }) {
      const trimmedName = name.trim();
      if (!trimmedName) throw new UseCaseError(CONTACT_ERROR.invalidInput);

      const mapped = mapComparableFieldsForReplace(fields);
      const patch: ContactFieldsPatch = {
        name: trimmedName,
        ...mapped,
        country: normalizedCountry(fields.country),
        relationType: fields.relationType ?? null,
        verifiedAt: now(),
        verifiedByUserId: actingUserId,
        nameNormalized: normalizeName(trimmedName),
        vatIdNormalized: mapped.vatId ? normalizeVatId(String(mapped.vatId)) : null,
        ibanNormalized: mapped.iban ? normalizeIban(String(mapped.iban)) : null,
      };
      const row = await deps.repos.contact.updateFields(workspaceId, contactId, patch);
      if (!row) throw new UseCaseError(CONTACT_ERROR.notFound);
      return toContact(row);
    },

    async deleteContact({ workspaceId, contactId }) {
      const row = await deps.repos.contact.deleteById(workspaceId, contactId);
      if (!row) throw new UseCaseError(CONTACT_ERROR.notFound);
    },

    async linkDocument({ workspaceId, documentId, contactId, role }) {
      const [document, contact] = await Promise.all([
        deps.repos.document.findById(workspaceId, documentId),
        deps.repos.contact.findById(workspaceId, contactId),
      ]);
      if (!document) throw new UseCaseError(CONTACT_ERROR.documentNotFound);
      if (!contact) throw new UseCaseError(CONTACT_ERROR.notFound);
      await deps.repos.documentContact.link({ documentId, contactId, role });
    },

    async unlinkDocument({ workspaceId, documentId, contactId, role }) {
      const [document, contact] = await Promise.all([
        deps.repos.document.findById(workspaceId, documentId),
        deps.repos.contact.findById(workspaceId, contactId),
      ]);
      if (!document) throw new UseCaseError(CONTACT_ERROR.documentNotFound);
      if (!contact) throw new UseCaseError(CONTACT_ERROR.notFound);
      await deps.repos.documentContact.unlink(documentId, contactId, role);
    },

    async mergeContacts({ workspaceId, sourceId, targetId }) {
      if (sourceId === targetId) throw new UseCaseError(CONTACT_ERROR.cannotMergeSelf);

      return deps.uow.transaction(async (repos) => {
        const source = await requireContact(repos, workspaceId, sourceId);
        const target = await requireContact(repos, workspaceId, targetId);

        const fillPatch: ContactFieldsPatch = {};
        for (const field of COMPARABLE_CONTACT_FIELDS) {
          const targetValue = target[field];
          const sourceValue = source[field];
          const targetIsBlank = targetValue === null || (typeof targetValue === "string" && targetValue.trim() === "");
          const sourceHasValue = sourceValue !== null && !(typeof sourceValue === "string" && sourceValue.trim() === "");
          if (targetIsBlank && sourceHasValue) {
            (fillPatch as Record<string, unknown>)[field] = sourceValue;
          }
        }
        if ("vatId" in fillPatch) fillPatch.vatIdNormalized = fillPatch.vatId ? normalizeVatId(String(fillPatch.vatId)) : null;
        if ("iban" in fillPatch) fillPatch.ibanNormalized = fillPatch.iban ? normalizeIban(String(fillPatch.iban)) : null;

        const merged =
          Object.keys(fillPatch).length > 0 ? await repos.contact.updateFields(workspaceId, targetId, fillPatch) : target;
        if (!merged) throw new UseCaseError(CONTACT_ERROR.notFound);

        await repos.documentContact.moveContactLinks(sourceId, targetId);
        await repos.contactProposal.moveContactProposals(sourceId, targetId);
        await repos.contact.deleteById(workspaceId, sourceId);

        return toContact(merged);
      });
    },

    async listProposals(workspaceId, filter) {
      const rows = await deps.repos.contactProposal.listForWorkspace(workspaceId, filter);
      return rows.map(toProposal);
    },

    async acceptProposal({ workspaceId, proposalId, decidedByUserId }) {
      await deps.uow.transaction(async (repos) => {
        const decided = await repos.contactProposal.decide(workspaceId, proposalId, {
          status: "accepted",
          decidedByUserId,
          decidedAt: now(),
        });
        if (!decided) throw new UseCaseError(CONTACT_ERROR.proposalNotFound);

        const field = decided.field as ComparableContactField;
        const patch: ContactFieldsPatch = { verifiedAt: now(), verifiedByUserId: decidedByUserId };
        if (field === "paymentTermsDays") {
          patch.paymentTermsDays = decided.proposedValue === null ? null : Number(decided.proposedValue);
        } else {
          (patch as Record<string, unknown>)[field] = decided.proposedValue;
        }
        if (field === "vatId") patch.vatIdNormalized = decided.proposedValue ? normalizeVatId(decided.proposedValue) : null;
        if (field === "iban") patch.ibanNormalized = decided.proposedValue ? normalizeIban(decided.proposedValue) : null;

        const updated = await repos.contact.updateFields(workspaceId, decided.contactId, patch);
        if (!updated) throw new UseCaseError(CONTACT_ERROR.notFound);
      });
    },

    async rejectProposal({ workspaceId, proposalId, decidedByUserId }) {
      const decided = await deps.repos.contactProposal.decide(workspaceId, proposalId, {
        status: "rejected",
        decidedByUserId,
        decidedAt: now(),
      });
      if (!decided) throw new UseCaseError(CONTACT_ERROR.proposalNotFound);
    },

    async upsertFromExtraction({ workspaceId, documentId, role, extracted }) {
      const name = extracted.name?.trim();
      if (!name) throw new UseCaseError(CONTACT_ERROR.invalidInput);

      const run = () => deps.uow.transaction((repos) => attemptUpsertFromExtraction(repos, name, extracted, documentId, workspaceId, role));

      try {
        return await run();
      } catch (err) {
        if (isDbError(err, "unique")) {
          // Concurrent race on the partial unique index over (workspace_id,
          // vat_id_normalized) - see this file's header comment. Retry exactly once; the
          // winner's row is now committed and visible, so this attempt matches it instead of
          // trying to insert a second duplicate.
          return run();
        }
        throw err;
      }
    },

    async replaceDocumentLinks(input) {
      return deps.uow.transaction(async (repos) => {
        const document = await repos.document.findById(input.workspaceId, input.documentId);
        if (!document) throw new UseCaseError(CONTACT_ERROR.documentNotFound);
        return attemptReplaceDocumentLinks(repos, input);
      });
    },
  };
}
