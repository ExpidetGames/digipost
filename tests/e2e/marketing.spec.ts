// Marketing surface, end to end (WEBAPP_TEMPLATE_SPEC.md §10, §8): the landing page (hero,
// how it works, features, pricing derived from `@/modules/billing`'s constants, FAQ), its
// sign-in CTAs, the legal pages, and the security headers next.config.ts sends on every
// route. No `user` fixture needed: nothing here reads a session. Copy is German
// (decisions/0013-german-ui-language.md): assertions match `src/i18n/messages/de.json`.
//
// This spec was rewritten for the P4 marketing page but could not be run against the
// hermetic Docker test stack in this phase (P4's agent has no docker access, see
// AGENTS.md's "Parallel-Agent Git Rules" / this phase's task brief) - it is written
// carefully against the actual copy and DOM structure the components render, but the
// orchestrator or a follow-up phase should run `pnpm test:e2e:docker -- --grep @smoke`
// (and the full file) before relying on it in CI.
import { expect, test } from "@playwright/test";

test("the hero renders the headline and both CTAs", { tag: "@smoke" }, async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Ihre Geschäftspost, sofort beim richtigen Kollegen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kostenlos starten" }).first()).toHaveAttribute("href", "/login");
  // "So funktioniert es" also labels the header nav link (BRIEF.md: "UI elements render
  // twice ...: scope locators") - scope to <main> to target the hero's own secondary CTA.
  await expect(page.locator("main").getByRole("link", { name: "So funktioniert es" })).toHaveAttribute(
    "href",
    "#how-it-works",
  );
  await expect(page).toHaveTitle("Digipost: digitaler Posteingang für KMU");
});

test("the hero primary CTA leads to /login", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "Kostenlos starten" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible();
});

test("how it works, features, and the comparison section render", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "So funktioniert es" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mit dem Handy scannen" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Die Zahlung wird zugeordnet" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Funktionen" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Durchsuchbare PDFs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Automatische Kategorisierung" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Software statt Scan-Dienstleister" })).toBeVisible();
});

test(
  "the pricing section shows all four tiers with their limits",
  { tag: "@smoke" },
  async ({ page }) => {
    await page.goto("/#pricing");

    await expect(page.getByRole("heading", { name: "Preise", exact: true })).toBeVisible();

    // Tier names (from `@/modules/billing`'s `TIERS`).
    for (const tier of ["Free", "Starter", "Pro", "Unlimited"]) {
      await expect(page.getByText(tier, { exact: true })).toBeVisible();
    }

    // Limits (from `@/modules/billing`'s `TIER_LIMITS`, decisions/0015-documents-and-quotas.md).
    await expect(page.getByText("20 Dokumente gesamt")).toBeVisible();
    await expect(page.getByText("750 Dokumente gesamt")).toBeVisible();
    await expect(page.getByText("5.000 Dokumente gesamt")).toBeVisible();
    await expect(page.getByText("200.000 Dokumente gesamt")).toBeVisible();
    await expect(page.getByText("Kein monatliches Limit")).toBeVisible();
    await expect(page.getByText("100 neue Dokumente pro Monat")).toBeVisible();
    await expect(page.getByText("500 neue Dokumente pro Monat")).toBeVisible();
    await expect(page.getByText("5.000 neue Dokumente pro Monat")).toBeVisible();

    await expect(page.getByText("Alle Preise zzgl. USt.")).toBeVisible();
    await expect(page.getByText("kein automatisches Overage", { exact: false })).toBeVisible();

    // One CTA per tier card (plus the hero's and the closing section's), all to /login.
    const ctas = page.getByRole("link", { name: "Kostenlos starten" });
    await expect(ctas).toHaveCount(6);
    for (const href of await ctas.evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
      expect(href).toBe("/login");
    }
  },
);

test("the FAQ accordion opens and closes an answer", async ({ page }) => {
  await page.goto("/#faq");

  const question = page.getByRole("button", { name: "Brauche ich einen Scanner?" });
  await expect(question).toHaveAttribute("aria-expanded", "false");

  await question.click();
  await expect(question).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Digipost erkennt die Kanten automatisch", { exact: false })).toBeVisible();

  await question.click();
  await expect(question).toHaveAttribute("aria-expanded", "false");
});

test("the footer links reach the legal pages, both showing the draft banner", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "Impressum" }).click();
  await expect(page).toHaveURL(/\/legal-notice$/);
  await expect(page.getByRole("heading", { level: 1, name: "Impressum" })).toBeVisible();
  // `getByRole("alert")` alone is a strict-mode violation (P6 review, reported by two
  // phases): Next.js's own route announcer (`__next-route-announcer__`, present on every
  // page for accessible client-side navigation) also has `role="alert"`, so a bare role
  // query matches both it and `LegalDraftBanner`. Filtering by the banner's own text scopes
  // the locator to exactly one match.
  await expect(page.getByRole("alert").filter({ hasText: "Entwurf" })).toContainText("Entwurf");

  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Datenschutzerklärung" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Entwurf" })).toContainText("Entwurf");
  await expect(page.getByText("Mistral AI", { exact: false })).toBeVisible();
});

test("security headers are present on a marketing response", { tag: "@smoke" }, async ({ page }) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  const headers = response!.headers();

  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  // `camera=(self)` (src/modules/scanner, P2c): this same origin's "Kamera" tab needs
  // `getUserMedia` for its live preview; every other origin is still blocked.
  expect(headers["permissions-policy"]).toContain("camera=(self)");
  expect(headers["strict-transport-security"]).toContain("max-age=");
});

test("robots.txt and sitemap.xml are reachable", async ({ page, baseURL }) => {
  const robots = await page.goto("/robots.txt");
  expect(robots?.status()).toBe(200);
  expect(await robots?.text()).toContain("Sitemap:");

  const sitemap = await page.goto("/sitemap.xml");
  expect(sitemap?.status()).toBe(200);
  expect(await sitemap?.text()).toContain(new URL("/", baseURL!).toString());
});
