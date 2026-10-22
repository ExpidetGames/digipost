// Neutral nav config (WEBAPP_TEMPLATE_SPEC.md §8: closed string sets as `as const` + derived
// union, no duplicated literals). Add a capability here and it shows up in both the desktop
// sidebar and the mobile nav - the two `ui/` components share this one list, nothing else to
// keep in sync.
//
// decisions/0055-navigation-by-use-case.md: the sidebar is grouped by the MOMENT a user is in
// ("Post", "Finanzen", "Abschluss"), not by the tables behind it. A section whose every entry is
// filtered out by `permission` disappears with its heading, so a member never sees an empty
// "Finanzen" block. `href: null` marks a capability that is planned but not built: it renders as a
// disabled row with a "Demnächst" badge rather than a link, so the product's own shape is
// visible without promising a page that 404s.
//
// `labelKey` resolves under the `DashboardShell.nav` next-intl namespace (a dotted key like
// `"sections.post"` resolves as a nested path there, which is why section labels may share the
// same namespace as item labels). `permission`, when set, hides the entry from anyone whose
// resolved workspace permissions (`src/platform/access`) do not include it - display only (the
// real authorization always happens server-side on the page/action itself,
// `src/platform/access`'s own README).
import type { Permission } from "@/platform/access";

export type NavEntry = {
  /** `null` marks a planned capability with no route yet (see this file's header). */
  href: string | null;
  labelKey: string;
  permission?: Permission;
};

export type NavSection = {
  /** `null` renders the entries with no heading above them (the standalone rooms). */
  labelKey: string | null;
  items: readonly NavEntry[];
};

export const NAV_SECTIONS: readonly NavSection[] = [
  // "Was muss ich jetzt tun?" - the work list itself (decisions/0055): confirmations waiting,
  // failed processing, overdue payments, transactions with no document yet. Every count is a
  // real aggregate over data that already exists; the page owns no state of its own.
  { labelKey: null, items: [{ href: "/dashboard/start", labelKey: "start" }] },
  {
    labelKey: "sections.post",
    items: [
      { href: "/dashboard", labelKey: "inbox" },
      // P2c's camera scanner (`src/modules/scanner`) plugs into "Post erfassen"'s own page
      // (`src/app/(app)/dashboard/scan/page.tsx`'s "Kamera" tab), not a nav entry of its own.
      { href: "/dashboard/scan", labelKey: "scan" },
      // decisions/0075-email-intake.md: every member sees the address; only the admin changes it.
      { href: "/dashboard/email-intake", labelKey: "emailIntake" },
    ],
  },
  // "Finanzen" (`src/modules/accounts`/`src/modules/payments`, F2,
  // decisions/0024-accounts-and-transactions.md): admin-only end to end (both `finance.read`
  // and `finance.manage` are admin-only, unlike every other entry here whose underlying
  // capability has at least some non-admin action) - a bank statement exposes salaries and
  // other private debits. The three entries were an in-page tab bar until decisions/0055
  // promoted them here.
  {
    labelKey: "sections.money",
    items: [
      { href: "/dashboard/finance", labelKey: "accounts", permission: "finance.read" },
      { href: "/dashboard/finance/zuordnung", labelKey: "matching", permission: "finance.read" },
      { href: "/dashboard/finance/offene-posten", labelKey: "openItems", permission: "finance.read" },
    ],
  },
  // The month-end/year-end room (decisions/0066-abschluss-check-and-export.md): one page that
  // checks a period for completeness and exports it for the tax advisor. A standalone entry
  // rather than a section, because the check and the export are one workflow, not two rooms.
  { labelKey: null, items: [{ href: "/dashboard/abschluss", labelKey: "closing", permission: "finance.read" }] },
  { labelKey: null, items: [{ href: "/dashboard/contacts", labelKey: "contacts" }] },
  {
    labelKey: "sections.admin",
    items: [
      { href: "/dashboard/team", labelKey: "team" },
      { href: "/dashboard/settings/company", labelKey: "companySettings", permission: "company_profile.manage" },
      { href: "/dashboard/settings/intake", labelKey: "intakeSettings", permission: "intake.manage" },
      // "Tarif & Nutzung" (`src/modules/billing`, decisions/0017-billing-tiers-and-packages.md):
      // no `permission` - every workspace member may SEE this page, only `billing.manage`
      // (admin-only) may change anything on it (enforced by the page/actions themselves).
      { href: "/dashboard/billing", labelKey: "billing" },
    ],
  },
];

/**
 * The one entry that should render as active for `pathname`: the longest `href` that is either
 * the path itself or a prefix of it at a segment boundary. Longest-match is what keeps
 * `/dashboard/finance/zuordnung` from lighting up "Konten" (`/dashboard/finance`) as well, and
 * it is also why a page with no nav entry of its own falls back to its nearest ancestor:
 * `/dashboard/documents/<id>` marks "Posteingang", `/dashboard/finance/<accountId>` marks
 * "Konten". Returns `null` when nothing matches.
 */
export function activeNavHref(pathname: string, sections: readonly NavSection[] = NAV_SECTIONS): string | null {
  let active: string | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      if (item.href === null) continue;
      if (pathname !== item.href && !pathname.startsWith(`${item.href}/`)) continue;
      if (active === null || item.href.length > active.length) active = item.href;
    }
  }
  return active;
}

/**
 * Where a section's own heading navigates to when clicked: its first built route
 * (decisions/0057-sections-are-disclosures.md). `null` when every entry in the section is
 * still planned, and the heading then only opens and closes it.
 */
export function sectionTarget(section: NavSection): string | null {
  return section.items.find((item) => item.href !== null)?.href ?? null;
}

/**
 * The labelled section that owns `pathname`, which is the one that starts open. `null` when
 * the path belongs to a standalone entry (those are never inside a disclosure) or to nothing
 * in the nav at all.
 */
export function activeSectionKey(pathname: string, sections: readonly NavSection[] = NAV_SECTIONS): string | null {
  const active = activeNavHref(pathname, sections);
  if (active === null) return null;
  const owner = sections.find((section) => section.labelKey !== null && section.items.some((item) => item.href === active));
  return owner?.labelKey ?? null;
}

/**
 * `NAV_SECTIONS` with every entry the caller may not see removed, and every section that ends
 * up empty dropped along with its heading (display only, see this file's header).
 */
export function visibleNavSections(permissions: readonly Permission[], sections: readonly NavSection[] = NAV_SECTIONS): NavSection[] {
  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => !item.permission || permissions.includes(item.permission)) }))
    .filter((section) => section.items.length > 0);
}
