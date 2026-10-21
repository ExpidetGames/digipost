// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3, `pnpm test:docker` reference,
// `pnpm test:db` on the host against `docker/compose.yml`). decisions/0037-correction-buttons.md:
// "Das sind wir"/"Das ist unsere Bank" are two separate use-case calls
// (`WorkspaceUseCases.addCompanyAlias`/`addCompanyIban`, then `ContactUseCases.deleteContact`)
// orchestrated by `src/modules/contacts/actions.ts` - this proves, against real Postgres, the
// two things a fake cannot: the alias/IBAN actually lands NORMALIZED in the `workspaces` row
// (`normalizeCompanyAliases`/`normalizeIban` really ran through a real `UPDATE ... RETURNING`),
// and the contact row is really gone afterwards, scoped by workspace.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { contacts } from "@/persistence/schema/contacts";
import { createContactUseCases, CONTACT_ERROR } from "@/persistence/use-cases/contacts-use-cases";
import { createWorkspaceUseCases } from "@/persistence/use-cases/workspaces-use-cases";

const db = getDb();

async function createTestUser(label: string) {
  const [row] = await db
    .insert(user)
    .values({ name: `Test User ${label}`, email: `${label}-${randomUUID()}@example.test`, emailVerified: false })
    .returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return row;
}

function buildUseCases() {
  const repos = createDrizzleRepositories(db);
  const uow = createDrizzleUnitOfWork(db);
  return {
    workspaces: createWorkspaceUseCases({ repos, uow }),
    contacts: createContactUseCases({ repos, uow }),
  };
}

describe("company profile corrections (decisions/0037-correction-buttons.md)", () => {
  it("'Das sind wir': the alias lands normalized on the workspace row, and the contact is gone", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Muster GmbH" });
    const admin = await createTestUser("alias-admin");
    const { workspaces, contacts: contactUseCases } = buildUseCases();

    const contact = await contactUseCases.createManual({
      workspaceId: workspace.id,
      actingUserId: admin.id,
      name: "  Musterfirma  ",
    });

    await workspaces.addCompanyAlias({ workspaceId: workspace.id, alias: contact.name });
    await contactUseCases.deleteContact({ workspaceId: workspace.id, contactId: contact.id });

    const profile = await workspaces.getCompanyProfile(workspace.id);
    expect(profile?.aliases).toEqual(["Musterfirma"]);

    const [remaining] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(remaining).toBeUndefined();
  });

  it("is idempotent: correcting two duplicate contacts sharing the same name adds the alias only once", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Muster GmbH" });
    const admin = await createTestUser("alias-dup-admin");
    const { workspaces, contacts: contactUseCases } = buildUseCases();

    const first = await contactUseCases.createManual({ workspaceId: workspace.id, actingUserId: admin.id, name: "Musterfirma" });
    const second = await contactUseCases.createManual({ workspaceId: workspace.id, actingUserId: admin.id, name: "Musterfirma" });

    await workspaces.addCompanyAlias({ workspaceId: workspace.id, alias: first.name });
    await contactUseCases.deleteContact({ workspaceId: workspace.id, contactId: first.id });
    await workspaces.addCompanyAlias({ workspaceId: workspace.id, alias: second.name });
    await contactUseCases.deleteContact({ workspaceId: workspace.id, contactId: second.id });

    const profile = await workspaces.getCompanyProfile(workspace.id);
    expect(profile?.aliases).toEqual(["Musterfirma"]);
  });

  it("a too-generic alias is rejected and the contact is NOT deleted", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Muster GmbH" });
    const admin = await createTestUser("alias-generic-admin");
    const { workspaces, contacts: contactUseCases } = buildUseCases();

    const contact = await contactUseCases.createManual({ workspaceId: workspace.id, actingUserId: admin.id, name: "GbR" });

    await expect(workspaces.addCompanyAlias({ workspaceId: workspace.id, alias: contact.name })).rejects.toMatchObject({
      code: "alias_too_generic",
    });

    const [stillThere] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(stillThere).toBeDefined();
  });

  it("'Das ist unsere Bank': the IBAN lands normalized on the workspace row, and the contact is gone", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Muster GmbH" });
    const admin = await createTestUser("iban-admin");
    const { workspaces, contacts: contactUseCases } = buildUseCases();

    const contact = await contactUseCases.createManual({
      workspaceId: workspace.id,
      actingUserId: admin.id,
      name: "MUSTERBANK PAYMENTS",
      iban: "de89 3704 0044 0532 0130 00",
    });

    await workspaces.addCompanyIban({ workspaceId: workspace.id, iban: contact.iban! });
    await contactUseCases.deleteContact({ workspaceId: workspace.id, contactId: contact.id });

    const profile = await workspaces.getCompanyProfile(workspace.id);
    expect(profile?.ibans).toEqual(["DE89370400440532013000"]);

    const [remaining] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(remaining).toBeUndefined();
  });

  it("is workspace-scoped: a contact id from another workspace resolves to not_found, nothing changed", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspaceA = await workspaceRepo.create({ name: "Firma A" });
    const workspaceB = await workspaceRepo.create({ name: "Firma B" });
    const admin = await createTestUser("cross-workspace-admin");
    const { workspaces, contacts: contactUseCases } = buildUseCases();

    const contact = await contactUseCases.createManual({ workspaceId: workspaceA.id, actingUserId: admin.id, name: "Musterfirma" });

    await expect(contactUseCases.getById(workspaceB.id, contact.id)).rejects.toMatchObject({ code: CONTACT_ERROR.notFound });

    const profileB = await workspaces.getCompanyProfile(workspaceB.id);
    expect(profileB?.aliases).toEqual([]);
    const [stillThere] = await db.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(stillThere).toBeDefined();
  });
});
