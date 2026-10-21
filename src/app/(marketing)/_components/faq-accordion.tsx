"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

export type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

// Client component (the one genuinely interactive piece of this otherwise static marketing
// page, WEBAPP_TEMPLATE_SPEC.md §8): a single-open accordion, real <button>s (never a
// div-onclick), aria-expanded/aria-controls wired for assistive tech, and
// `motion-reduce:transition-none` on the only animation (the chevron rotation) so
// `prefers-reduced-motion` is respected. Pure presentational: the parent server component
// resolves all copy via next-intl and passes plain strings, so this component itself needs
// no i18n context and is trivially unit-testable (see tests/faq-accordion.test.tsx).
export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-card">
      {items.map((item) => {
        const isOpen = item.id === openId;
        const buttonId = `faq-question-${item.id}`;
        const panelId = `faq-answer-${item.id}`;

        return (
          <div key={item.id}>
            <h3 className="text-base leading-snug font-medium text-foreground">
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenId(isOpen ? null : item.id)}
                className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span>{item.question}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
            </h3>
            {isOpen ? (
              <div id={panelId} role="region" aria-labelledby={buttonId} className="px-4 pb-4 text-sm text-muted-foreground">
                {item.answer}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
