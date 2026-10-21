import { getTranslations } from "next-intl/server";

import { cn } from "@/shared/ui-primitives";

const STEP_KEYS = ["scan", "analyze", "match"] as const;

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// Describes only what the product actually does today (decisions/0015-documents-and-quotas.md,
// decisions/0016-processing-pipeline-and-ai.md): capture, OCR + categorization, then
// rule-based routing with a notification e-mail.
//
// The section that "carries weight" on a soft `bg-muted` band with a hairline top and bottom
// (decisions/0056-paper-brand.md): three numbered columns separated by vertical dividers
// above 860px, collapsing to top borders below it.
export async function HowItWorksSection() {
  const t = await getTranslations("Marketing.howItWorks");

  return (
    <section id="how-it-works" aria-labelledby="how-it-works-heading" className="scroll-mt-20 border-y border-border bg-muted">
      <div className={`py-20 sm:py-24 ${CONTAINER_CLASS}`}>
        <h2 id="how-it-works-heading" className="max-w-[34ch] text-[clamp(1.6rem,2.6vw,2.1rem)] text-foreground">
          {t("heading")}
        </h2>
        <ol className="mt-12 grid grid-cols-1 gap-10 min-[860px]:grid-cols-3 min-[860px]:gap-0">
          {STEP_KEYS.map((key, index) => (
            <li
              key={key}
              className={cn(
                "min-[860px]:px-9",
                index === 0
                  ? "min-[860px]:pl-0"
                  : "border-t border-border pt-8 min-[860px]:border-t-0 min-[860px]:border-l min-[860px]:pt-0",
              )}
            >
              <span aria-hidden="true" className="font-heading text-[2.6rem] leading-none text-accent-strong">
                {t(`steps.${key}.number`)}
              </span>
              <h3 className="mt-4 font-sans text-[1.08rem] font-semibold text-foreground">{t(`steps.${key}.heading`)}</h3>
              <p className="mt-2.5 text-[0.97rem] text-muted-foreground">{t(`steps.${key}.body`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
