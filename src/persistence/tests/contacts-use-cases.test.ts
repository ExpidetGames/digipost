// Unit tests for `createContactUseCases` (WEBAPP_TEMPLATE_SPEC.md §10.2): typed fakes, no DB,
// no network. `src/persistence/tests/contacts-repository.db.test.ts` and
// `contacts-use-cases-concurrency.db.test.ts` (both `pnpm test:docker` only) prove the
// database-level guarantees a fake cannot (the partial unique index, real concurrency).
import { describe, expect, it } from "vitest";

import type { OwnCompanyProfile } from "@/modules/contacts";
import { CONTACT_ERROR, createContactUseCases, type ReplaceDocumentLinksParty } from "@/persistence/use-cases/contacts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { documentRow, createFakeDocumentRepository } from "@/persistence/tests/support/fake-documents-repositories";
import {
  contactRow,
  createFakeContactProposalRepository,
  createFakeContactRepository,
  createFakeDocumentContactRepository,
} from "@/persistence/tests/support/fake-contacts-repositories";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const DOCUMENT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

function buildUseCases(options: {
  contacts?: ReturnType<typeof contactRow>[];
  documents?: ReturnType<typeof documentRow>[];
  now?: () => Date;
}) {
  const contactRepo = createFakeContactRepository(options.contacts ?? []);
  const documentContactRepo = createFakeDocumentContactRepository();
  const proposalRepo = createFakeContactProposalRepository();
  const documentRepo = createFakeDocumentRepository(options.documents ?? [{ ...documentRow({ workspaceId: WORKSPACE_ID, storageKey: "k" }), id: DOCUMENT_ID }]);

  const repos: Repositories = withUnusedRepositories({
    contact: contactRepo.repo,
    documentContact: documentContactRepo.repo,
    contactProposal: proposalRepo.repo,
    document: documentRepo.repo,
  });

  const uow: UnitOfWork = { transaction: (work) => work(repos) };

  const useCases = createContactUseCases({ repos, uow, now: options.now });
  return { useCases, contactState: contactRepo.state, linkState: documentContactRepo.state, proposalState: proposalRepo.state };
}

