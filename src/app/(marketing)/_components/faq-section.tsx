import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { buttonVariants, cn } from "@/shared/ui-primitives";

import { FaqAccordion, type FaqItem } from "./faq-accordion";

const FAQ_ITEM_KEYS = [
  "scanner",
  "limit",
  "visibility",
  "invite",
  "eInvoice",
  "cancel",
  "originals",
  "security",
] as const;

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// Server component: resolves every question/answer through next-intl, then hands plain
// strings to the interactive `FaqAccordion` client component (WEBAPP_TEMPLATE_SPEC.md §8:
// keep the client boundary as small as possible).
//
// Renders two sections: the FAQ itself (plain background) and, closing the page above the
// footer (decisions/0056-paper-brand.md's layout grammar), the full-width navy CTA band with
// the heading on the left and a light button on the right, wrapping to a column on small
// screens.
export async function FaqSection() {
  const t = await getTranslations("Marketing.faq");
  const tClosing = await getTranslations("Marketing.closingCta");

  const items: FaqItem[] = FAQ_ITEM_KEYS.map((key) => ({
    id: key,
    question: t(`items.${key}.question`),
    answer: t(`items.${key}.answer`),
  }));

  return (
    <>
      <section id="faq" aria-labelledby="faq-heading" className="scroll-mt-20 bg-background">
        <div className={`py-20 sm:py-24 ${CONTAINER_CLASS}`}>
          <div className="mx-auto max-w-[640px]">
            <h2 id="faq-heading" className="text-center text-[clamp(1.6rem,2.6vw,2.1rem)] text-foreground">
              {t("heading")}
            </h2>
            <div className="mt-10">
              <FaqAccordion items={items} />
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="closing-cta-heading" className="bg-primary text-primary-foreground">
        <div
          className={cn(
            "flex flex-col items-start gap-8 py-16 sm:py-20 min-[701px]:flex-row min-[701px]:items-center min-[701px]:justify-between",
            CONTAINER_CLASS,
          )}
        >
          <h2 id="closing-cta-heading" className="max-w-[26ch] text-[clamp(1.7rem,3vw,2.3rem)] text-primary-foreground">
            {tClosing("heading")}
          </h2>
          <Link href="/login" className={cn(buttonVariants({ size: "lg" }), "bg-background text-accent-strong hover:bg-background/90")}>
            {tClosing("cta")}
          </Link>
        </div>
      </section>
    </>
  );
}
