import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { LegalDraftBanner } from "../_components/legal-draft-banner";

const SECTION_KEYS = ["controller", "purposes", "legalBasis", "recipients", "storageLocation", "retention"] as const;

const RIGHTS_ITEM_KEYS = ["access", "rectification", "erasure", "restriction", "portability", "objection"] as const;

// Datenschutzerklärung, structured per this phase's brief: Verantwortlicher, Zwecke,
// Rechtsgrundlagen, Empfänger/Auftragsverarbeiter (including Mistral for OCR/classification,
// decisions/0016-processing-pipeline-and-ai.md's "Data protection note"), object storage,
// Speicherdauer, Betroffenenrechte, Beschwerderecht. Every TODO-marked fact is a genuine
// placeholder, never presented as final: `LegalDraftBanner` makes that unmissable.
// Statically prerendered like the rest of (marketing): no cookies/session.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Legal.privacy");
  return { title: t("heading") };
}

export default async function PrivacyPage() {
  const t = await getTranslations("Legal.privacy");
  const tBanner = await getTranslations("Legal.draftBanner");

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-16 sm:px-8">
      <h1 className="text-2xl text-foreground">{t("heading")}</h1>
      <LegalDraftBanner heading={tBanner("heading")} body={tBanner("body")} />

      <div className="mt-8 space-y-6">
        {SECTION_KEYS.map((key) => (
          <section key={key} aria-labelledby={`privacy-${key}`}>
            <h2 id={`privacy-${key}`} className="text-lg text-foreground">
              {t(`sections.${key}.heading`)}
            </h2>
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{t(`sections.${key}.body`)}</p>
          </section>
        ))}

        <section aria-labelledby="privacy-rights">
          <h2 id="privacy-rights" className="text-lg text-foreground">
            {t("sections.rights.heading")}
          </h2>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {RIGHTS_ITEM_KEYS.map((key) => (
              <li key={key}>{t(`sections.rights.items.${key}`)}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="privacy-complaint">
          <h2 id="privacy-complaint" className="text-lg text-foreground">
            {t("sections.complaint.heading")}
          </h2>
          <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{t("sections.complaint.body")}</p>
        </section>
      </div>
    </main>
  );
}