describe("upsertFromExtraction", () => {
  it("creates a new contact when nothing matches, and links the document", async () => {
    const { useCases, contactState, linkState } = buildUseCases({});

    const result = await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "Musterwerk GmbH", city: "Berlin" },
    });

    expect(result.created).toBe(true);
    expect(result.matchStrength).toBeNull();
    expect(result.proposalsCreated).toBe(0);
    expect(contactState).toHaveLength(1);
    expect(contactState[0]).toMatchObject({ name: "Musterwerk GmbH", city: "Berlin", source: "auto", verifiedAt: null, nameNormalized: "musterwerk" });
    expect(linkState).toEqual([{ documentId: DOCUMENT_ID, contactId: contactState[0].id, role: "sender", createdAt: expect.any(Date) }]);
  });

  it("fills an empty field on an UNVERIFIED matched contact directly, no proposal", async () => {
    const existing = contactRow({
      workspaceId: WORKSPACE_ID,
      name: "Musterwerk GmbH",
      nameNormalized: "musterwerk",
      source: "auto",
      verifiedAt: null,
      vatIdNormalized: "DE123456789",
      vatId: "DE123456789",
      iban: null,
    });
    const { useCases, contactState } = buildUseCases({ contacts: [existing] });

    const result = await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "Musterwerk GmbH", vatId: "DE123456789", iban: "DE89370400440532013000" },
    });

    expect(result.created).toBe(false);
    expect(result.matchStrength).toBe("strong");
    expect(result.proposalsCreated).toBe(0);
    expect(contactState[0].iban).toBe("DE89370400440532013000");
    expect(contactState[0].ibanNormalized).toBe("DE89370400440532013000");
  });

  it("fills an empty field on an already-VERIFIED matched contact too (the fill-empty rule is the same either way)", async () => {
    const existing = contactRow({
      workspaceId: WORKSPACE_ID,
      name: "Musterwerk GmbH",
      nameNormalized: "musterwerk",
      source: "manual",
      verifiedAt: new Date("2026-01-01"),
      verifiedByUserId: USER_ID,
      vatIdNormalized: "DE123456789",
      vatId: "DE123456789",
      phone: null,
    });
    const { useCases, contactState } = buildUseCases({ contacts: [existing] });

    await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "Musterwerk GmbH", vatId: "DE123456789", phone: "+49 30 1234567" },
    });

    expect(contactState[0].phone).toBe("+49 30 1234567");
  });

  it("resets verified_at to null when the pipeline fills any field, even on a previously verified contact", async () => {
    const existing = contactRow({
      workspaceId: WORKSPACE_ID,
      name: "Musterwerk GmbH",
      nameNormalized: "musterwerk",
      source: "manual",
      verifiedAt: new Date("2026-01-01"),
      verifiedByUserId: USER_ID,
      vatIdNormalized: "DE123456789",
      vatId: "DE123456789",
      phone: null,
    });
    const { useCases, contactState } = buildUseCases({ contacts: [existing] });

    await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "Musterwerk GmbH", vatId: "DE123456789", phone: "+49 30 1234567" },
    });

    expect(contactState[0].verifiedAt).toBeNull();
  });

  it("never overwrites a non-empty, contradicting field on a matched contact - creates a proposal instead", async () => {
    const existing = contactRow({
      workspaceId: WORKSPACE_ID,
      name: "Musterwerk GmbH",
      nameNormalized: "musterwerk",
      source: "manual",
      verifiedAt: new Date("2026-01-01"),
      verifiedByUserId: USER_ID,
      vatIdNormalized: "DE123456789",
      vatId: "DE123456789",
      iban: "DE00111122223333444455",
      ibanNormalized: "DE00111122223333444455",
    });
    const { useCases, contactState, proposalState } = buildUseCases({ contacts: [existing] });

    const result = await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "Musterwerk GmbH", vatId: "DE123456789", iban: "DE99888877776666555544" },
    });

    expect(result.proposalsCreated).toBe(1);
    // The contact's own iban is untouched (no silent overwrite).
    expect(contactState[0].iban).toBe("DE00111122223333444455");
    expect(proposalState).toHaveLength(1);
    expect(proposalState[0]).toMatchObject({
      field: "iban",
      currentValue: "DE00111122223333444455",
      proposedValue: "DE99888877776666555544",
      status: "pending",
    });
  });

  it("creates no proposal and makes no change when the extracted value equals the current one after normalization", async () => {
    const existing = contactRow({
      workspaceId: WORKSPACE_ID,
      name: "Musterwerk GmbH",
      nameNormalized: "musterwerk",
      source: "manual",
      verifiedAt: new Date("2026-01-01"),
      verifiedByUserId: USER_ID,
      vatIdNormalized: "DE123456789",
      vatId: "DE 123 456 789",
    });
    const { useCases, contactState, proposalState } = buildUseCases({ contacts: [existing] });

    const result = await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "Musterwerk GmbH", vatId: "DE123456789" },
    });

    expect(result.proposalsCreated).toBe(0);
    expect(proposalState).toEqual([]);
    // verified_at is untouched: nothing actually changed, so this was not a pipeline "write".
    expect(contactState[0].verifiedAt).toEqual(new Date("2026-01-01"));
  });

  it("rejects an extraction with no name", async () => {
    const { useCases } = buildUseCases({});
    await expect(
      useCases.upsertFromExtraction({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, role: "sender", extracted: { name: "   " } }),
    ).rejects.toThrow(new UseCaseError(CONTACT_ERROR.invalidInput));
  });
});

