import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowRight, Camera, ScanText, UserCheck } from "lucide-react";

import { buttonVariants } from "@/shared/ui-primitives";

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// The page's only <h1>. Two columns above 860px (text 1.1fr, artwork 0.9fr), a single column
// below it with the artwork moved above the text (decisions/0056-paper-brand.md). No stock
// photography: `HeroArtwork` is a small decorative (`aria-hidden`, no <title>) inline SVG
// built entirely from the brand's own tokens, and the "flow" strip below the CTAs is built
// from existing icons and tokens too - the visible text labels next to each icon carry the
// same information for anyone not seeing the icons.
export async function HeroSection() {
  const t = await getTranslations("Marketing.hero");

  return (
    <section className="bg-background">
      <div
        className={`grid grid-cols-1 items-center gap-10 py-20 sm:py-28 min-[860px]:grid-cols-[1.1fr_0.9fr] min-[860px]:gap-14 ${CONTAINER_CLASS}`}
      >
        <div className="order-2 min-[860px]:order-none">
          <p className="text-sm text-muted-foreground">{t("kicker")}</p>
          <h1 className="mt-4 text-balance text-[clamp(2.3rem,4.4vw,3.5rem)] leading-[1.12] text-foreground">
            {t("heading")}
          </h1>
          <p className="mt-5 max-w-[46ch] text-lg text-muted-foreground">{t("tagline")}</p>
          <div className="mt-8 flex flex-wrap items-center gap-6">
            <Link href="/login" className={buttonVariants({ size: "lg" })}>
              {t("primaryCta")}
            </Link>
            <Link
              href="#how-it-works"
              className="border-b border-border pb-0.5 text-[0.98rem] text-foreground transition-colors hover:border-foreground"
            >
              {t("secondaryCta")}
            </Link>
          </div>

          <div
            aria-hidden="true"
            className="mt-10 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground sm:gap-3"
          >
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
              <Camera className="size-3.5" />
              {t("flow.scan")}
            </span>
            <ArrowRight className="size-3.5 shrink-0" />
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
              <ScanText className="size-3.5" />
              {t("flow.analyze")}
            </span>
            <ArrowRight className="size-3.5 shrink-0" />
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
              <UserCheck className="size-3.5" />
              {t("flow.deliver")}
            </span>
          </div>
        </div>

        <div className="order-1 mx-auto w-full max-w-[240px] min-[860px]:order-none min-[860px]:max-w-none">
          <HeroArtwork />
        </div>
      </div>
    </section>
  );
}

// Three stacked letters, slightly rotated, with a dashed check circle (brand-reference.html).
// Purely decorative: `aria-hidden`, no <title>. Every color comes from the brand's own tokens
// through a type-hinted arbitrary Tailwind value (fill/stroke utilities pointed at a CSS
// custom property with the "color:" type hint), never a raw hex value in a className.
function HeroArtwork() {
  return (
    <svg aria-hidden="true" viewBox="0 0 420 420" className="h-auto w-full">
      <rect
        x="70"
        y="120"
        width="220"
        height="280"
        rx="4"
        transform="rotate(-6 70 120)"
        strokeWidth="1.5"
        className="fill-[color:var(--card)] stroke-[color:var(--border)]"
      />
      <rect
        x="110"
        y="90"
        width="220"
        height="280"
        rx="4"
        transform="rotate(3 110 90)"
        strokeWidth="1.5"
        className="fill-[color:var(--card)] stroke-[color:var(--border)]"
      />
      <g transform="rotate(-2 130 70)">
        <rect
          x="130"
          y="70"
          width="220"
          height="280"
          rx="4"
          strokeWidth="1.5"
          className="fill-[color:var(--background)] stroke-[color:var(--primary)]"
        />
        <path
          d="M130 70 L182 70 L182 118 Z"
          strokeWidth="1.5"
          strokeLinejoin="round"
          className="fill-[color:var(--accent)] stroke-[color:var(--primary)]"
        />
        <line
          x1="158"
          y1="150"
          x2="310"
          y2="150"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.7"
          className="stroke-[color:var(--foreground)]"
        />
        <line
          x1="158"
          y1="172"
          x2="310"
          y2="172"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.7"
          className="stroke-[color:var(--foreground)]"
        />
        <line
          x1="158"
          y1="194"
          x2="270"
          y2="194"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.7"
          className="stroke-[color:var(--foreground)]"
        />
        <line
          x1="158"
          y1="228"
          x2="300"
          y2="228"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.35"
          className="stroke-[color:var(--foreground)]"
        />
        <line
          x1="158"
          y1="250"
          x2="240"
          y2="250"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.35"
          className="stroke-[color:var(--foreground)]"
        />
      </g>
      <circle
        cx="330"
        cy="300"
        r="40"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        className="fill-[color:var(--background)] stroke-[color:var(--brand-warm)]"
      />
      <path
        d="M313 300 L325 312 L349 286"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="fill-none stroke-[color:var(--brand-warm)]"
      />
    </svg>
  );
}
