import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/platform/auth/server";
import { safeNextPath } from "@/modules/sign-in";
import { LoginForm } from "@/modules/sign-in/client";

// Reads the session cookie (via getCurrentUser) to bounce an already-signed-in
// visitor straight through; never statically prerendered.
export const dynamic = "force-dynamic";

function paramString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNextPath(paramString(params.next));

  const user = await getCurrentUser();
  if (user) redirect(next);

  const t = await getTranslations("Login");

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <LoginForm next={next} initialErrorCode={paramString(params.error)} />
      </div>
    </main>
  );
}
