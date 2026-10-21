import { ComparisonSection } from "./_components/comparison-section";
import { FaqSection } from "./_components/faq-section";
import { FeaturesSection } from "./_components/features-section";
import { HeroSection } from "./_components/hero-section";
import { HowItWorksSection } from "./_components/how-it-works-section";
import { PricingSection } from "./_components/pricing-section";
import { ProblemSection } from "./_components/problem-section";
import { TrustSection } from "./_components/trust-section";

// Statically prerendered landing page (WEBAPP_TEMPLATE_SPEC.md §3, §8): reads no
// cookies/session. Section order matches this phase's brief: hero, problem, how it works,
// features, comparison to a scan-service bureau, pricing (derived from
// `@/modules/billing`'s constants, never duplicated), trust/privacy facts, then FAQ and a
// closing CTA. Exactly one <h1> (in HeroSection); every section heading below it is an
// <h2>, sub-items are <h3> - no heading level is skipped.
export default async function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <HeroSection />
      <ProblemSection />
      <HowItWorksSection />
      <FeaturesSection />
      <ComparisonSection />
      <PricingSection />
      <TrustSection />
      <FaqSection />
    </main>
  );
}
