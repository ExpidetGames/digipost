import { getTranslations } from "next-intl/server";

import { cn } from "@/shared/ui-primitives";

const PROBLEM_ITEM_KEYS = ["sorting", "lateInvoices", "missedDeadlines"] as const;

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// Plain background (the how-it-works band right after this needs a plain neighbor so two
// soft bands never touch, decisions/0056-paper-brand.md's layout grammar): three items
// separated by vertical hairlines above 860px, collapsing to a stacked list with top
// hairlines below it - the same divider mechanic as the numbered steps, minus the band and
// the numeral, so the two sections read as a matched pair.
export async function ProblemSection() {
  const t = await getTranslations("Marketing.problem");

  return (
    <section id="problem" aria-labelledby="problem-heading" className="bg-background">
      <div className={`py-20 sm:py-24 ${CONTAINER_CLASS}`}>
        <h2 id="problem-heading" className="max-w-[34ch] text-[clamp(1.6rem,2.6vw,2.1rem)] text-foreground">
          {t("heading")}
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-8 min-[860px]:grid-cols-3 min-[860px]:gap-0">
          {PROBLEM_ITEM_KEYS.map((key, index) => (
            <div
              key={key}
              className={cn(
                "min-[860px]:px-9",
                index === 0
                  ? "min-[860px]:pl-0"
                  : "border-t border-border pt-6 min-[860px]:border-t-0 min-[860px]:border-l min-[860px]:pt-0",
              )}
            >
              <h3 className="font-sans text-[1.08rem] font-semibold text-foreground">{t(`items.${key}.heading`)}</h3>
              <p className="mt-2.5 text-sm text-muted-foreground">{t(`items.${key}.body`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
