// Real Postgres: decisions/0074-sign-up-by-invitation-only.md's eligibility read. Proves the
// case-insensitive account lookup and that only a pending, unexpired invitation counts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { findSignInEligibility } from "@/persistence/composition/auth-database";
import { getDb } from "@/persistence/foundation/client";
import { user } from "@/persistence/schema/auth";
import { workspaceInvitations, workspaces } from "@/persistence/schema/workspaces";

const db = getDb();
const DAY_MS = 24 * 60 * 60 * 1000;

function uniqueAddress(label: string): string {
  return `${label}-${randomUUID()}@example.com`;
}

async function inviteInNewWorkspace(email: string, input: { expiresAt: Date; acceptedAt?: Date }): Promise<void> {
  const [workspace] = await db.insert(workspaces).values({ name: "Eligibility GmbH" }).returning({ id: workspaces.id });
  await db.insert(workspaceInvitations).values({
    workspaceId: workspace!.id,
    email,
    tokenHash: randomUUID(),
    expiresAt: input.expiresAt,
    acceptedAt: input.acceptedAt ?? null,
  });
}

describe("findSignInEligibility", () => {
  it("finds an existing account case-insensitively", async () => {
    const email = uniqueAddress("member");
    await db.insert(user).values({ name: "Mitglied", email, emailVerified: true });

    expect(await findSignInEligibility(email.toUpperCase(), new Date())).toEqual({ hasAccount: true, hasPendingInvitation: false });
  });

  it("counts a pending, unexpired invitation", async () => {
    const email = uniqueAddress("invited");
    await inviteInNewWorkspace(email, { expiresAt: new Date(Date.now() + 7 * DAY_MS) });

    expect(await findSignInEligibility(email, new Date())).toEqual({ hasAccount: false, hasPendingInvitation: true });
  });

  it("ignores an expired or already accepted invitation", async () => {
    const expired = uniqueAddress("expired");
    await inviteInNewWorkspace(expired, { expiresAt: new Date(Date.now() - DAY_MS) });
    const accepted = uniqueAddress("accepted");
    await inviteInNewWorkspace(accepted, { expiresAt: new Date(Date.now() + DAY_MS), acceptedAt: new Date() });

    expect(await findSignInEligibility(expired, new Date())).toEqual({ hasAccount: false, hasPendingInvitation: false });
    expect(await findSignInEligibility(accepted, new Date())).toEqual({ hasAccount: false, hasPendingInvitation: false });
  });

  it("knows nothing about an unknown address", async () => {
    expect(await findSignInEligibility(uniqueAddress("stranger"), new Date())).toEqual({ hasAccount: false, hasPendingInvitation: false });
  });
});
