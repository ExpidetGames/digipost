import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

// Every statement here is a truthful fact of the current architecture (this phase's brief):
// no certifications, no audits, no "DSGVO-zertifiziert"/"GoBD-konform", no customer counts,
// no testimonials, and no server location asserted beyond "planned in the EU" - the hosting
// provider is not chosen yet (decisions/0016-processing-pipeline-and-ai.md's "Data
// protection note").
const TRUST_ITEM_KEYS = ["storage", "ocrProvider", "noAdSharing", "deletion", "hosting", "retention"] as const;

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// A hairline grid, plain background (decisions/0056-paper-brand.md's layout grammar): stays
// plain on purpose, right after the pricing band, so two soft `bg-muted` bands never touch.
// Two columns above the small breakpoint, ruled top and, in the left column, on the right too,
// so the six facts read as one bordered table rather than a stack of cards.
export async function TrustSection() {
  const t = await getTranslations("Marketing.trust");

  return (
    <section id="trust" aria-labelledby="trust-heading" className="bg-background">
      <div className={`py-20 sm:py-24 ${CONTAINER_CLASS}`}>
        <div className="mx-auto max-w-[760px]">
          <h2 id="trust-heading" className="text-center text-[clamp(1.6rem,2.6vw,2.1rem)] text-foreground">
            {t("heading")}
          </h2>
          <ul className="mt-10 grid grid-cols-1 border-t border-border sm:grid-cols-2">
            {TRUST_ITEM_KEYS.map((key, index) => (
              <li
                key={key}
                className={cn(
                  "flex items-start gap-3 border-b border-border py-4 text-sm text-foreground sm:py-5",
                  index % 2 === 0 && "sm:border-r sm:pr-6",
                  index % 2 === 1 && "sm:pl-6",
                )}
              >
                <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-strong" />
                <span>{t(`items.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
