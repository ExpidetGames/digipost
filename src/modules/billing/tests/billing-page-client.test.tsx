// @vitest-environment jsdom
// Client-component unit test (WEBAPP_TEMPLATE_SPEC.md §10.2): admin vs member rendering of
// `/dashboard/billing` (decisions/0017-billing-tiers-and-packages.md's requirement 1/4).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { BillingPageClient } from "../ui/billing-page-client";
import { buildUsageViewModel } from "../core/usage-view-model";

const messages = {
  Billing: {
    heading: "Tarif & Nutzung",
    description: "Beschreibung",
    testModeBadge: "Testmodus",
    memberHint: "Nur der Administrator kann den Tarif ändern oder Pakete kaufen.",
    tiers: {
      free: { name: "Free" },
      starter: { name: "Starter" },
      pro: { name: "Pro" },
      unlimited: { name: "Unlimited" },
    },
    usage: {
      totalLabel: "Gespeicherte Dokumente",
      monthlyLabel: "Neue Dokumente diesen Monat",
      unlimited: "kein Limit",
      noMonthlyLimit: "kein monatliches Limit",
      extraMonthlyQuota: "Davon {count} zusätzliche Paket-Kapazität.",
    },
    purchases: { heading: "Gekaufte Pakete", empty: "Keine Käufe." },
    packages: {
      heading: "Paket kaufen",
      description: "Ein Paket erhöht das monatliche Limit nur für diesen Monat.",
      notAvailableOnFree: "Pakete sind im Tarif Free nicht verfügbar.",
      extraDocuments: "+{count}",
      submit: "Kaufen",
      submitPending: "Wird gekauft…",
      s: { name: "Paket S" },
      m: { name: "Paket M" },
      l: { name: "Paket L" },
    },
    tierChange: { heading: "Tarif ändern", label: "Neuer Tarif", submit: "Tarif ändern", submitPending: "Wird geändert…" },
    notConfigured: {
      notice: "Die Zahlungsanbindung ist noch nicht eingerichtet.",
      contactHint: "Bitte kontaktieren Sie uns.",
    },
    errors: {
      invalid_input: "Ungültige Eingabe.",
      not_found: "Nicht gefunden.",
      unknown_tier: "Unbekannter Tarif.",
      unknown_package: "Unbekanntes Paket.",
      downgrade_below_stored_count: "Sie speichern aktuell {stored} Dokumente, das Limit ist {limit}.",
      packages_not_available_on_free: "Pakete sind im Tarif Free nicht verfügbar.",
      billing_not_configured: "Nicht konfiguriert.",
      unauthenticated: "Bitte melden Sie sich erneut an.",
      no_workspace: "Kein Arbeitsbereich.",
      forbidden: "Keine Berechtigung.",
      unknown: "Etwas ist schiefgelaufen.",
    },
  },
};

function renderPage(props: Parameters<typeof BillingPageClient>[0]) {
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <BillingPageClient {...props} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe("BillingPageClient", () => {
  const usage = buildUsageViewModel({ tier: "starter", storedDocuments: 10, createdThisMonth: 50, extraMonthlyQuota: 0, purchases: [] });

  it("shows usage numbers to a member without any management controls", () => {
    renderPage({ usage, canManage: false, testModeActive: true });

    expect(screen.getByText("Tarif & Nutzung")).not.toBeNull();
    expect(screen.getByText("10 / 750")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Tarif ändern" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kaufen" })).toBeNull();
    expect(screen.getByText(/Nur der Administrator/)).not.toBeNull();
  });

  it("shows management controls to an admin when test mode is active", () => {
    renderPage({ usage, canManage: true, testModeActive: true });

    expect(screen.getByRole("button", { name: "Tarif ändern" })).not.toBeNull();
    expect(screen.getAllByText("Testmodus").length).toBeGreaterThan(0);
  });

  it("hides management controls and shows the not-configured notice when test mode is off", () => {
    renderPage({ usage, canManage: true, testModeActive: false });

    expect(screen.queryByRole("button", { name: "Tarif ändern" })).toBeNull();
    expect(screen.getByText("Die Zahlungsanbindung ist noch nicht eingerichtet.")).not.toBeNull();
  });

  it("renders 'kein monatliches Limit' for Free, never a zero-valued bar", () => {
    const freeUsage = buildUsageViewModel({ tier: "free", storedDocuments: 5, createdThisMonth: 3, extraMonthlyQuota: 0, purchases: [] });
    renderPage({ usage: freeUsage, canManage: true, testModeActive: true });

    expect(screen.getByText("kein monatliches Limit")).not.toBeNull();
  });

  it("does not show the package purchase section on Free even for an admin", () => {
    const freeUsage = buildUsageViewModel({ tier: "free", storedDocuments: 5, createdThisMonth: 0, extraMonthlyQuota: 0, purchases: [] });
    renderPage({ usage: freeUsage, canManage: true, testModeActive: true });

    expect(screen.queryByText("Paket kaufen")).toBeNull();
    expect(screen.getByText("Pakete sind im Tarif Free nicht verfügbar.")).not.toBeNull();
  });
});