describe("createManual / updateManual", () => {
  it("createManual counts as verification", async () => {
    const now = new Date("2026-02-01T10:00:00Z");
    const { useCases } = buildUseCases({ now: () => now });

    const contact = await useCases.createManual({ workspaceId: WORKSPACE_ID, actingUserId: USER_ID, name: "Handwerk AG" });

    expect(contact.source).toBe("manual");
    expect(contact.verifiedAt).toEqual(now);
    expect(contact.verifiedByUserId).toBe(USER_ID);
  });

  it("updateManual replaces the whole editable field set (a cleared field becomes null)", async () => {
    const existing = contactRow({ workspaceId: WORKSPACE_ID, name: "Handwerk AG", nameNormalized: "handwerk", source: "manual", phone: "+49 30 000" });
    const { useCases, contactState } = buildUseCases({ contacts: [existing] });

    const updated = await useCases.updateManual({ workspaceId: WORKSPACE_ID, actingUserId: USER_ID, contactId: existing.id, name: "Handwerk AG" });

    expect(updated.phone).toBeNull();
    expect(contactState[0].verifiedByUserId).toBe(USER_ID);
  });
});

describe("linkDocument / unlinkDocument", () => {
  it("rejects a document that does not belong to the workspace", async () => {
    const contact = contactRow({ workspaceId: WORKSPACE_ID, name: "A", nameNormalized: "a", source: "manual" });
    const { useCases } = buildUseCases({ contacts: [contact], documents: [] });

    await expect(
      useCases.linkDocument({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, contactId: contact.id, role: "sender" }),
    ).rejects.toThrow(new UseCaseError(CONTACT_ERROR.documentNotFound));
  });

  it("links and unlinks a valid document/contact pair", async () => {
    const contact = contactRow({ workspaceId: WORKSPACE_ID, name: "A", nameNormalized: "a", source: "manual" });
    const { useCases, linkState } = buildUseCases({ contacts: [contact] });

    await useCases.linkDocument({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, contactId: contact.id, role: "recipient" });
    expect(linkState).toHaveLength(1);

    await useCases.unlinkDocument({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, contactId: contact.id, role: "recipient" });
    expect(linkState).toHaveLength(0);
  });
});

describe("mergeContacts", () => {
  it("fills the target's empty fields from the source, moves links/proposals, and deletes the source", async () => {
    const source = contactRow({ workspaceId: WORKSPACE_ID, name: "Source GmbH", nameNormalized: "source", source: "auto", phone: "+49 1", iban: "DE00111122223333444455", ibanNormalized: "DE00111122223333444455" });
    const target = contactRow({ workspaceId: WORKSPACE_ID, name: "Target GmbH", nameNormalized: "target", source: "manual", phone: null });
    const { useCases, contactState, linkState, proposalState } = buildUseCases({ contacts: [source, target] });

    await useCases.linkDocument({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, contactId: source.id, role: "sender" });

    const merged = await useCases.mergeContacts({ workspaceId: WORKSPACE_ID, sourceId: source.id, targetId: target.id });

    expect(merged.phone).toBe("+49 1");
    expect(merged.iban).toBe("DE00111122223333444455");
    expect(contactState.find((c) => c.id === source.id)).toBeUndefined();
    expect(linkState).toEqual([{ documentId: DOCUMENT_ID, contactId: target.id, role: "sender", createdAt: expect.any(Date) }]);
    expect(proposalState).toEqual([]);
  });

  it("never overwrites a non-empty target field with the source's value", async () => {
    const source = contactRow({ workspaceId: WORKSPACE_ID, name: "Source GmbH", nameNormalized: "source", source: "auto", phone: "+49 1" });
    const target = contactRow({ workspaceId: WORKSPACE_ID, name: "Target GmbH", nameNormalized: "target", source: "manual", phone: "+49 2" });
    const { useCases } = buildUseCases({ contacts: [source, target] });

    const merged = await useCases.mergeContacts({ workspaceId: WORKSPACE_ID, sourceId: source.id, targetId: target.id });

    expect(merged.phone).toBe("+49 2");
  });

  it("rejects merging a contact into itself", async () => {
    const contact = contactRow({ workspaceId: WORKSPACE_ID, name: "A", nameNormalized: "a", source: "manual" });
    const { useCases } = buildUseCases({ contacts: [contact] });

    await expect(useCases.mergeContacts({ workspaceId: WORKSPACE_ID, sourceId: contact.id, targetId: contact.id })).rejects.toThrow(
      new UseCaseError(CONTACT_ERROR.cannotMergeSelf),
    );
  });
});

