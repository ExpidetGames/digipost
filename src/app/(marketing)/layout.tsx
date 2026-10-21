import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/shared/ui-primitives";

// Static marketing chrome shared by the landing page and the placeholder legal pages. Never
// reads cookies/session (WEBAPP_TEMPLATE_SPEC.md §3: "liest nie Cookies/Session, bleibt
// prerendered") - the "Sign in" link is a plain, unconditional link to /login; a
// signed-in visitor who lands here just gets redirected onward from /login itself
// (src/app/(auth)/login/page.tsx already does that), so this layout does not need to know.
//
// Visual language: decisions/0056-paper-brand.md. A sticky 76px header with one bottom
// hairline, a serif wordmark, and the shared 1120px container every marketing section lines
// up against; a footer with the same wordmark, a muted tagline, and the legal links in a row.
const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("Marketing");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background">
        <div className={`flex h-[76px] items-center justify-between gap-4 ${CONTAINER_CLASS}`}>
          <Link href="/" className="font-heading text-[1.3rem] font-medium text-foreground">
            {t("logoPlaceholder")}
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground sm:flex">
            <Link href="/#how-it-works" className="hover:text-foreground">
              {t("nav.howItWorks")}
            </Link>
            <Link href="/#features" className="hover:text-foreground">
              {t("nav.features")}
            </Link>
            <Link href="/#pricing" className="hover:text-foreground">
              {t("nav.pricing")}
            </Link>
            <Link href="/#faq" className="hover:text-foreground">
              {t("nav.faq")}
            </Link>
          </nav>
          <Link href="/login" className={buttonVariants({ size: "sm" })}>
            {t("signInCta")}
          </Link>
        </div>
      </header>

      <div className="flex flex-1 flex-col">{children}</div>

      <footer className="border-t border-border">
        <div className={`flex flex-col gap-6 py-14 text-sm text-muted-foreground sm:flex-row sm:items-start sm:justify-between ${CONTAINER_CLASS}`}>
          <div>
            <p className="font-heading text-lg font-medium text-foreground">{t("logoPlaceholder")}</p>
            <p className="mt-1">{t("footer.copyright", { year: new Date().getFullYear() })}</p>
            {/* Clearly marked placeholder (this phase's brief): no real contact channel exists
                yet, so this must never read as a working address. */}
            <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs">
              {t("footer.contactHeading")}: {t("footer.contactPlaceholder")}
            </p>
          </div>
          <nav className="flex items-center gap-6">
            <Link href="/legal-notice" className="hover:text-foreground">
              {t("footer.legalNotice")}
            </Link>
            <Link href="/privacy" className="hover:text-foreground">
              {t("footer.privacy")}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
