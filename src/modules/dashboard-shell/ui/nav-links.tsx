"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";

import type { Permission } from "@/platform/access";
import { cn } from "@/shared/ui-primitives";

import { activeNavHref, activeSectionKey, sectionTarget, visibleNavSections, type NavEntry } from "../core/nav-items";

/** A planned capability's badge (decisions/0055): a row, never a link. */
function SoonBadge({ label }: { label: string }) {
  return <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide">{label}</span>;
}

const ROW = "flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors";

export function NavLinks({
  onNavigate,
  className,
  permissions,
}: {
  onNavigate?: () => void;
  className?: string;
  /** Hides a permission-gated entry (e.g. "Zuständigkeiten") from anyone whose bundle does
   * not include it, and a whole section once nothing in it is left - display only,
   * `src/platform/access`'s own README. */
  permissions: readonly Permission[];
}) {
  const pathname = usePathname();
  const t = useTranslations("DashboardShell.nav");
  const sections = visibleNavSections(permissions);
  const active = activeNavHref(pathname);

  // decisions/0057-sections-are-disclosures.md: exactly one section is open, and by default it
  // is the one holding the current page. `opened` is the visitor's own override, remembered
  // together with the path it was made on, so any navigation falls back to the active section
  // again without an effect watching the router.
  const [opened, setOpened] = useState<{ forPath: string; key: string | null } | null>(null);
  const openKey = opened?.forPath === pathname ? opened.key : activeSectionKey(pathname);

  const renderEntry = (item: NavEntry, nested: boolean) => {
    if (item.href === null) {
      return (
        <p key={item.labelKey} className={cn(ROW, "text-muted-foreground/60", nested && "pl-6")}>
          <span>{t(item.labelKey)}</span>
          <SoonBadge label={t("soon")} />
        </p>
      );
    }
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={item.href === active ? "page" : undefined}
        className={cn(
          ROW,
          nested && "pl-6",
          item.href === active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        {t(item.labelKey)}
      </Link>
    );
  };

  return (
    <nav className={cn("flex flex-col gap-1", className)} aria-label={t("label")}>
      {sections.map((section, index) => {
        if (section.labelKey === null) return <div key={`standalone-${index}`}>{section.items.map((item) => renderEntry(item, false))}</div>;

        const key = section.labelKey;
        const isOpen = openKey === key;
        const target = sectionTarget(section);
        const holdsActive = section.items.some((item) => item.href === active);
        const panelId = `nav-section-${key.replace(/\./g, "-")}`;
        const headingClasses = cn(ROW, "flex-1 text-left", holdsActive ? "text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground");
        const toggle = () => setOpened({ forPath: pathname, key: isOpen ? null : key });

        // decisions/0057: two separate controls. The label goes into the section (and opens it
        // by arriving there); the chevron only opens and closes, so a user can look inside
        // without leaving the page they are on.
        const chevronButton = (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={isOpen}
            aria-controls={panelId}
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span className="sr-only">{t("toggleSection", { section: t(key) })}</span>
            <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 transition-transform", isOpen ? "rotate-0" : "-rotate-90")} />
          </button>
        );

        return (
          <div key={key} role="group" aria-label={t(key)}>
            <div className="flex items-center gap-1">
              {target === null ? (
                // Nothing in this section is built yet, so its label has nowhere to go: it
                // toggles like the chevron, and carries the badge itself.
                <button type="button" onClick={toggle} className={headingClasses}>
                  <span>{t(key)}</span>
                  <SoonBadge label={t("soon")} />
                </button>
              ) : (
                <Link
                  href={target}
                  onClick={() => {
                    setOpened({ forPath: target, key });
                    onNavigate?.();
                  }}
                  className={headingClasses}
                >
                  {t(key)}
                </Link>
              )}
              {chevronButton}
            </div>

            {isOpen ? (
              <div id={panelId} className="flex flex-col gap-1 pt-1">
                {section.items.map((item) => renderEntry(item, true))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
