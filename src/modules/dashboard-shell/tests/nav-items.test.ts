/**
 * Guards against the P6 review finding: `NAV_ITEMS` gained a `/dashboard/billing` entry
 * with `labelKey: "billing"` but `de.json`'s `DashboardShell.nav` had no `billing` key, so
 * every signed-in user saw the literal string "DashboardShell.nav.billing" in the sidebar
 * and mobile nav. This iterates the real nav config against the real message catalog so a
 * future nav item with no copy fails here instead of shipping to a user.
 *
 * decisions/0055-navigation-by-use-case.md turned the flat list into sections, so section
 * headings (dotted keys like `"sections.post"`) are checked the same way, and the
 * longest-match active rule and the section filtering got tests of their own.
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";

import { activeNavHref, activeSectionKey, NAV_SECTIONS, sectionTarget, visibleNavSections } from "../core/nav-items";

function resolveMessage(key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[segment];
  }, de.DashboardShell.nav);
}

const entries = NAV_SECTIONS.flatMap((section) => section.items);
const sectionHeadings = NAV_SECTIONS.map((section) => section.labelKey).filter((key): key is string => key !== null);

describe("every nav labelKey resolves in de.json", () => {
  it.each(entries)("labelKey $labelKey ($href) has a message", ({ labelKey, href }) => {
    expect(typeof resolveMessage(labelKey), `DashboardShell.nav.${labelKey} (nav item "${href}") is missing from de.json`).toBe("string");
  });

  it.each(sectionHeadings)("section heading %s has a message", (labelKey) => {
    expect(typeof resolveMessage(labelKey), `DashboardShell.nav.${labelKey} (section heading) is missing from de.json`).toBe("string");
  });

  it("has copy for the 'planned, not built yet' badge", () => {
    expect(typeof de.DashboardShell.nav.soon).toBe("string");
  });
});

describe("the nav config itself", () => {
  it("never lists the same route twice", () => {
    const hrefs = entries.map((item) => item.href).filter((href): href is string => href !== null);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("gates every finance entry behind finance.read - a bank statement exposes salaries", () => {
    const financeEntries = entries.filter((item) => item.href?.startsWith("/dashboard/finance"));
    expect(financeEntries.length).toBeGreaterThan(0);
    expect(financeEntries.every((item) => item.permission === "finance.read")).toBe(true);
  });
});

describe("activeNavHref", () => {
  it("marks the exact entry", () => {
    expect(activeNavHref("/dashboard/contacts")).toBe("/dashboard/contacts");
  });

  it("marks the deepest entry, not its prefix", () => {
    expect(activeNavHref("/dashboard/finance/zuordnung")).toBe("/dashboard/finance/zuordnung");
  });

  it("falls back to the nearest ancestor for a page with no entry of its own", () => {
    expect(activeNavHref("/dashboard/documents/abc-123")).toBe("/dashboard");
    expect(activeNavHref("/dashboard/finance/account-1")).toBe("/dashboard/finance");
    expect(activeNavHref("/dashboard/contacts/contact-1")).toBe("/dashboard/contacts");
  });

  it("never lets a prefix that is not a segment boundary match", () => {
    expect(activeNavHref("/dashboard/scanner", [{ labelKey: null, items: [{ href: "/dashboard/scan", labelKey: "scan" }] }])).toBe(null);
  });
});

// decisions/0057-sections-are-disclosures.md: a section heading is the control that opens it
// and goes to its first entry, so the sidebar shows one open section at a time.
describe("sectionTarget", () => {
  it("is the section's first built route", () => {
    const money = NAV_SECTIONS.find((section) => section.labelKey === "sections.money")!;
    expect(sectionTarget(money)).toBe("/dashboard/finance");
  });

  // No shipped section is entirely planned today (decisions/0066 gave "Abschluss" its page),
  // so this uses a synthetic one: the rule belongs to the function, not to the current config.
  it("is null while every entry in the section is still planned", () => {
    expect(
      sectionTarget({
        labelKey: "sections.post",
        items: [
          { href: null, labelKey: "start" },
          { href: null, labelKey: "emailIntake" },
        ],
      }),
    ).toBe(null);
  });

  it("skips a planned entry that comes first", () => {
    expect(
      sectionTarget({
        labelKey: "sections.post",
        items: [
          { href: null, labelKey: "start" },
          { href: "/dashboard/scan", labelKey: "scan" },
        ],
      }),
    ).toBe("/dashboard/scan");
  });
});

describe("activeSectionKey", () => {
  it("names the section holding the current page", () => {
    expect(activeSectionKey("/dashboard/finance/offene-posten")).toBe("sections.money");
    expect(activeSectionKey("/dashboard/settings/company")).toBe("sections.admin");
  });

  it("follows the nearest ancestor for a page with no entry of its own", () => {
    expect(activeSectionKey("/dashboard/finance/account-1")).toBe("sections.money");
    expect(activeSectionKey("/dashboard/documents/abc")).toBe("sections.post");
  });

  it("is null for a standalone entry, which is never inside a disclosure", () => {
    expect(activeSectionKey("/dashboard/contacts")).toBe(null);
  });

  it("is null for a path the nav knows nothing about", () => {
    expect(activeSectionKey("/something-else")).toBe(null);
  });
});

describe("visibleNavSections", () => {
  it("drops a section whose every entry the caller may not see, heading included", () => {
    const memberSections = visibleNavSections(["documents.write"]);
    expect(memberSections.some((section) => section.labelKey === "sections.money")).toBe(false);
    expect(memberSections.flatMap((section) => section.items).some((item) => item.href === "/dashboard/abschluss")).toBe(false);
  });

  it("keeps the finance section and the Abschluss entry for an admin", () => {
    const adminSections = visibleNavSections(["finance.read"]);
    expect(adminSections.find((section) => section.labelKey === "sections.money")?.items).toHaveLength(3);
    expect(adminSections.flatMap((section) => section.items).some((item) => item.href === "/dashboard/abschluss")).toBe(true);
  });

  it("keeps an unrestricted entry for everyone", () => {
    const hrefs = visibleNavSections([]).flatMap((section) => section.items.map((item) => item.href));
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/dashboard/billing");
  });
});
