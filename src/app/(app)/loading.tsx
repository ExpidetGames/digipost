import { getTranslations } from "next-intl/server";

// Suspense fallback for the whole (app) segment (WEBAPP_TEMPLATE_SPEC.md §8: "Langsame
// Routen bekommen loading.tsx"). Shown while `src/app/(app)/layout.tsx`'s
// `requireWorkspaceMember()` or a page's data fetch (e.g. `dashboard/team/page.tsx`'s
// `listTeamProjection`) is in flight.
export default async function AppLoading() {
  const t = await getTranslations("Common");

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
        <div
          className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
          aria-hidden
        />
        <span>{t("loading")}</span>
      </div>
    </div>
  );
}
