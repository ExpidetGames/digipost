import { getTranslations } from "next-intl/server";
import { Check } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

// Honest comparison against a scan-service bureau (this phase's brief): no logos, no
// competitor names, only factual statements about what Digipost is (software the customer
// runs themselves) versus what it is not (a mail-forwarding or pickup service).
const COMPARISON_ITEM_KEYS = ["noForwarding", "noPickup", "readyImmediately", "staysInHouse"] as const;

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// A hairline list, plain background (decisions/0056-paper-brand.md's layout grammar): stays
// plain on purpose, sandwiched between the features rows above and the pricing band below so
// two soft `bg-muted` bands never touch.
export async function ComparisonSection() {
  const t = await getTranslations("Marketing.comparison");

  return (
    <section id="comparison" aria-labelledby="comparison-heading" className="bg-background">
      <div className={`py-20 sm:py-24 ${CONTAINER_CLASS}`}>
        <div className="mx-auto max-w-[640px]">
          <h2 id="comparison-heading" className="text-center text-[clamp(1.6rem,2.6vw,2.1rem)] text-foreground">
            {t("heading")}
          </h2>
          <p className="mt-3 text-center text-sm text-muted-foreground">{t("intro")}</p>
          <ul className="mt-10">
            {COMPARISON_ITEM_KEYS.map((key, index) => (
              <li
                key={key}
                className={cn(
                  "flex items-start gap-3 border-t border-border py-4 text-sm text-foreground",
                  index === COMPARISON_ITEM_KEYS.length - 1 && "border-b",
                )}
              >
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-strong" />
                <span>{t(`items.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
