import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getMailIntakeSettingsProjection, listInboundEmailsProjection } from "@/modules/mail-intake/server";
import { MailIntakePageClient } from "@/modules/mail-intake/client";

/** "E-Mail-Eingang" (decisions/0075-email-intake.md): every member sees the workspace's own
 * address; the admin (`mail_intake.manage`) also gets the controls and the received-mail log.
 * The workspace is always the caller's resolved membership, never client input; opening this
 * page is also what lazily creates the address for a workspace that has none yet. */
export default async function MailIntakePage() {
  const access = await requireWorkspaceMember();
  const canManage = access.permissions.includes(PERMISSIONS.mailIntakeManage);

  const [settings, emails] = await Promise.all([
    getMailIntakeSettingsProjection(access.workspace.id),
    canManage ? listInboundEmailsProjection(access.workspace.id) : Promise.resolve(null),
  ]);

  return <MailIntakePageClient settings={settings} emails={emails} canManage={canManage} />;
}