describe("proposals", () => {
  it("acceptProposal applies the proposed value and re-verifies the contact", async () => {
    const contact = contactRow({
      workspaceId: WORKSPACE_ID,
      name: "A",
      nameNormalized: "a",
      postalCode: "12345",
      source: "auto",
      verifiedAt: null,
      iban: "DE00111122223333444455",
      ibanNormalized: "DE00111122223333444455",
    });
    const { useCases, contactState, proposalState } = buildUseCases({ contacts: [contact] });
    // Matches via rule 5 (name + postal code, both exact) - the contradicting iban is a
    // field the matching rules never look at, so this proves the diff runs independently of
    // which rule found the match.
    await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "A", postalCode: "12345", iban: "DE99888877776666555544" },
    });
    expect(proposalState).toHaveLength(1);

    await useCases.acceptProposal({ workspaceId: WORKSPACE_ID, proposalId: proposalState[0].id, decidedByUserId: USER_ID });

    expect(contactState[0].iban).toBe("DE99888877776666555544");
    expect(contactState[0].ibanNormalized).toBe("DE99888877776666555544");
    expect(contactState[0].verifiedAt).not.toBeNull();
    expect(contactState[0].verifiedByUserId).toBe(USER_ID);
    expect(proposalState[0].status).toBe("accepted");
  });

  it("rejectProposal never changes the contact", async () => {
    const contact = contactRow({
      workspaceId: WORKSPACE_ID,
      name: "A",
      nameNormalized: "a",
      postalCode: "12345",
      source: "auto",
      iban: "DE00111122223333444455",
      ibanNormalized: "DE00111122223333444455",
    });
    const { useCases, contactState, proposalState } = buildUseCases({ contacts: [contact] });
    await useCases.upsertFromExtraction({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      role: "sender",
      extracted: { name: "A", postalCode: "12345", iban: "DE99888877776666555544" },
    });

    await useCases.rejectProposal({ workspaceId: WORKSPACE_ID, proposalId: proposalState[0].id, decidedByUserId: USER_ID });

    expect(contactState[0].iban).toBe("DE00111122223333444455");
    expect(proposalState[0].status).toBe("rejected");
  });

  it("rejects deciding an already-decided proposal again", async () => {
    const contact = contactRow({ workspaceId: WORKSPACE_ID, name: "A", nameNormalized: "a", source: "auto" });
    const { useCases, proposalState } = buildUseCases({ contacts: [contact] });
    proposalState.push({
      id: "44444444-4444-4444-4444-444444444444",
      workspaceId: WORKSPACE_ID,
      contactId: contact.id,
      documentId: DOCUMENT_ID,
      field: "phone",
      currentValue: "1",
      proposedValue: "2",
      status: "pending",
      createdAt: new Date(0),
      decidedAt: null,
      decidedByUserId: null,
    });

    await useCases.rejectProposal({ workspaceId: WORKSPACE_ID, proposalId: proposalState[0].id, decidedByUserId: USER_ID });
    await expect(useCases.acceptProposal({ workspaceId: WORKSPACE_ID, proposalId: proposalState[0].id, decidedByUserId: USER_ID })).rejects.toThrow(
      new UseCaseError(CONTACT_ERROR.proposalNotFound),
    );
  });
});

