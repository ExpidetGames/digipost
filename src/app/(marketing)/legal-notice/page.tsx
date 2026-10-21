import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { LegalDraftBanner } from "../_components/legal-draft-banner";

const SECTION_KEYS = ["operator", "contact", "register", "vatId", "responsible"] as const;

const TODO_ITEM_KEYS = [
  "companyName",
  "address",
  "representative",
  "register",
  "vatId",
  "contact",
  "supervisoryAuthority",
] as const;

// Structured per § 5 DDG (Impressum). Every fact here is a TODO placeholder, not real
// company data - this phase's brief: "never present placeholders as final legal text",
// enforced visually by `LegalDraftBanner` and the explicit "what still needs filling in"
// list at the end. Statically prerendered like the rest of (marketing): no cookies/session.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Legal.legalNotice");
  return { title: t("heading") };
}

export default async function LegalNoticePage() {
  const t = await getTranslations("Legal.legalNotice");
  const tBanner = await getTranslations("Legal.draftBanner");

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-16 sm:px-8">
      <h1 className="text-2xl text-foreground">{t("heading")}</h1>
      <LegalDraftBanner heading={tBanner("heading")} body={tBanner("body")} />

      <div className="mt-8 space-y-6">
        {SECTION_KEYS.map((key) => (
          <section key={key} aria-labelledby={`legal-notice-${key}`}>
            <h2 id={`legal-notice-${key}`} className="text-lg text-foreground">
              {t(`sections.${key}.heading`)}
            </h2>
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{t(`sections.${key}.body`)}</p>
          </section>
        ))}
      </div>

      <section aria-labelledby="legal-notice-todo" className="mt-10 rounded-lg border border-dashed border-border px-4 py-3">
        <h2 id="legal-notice-todo" className="text-sm font-semibold text-foreground">
          {t("todo.heading")}
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {TODO_ITEM_KEYS.map((key) => (
            <li key={key}>{t(`todo.items.${key}`)}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
