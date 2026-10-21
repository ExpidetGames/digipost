import { getTranslations } from "next-intl/server";

import { cn } from "@/shared/ui-primitives";

// Every item here names a feature the product actually ships today (decisions/0015, 0016):
// no roadmap items, no claims about work not yet implemented.
const FEATURE_ITEM_KEYS = [
  "scanner",
  "ocr",
  "kinds",
  "search",
  "workspaces",
  "payments",
  "quotas",
] as const;

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// Bordered feature rows, not cards (decisions/0056-paper-brand.md's layout grammar): a serif
// <h3> on the left, muted body text on the right, each row separated by a top hairline, the
// last row closed off with one underneath too. Single column below 860px.
export async function FeaturesSection() {
  const t = await getTranslations("Marketing.features");

  return (
    <section id="features" aria-labelledby="features-heading" className="scroll-mt-20 bg-background">
      <div className={`py-20 sm:py-24 ${CONTAINER_CLASS}`}>
        <h2 id="features-heading" className="max-w-[34ch] text-[clamp(1.6rem,2.6vw,2.1rem)] text-foreground">
          {t("heading")}
        </h2>
        <div className="mt-11">
          {FEATURE_ITEM_KEYS.map((key, index) => (
            <div
              key={key}
              className={cn(
                "grid grid-cols-1 gap-2 border-t border-border py-7 min-[860px]:grid-cols-[1fr_1.4fr] min-[860px]:gap-10 min-[860px]:py-8",
                index === FEATURE_ITEM_KEYS.length - 1 && "border-b",
              )}
            >
              <h3 className="font-heading text-[1.3rem] font-medium text-foreground">{t(`items.${key}.heading`)}</h3>
              <p className="max-w-[52ch] text-muted-foreground">{t(`items.${key}.body`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