describe("getById", () => {
  it("returns the contact with its linked documents and only pending proposals", async () => {
    const contact = contactRow({ workspaceId: WORKSPACE_ID, name: "A", nameNormalized: "a", source: "auto" });
    const { useCases } = buildUseCases({ contacts: [contact] });
    await useCases.linkDocument({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, contactId: contact.id, role: "sender" });

    const detail = await useCases.getById(WORKSPACE_ID, contact.id);

    expect(detail.documents).toHaveLength(1);
    expect(detail.documents[0]).toMatchObject({ documentId: DOCUMENT_ID, role: "sender" });
    expect(detail.pendingProposals).toEqual([]);
  });

  it("throws not_found for a contact outside the workspace", async () => {
    const { useCases } = buildUseCases({});
    await expect(useCases.getById(WORKSPACE_ID, "does-not-exist")).rejects.toThrow(new UseCaseError(CONTACT_ERROR.notFound));
  });
});

describe("replaceDocumentLinks", () => {
  // `postalCode` is set (not `null`) so tests below can trigger `isOwnCompany`'s
  // postal-code + name-similarity rule - the only own-company signal `stripOwnIdentifiers`
  // (contacts-use-cases.ts) does NOT neutralize. Its VAT-id rule is deliberately unreachable
  // from inside `replaceDocumentLinks`: a party's VAT id is stripped whenever it equals
  // `OWN_COMPANY.vatId` BEFORE `isOwnCompany` ever runs (the coordinator's fix 2 - a
  // misattributed VAT id must never decide whether a party is us, any more than a
  // misattributed IBAN should), so only name/alias/domain/postal-code signals can ever mark a
  // party "own" here.
  const OWN_COMPANY: OwnCompanyProfile = {
    name: "Musterfirma",
    postalCode: "10999",
    vatId: "DE999999999",
    aliases: [],
    ibans: [],
    domains: [],
    taxNumber: null,
    registerCourt: null,
    registerNumber: null,
  };
  const OWN_IBANS = ["DE43100000000987654321"];

  // A real customer party always carries at least one field that makes it a business
  // relationship (here: a VAT id) - `isLikelyBank`'s rule 2/3 are conservative specifically
  // so a party that also happens to mention a bank's IBAN/BIC/name (as remittance details,
  // not its own identity) is never mistaken for the bank itself.
  function customerParty(overrides: Partial<ReplaceDocumentLinksParty["extracted"]> = {}, role: ReplaceDocumentLinksParty["role"] = "recipient"): ReplaceDocumentLinksParty {
    return { role, relationType: "customer", extracted: { name: "Beispielkunde Nord eGbR", vatId: "DE111111111", ...overrides } };
  }

  it("a second call replaces the first call's links entirely", async () => {
    const { useCases, linkState } = buildUseCases({});

    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: null,
      ownIbans: [],
      parties: [{ role: "sender", relationType: "supplier", extracted: { name: "Erster Lieferant GmbH" } }],
    });
    expect(linkState).toHaveLength(1);

    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: null,
      ownIbans: [],
      parties: [{ role: "sender", relationType: "supplier", extracted: { name: "Zweiter Lieferant GmbH" } }],
    });

    expect(linkState).toHaveLength(1);
    const [link] = linkState;
    expect(link.role).toBe("sender");
    // The first run's contact is no longer linked to this document at all.
    const firstRunContactStillLinked = linkState.some((l) => l.documentId === DOCUMENT_ID && l.contactId !== link.contactId);
    expect(firstRunContactStillLinked).toBe(false);
  });

  it("the same contact given as sender and mentioned ends up with one row, sender", async () => {
    const { useCases, linkState, contactState } = buildUseCases({});

    const result = await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: null,
      ownIbans: [],
      parties: [
        { role: "mentioned", relationType: null, extracted: { name: "Doppelt Genannt GmbH" } },
        { role: "sender", relationType: "supplier", extracted: { name: "Doppelt Genannt GmbH" } },
      ],
    });

    // Both parties resolve to the same (newly created) contact via the exact-name match.
    expect(contactState).toHaveLength(1);
    expect(result.linked).toBe(1);
    expect(linkState).toEqual([{ documentId: DOCUMENT_ID, contactId: contactState[0].id, role: "sender", createdAt: expect.any(Date) }]);
  });

  it("an own-company party is skipped and counted, never linked", async () => {
    const { useCases, linkState, contactState } = buildUseCases({});

    const result = await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: OWN_COMPANY,
      ownIbans: [],
      parties: [{ role: "recipient", relationType: "customer", extracted: { name: "Musterfirma", postalCode: OWN_COMPANY.postalCode } }],
    });

    expect(result.skippedOwnCompany).toBe(1);
    expect(result.linked).toBe(0);
    expect(contactState).toHaveLength(0);
    expect(linkState).toHaveLength(0);
  });

  it("a bank party is skipped and counted, never linked", async () => {
    const { useCases, linkState, contactState } = buildUseCases({});

    const result = await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: null,
      ownIbans: [],
      parties: [
        customerParty({ bankName: "MUSTERBANK PAYMENTS", iban: "DE43100000000987654321" }, "sender"),
        { role: "mentioned", relationType: null, extracted: { name: "MUSTERBANK PAYMENTS" } },
      ],
    });

    expect(result.skippedBank).toBe(1);
    expect(result.linked).toBe(1);
    expect(contactState).toHaveLength(1);
    expect(contactState[0].name).toBe("Beispielkunde Nord eGbR");
    expect(linkState.map((l) => l.role)).toEqual(["sender"]);
  });

  it("strips an own IBAN from a party that is kept, without dropping the rest of its fields", async () => {
    const { useCases, contactState } = buildUseCases({});

    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: null,
      ownIbans: OWN_IBANS,
      parties: [customerParty({ iban: "DE43100000000987654321", city: "Berlin" }, "recipient")],
    });

    expect(contactState).toHaveLength(1);
    expect(contactState[0].iban).toBeNull();
    expect(contactState[0].city).toBe("Berlin");
  });

  it("strips a misattributed own VAT id from a party that is kept, without dropping the rest of its fields", async () => {
    const { useCases, contactState } = buildUseCases({});

    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: OWN_COMPANY,
      ownIbans: [],
      parties: [customerParty({ vatId: OWN_COMPANY.vatId, city: "Berlin" }, "recipient")],
    });

    expect(contactState).toHaveLength(1);
    expect(contactState[0].vatId).toBeNull();
    expect(contactState[0].city).toBe("Berlin");
  });

  it(
    "a customer carrying our own IBAN is linked as a real contact with the IBAN stripped, never silently skipped as our own " +
      "company (the coordinator's fix 2: our own identifiers must never decide whether a party is us)",
    async () => {
      const { useCases, contactState, linkState } = buildUseCases({});

      const result = await useCases.replaceDocumentLinks({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ownCompany: OWN_COMPANY,
        ownIbans: OWN_IBANS,
        // The customer's name/postal code share nothing with OWN_COMPANY - only the
        // (misattributed) IBAN could ever make `isOwnCompany` fire here, and only if that
        // check ran on the RAW party. Sanitization strips the IBAN first, so `isOwnCompany`
        // never even sees it - this is what protects against H1's own planned "party IBAN is
        // one of ours -> own company" rule once it lands, without needing that rule to exist
        // yet on this branch to prove the protection works.
        parties: [customerParty({ iban: OWN_IBANS[0] }, "recipient")],
      });

      expect(result.skippedOwnCompany).toBe(0);
      expect(result.linked).toBe(1);
      expect(contactState).toHaveLength(1);
      expect(contactState[0].name).toBe("Beispielkunde Nord eGbR");
      expect(contactState[0].iban).toBeNull();
      expect(linkState).toEqual([{ documentId: DOCUMENT_ID, contactId: contactState[0].id, role: "recipient", createdAt: expect.any(Date) }]);
    },
  );

  it("a party that really IS us by name and postal code is still skipped, even though its (non-matching) financial identifiers are stripped first", async () => {
    const { useCases, contactState, linkState } = buildUseCases({});

    const result = await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: OWN_COMPANY,
      ownIbans: OWN_IBANS,
      // Carries a real customer's IBAN (not one of ours) and no VAT id at all - stripping has
      // nothing of ours to remove here, and `isOwnCompany`'s postal-code + name-similarity
      // rule still fires exactly as before, proving stripping does not neutralize a
      // legitimate own-company match through a non-financial signal.
      parties: [{ role: "recipient", relationType: null, extracted: { name: "Musterfirma", postalCode: OWN_COMPANY.postalCode, iban: "DE00111122223333444455" } }],
    });

    expect(result.skippedOwnCompany).toBe(1);
    expect(result.linked).toBe(0);
    expect(contactState).toHaveLength(0);
    expect(linkState).toHaveLength(0);
  });

  it("relationType is set on create, and not overwritten when a later run proposes a different one", async () => {
    const { useCases, contactState } = buildUseCases({});

    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: null,
      ownIbans: [],
      parties: [customerParty({}, "recipient")],
    });
    expect(contactState[0].relationType).toBe("customer");

    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: null,
      ownIbans: [],
      parties: [{ role: "sender", relationType: "supplier", extracted: { name: "Beispielkunde Nord eGbR" } }],
    });

    // Still "customer" - a second run's relationType never overwrites an already-set one.
    expect(contactState[0].relationType).toBe("customer");
  });

  it("throws document_not_found for a document outside the workspace", async () => {
    const { useCases } = buildUseCases({});
    await expect(
      useCases.replaceDocumentLinks({
        workspaceId: "99999999-9999-9999-9999-999999999999",
        documentId: DOCUMENT_ID,
        ownCompany: null,
        ownIbans: [],
        parties: [],
      }),
    ).rejects.toThrow(new UseCaseError(CONTACT_ERROR.documentNotFound));
  });

  it("reproduces the observed defect (outgoing invoice 38): three runs' parties in sequence leave exactly one link", async () => {
    const { useCases, linkState, contactState } = buildUseCases({});

    // Run 1 (08:54:14): Musterfirma as recipient, the customer as sender, MUSTERBANK as mentioned.
    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: OWN_COMPANY,
      ownIbans: OWN_IBANS,
      parties: [
        { role: "recipient", relationType: null, extracted: { name: "Musterfirma", postalCode: OWN_COMPANY.postalCode } },
        customerParty({ bankName: "MUSTERBANK PAYMENTS" }, "sender"),
        { role: "mentioned", relationType: null, extracted: { name: "MUSTERBANK PAYMENTS", iban: OWN_IBANS[0] } },
      ],
    });

    // Run 2 (08:54:25): MUSTERBANK extracted again, this time as recipient.
    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: OWN_COMPANY,
      ownIbans: OWN_IBANS,
      parties: [{ role: "recipient", relationType: null, extracted: { name: "MUSTERBANK PAYMENTS", iban: OWN_IBANS[0] } }],
    });

    // Run 3 (08:54:36): the customer extracted again, this time (contradictorily) as recipient.
    await useCases.replaceDocumentLinks({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ownCompany: OWN_COMPANY,
      ownIbans: OWN_IBANS,
      parties: [customerParty({}, "recipient")],
    });

    expect(linkState).toHaveLength(1);
    expect(linkState[0].role).toBe("recipient");
    const linkedContact = contactState.find((c) => c.id === linkState[0].contactId);
    expect(linkedContact?.name).toBe("Beispielkunde Nord eGbR");
    expect(contactState.some((c) => c.name === "Musterfirma")).toBe(false);
    expect(contactState.some((c) => c.name === "MUSTERBANK PAYMENTS")).toBe(false);
  });
});
