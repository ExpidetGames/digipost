import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getCurrentUser } from "@/platform/auth/server";
import { getInvitationPreview } from "@/modules/workspaces/server";
import { InviteAcceptForm } from "@/modules/workspaces/client";

// Must be reachable signed OUT (decisions/0014-workspaces-and-access.md): a signed-out
// visitor is redirected to `/login` with a safe `next` back to this exact page, so they
// land here again right after the magic-link sign-in. Deliberately outside the `(app)`
// route group and NOT in src/proxy.ts's matcher for the same reason.
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const preview = await getInvitationPreview(token);
  const t = await getTranslations("Invite");

  if (preview.status === "error") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-sm text-center">
          <h1 className="mb-2 text-xl font-semibold text-foreground">{t("heading")}</h1>
          <p role="alert" className="text-sm text-destructive">
            {t(`errors.${preview.errorCode}`)}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {t("description", {
            workspace: preview.data.workspaceName,
            // `inviterEmail` is `null` when the inviting user's account has since been
            // deleted (P6 review finding A9: `invitedByUserId` is nullable, `onDelete: "set
            // null"`) - the invitation itself is still valid and must still render.
            inviter: preview.data.inviterEmail ?? t("unknownInviter"),
          })}
        </p>
        <InviteAcceptForm token={token} />
      </div>
    </main>
  );
}
