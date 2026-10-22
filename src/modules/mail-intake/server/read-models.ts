import "server-only";

import { cache } from "react";

import { getRequestServices } from "@/persistence/composition/request-services";

import type { InboundEmailView, MailIntakeSettingsView } from "../core/types";

/** `/dashboard/email-intake`: the workspace's address and settings, creating them on first
 * view (decisions/0075-email-intake.md's lazy creation, so every existing workspace gets an
 * address without a backfill migration). `workspaceId` is always the caller's own resolved
 * membership, never client input. */
export const getMailIntakeSettingsProjection = cache(async (workspaceId: string): Promise<MailIntakeSettingsView> => {
  return getRequestServices().mailIntake.getSettings(workspaceId);
});

/** The received-mail log (admin-only on the page). */
export const listInboundEmailsProjection = cache(async (workspaceId: string): Promise<InboundEmailView[]> => {
  return getRequestServices().mailIntake.listInboundEmails(workspaceId);
});

/** The document detail's "Per E-Mail von ..." line: the sender of the mail that created this
 * document, or `null` for an uploaded one. */
export const getEmailSourceForDocumentProjection = cache(async (workspaceId: string, documentId: string): Promise<{ fromAddress: string } | null> => {
  return getRequestServices().mailIntake.getEmailSourceForDocument(workspaceId, documentId);
});
