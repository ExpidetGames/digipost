"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Menu, X } from "lucide-react";

import type { Permission } from "@/platform/access";
import { Button } from "@/shared/ui-primitives";
import { signOutAction } from "@/modules/sign-in/actions";

import { NavLinks } from "./nav-links";
import { WorkspaceSwitcher, type SwitchableWorkspace } from "./workspace-switcher";

/**
 * The authenticated, workspace-scoped app frame: a fixed sidebar on desktop, a toggled
 * panel on mobile (WEBAPP_TEMPLATE_SPEC.md §8's responsive rule), and a header with the
 * signed-in user's email and sign-out. `src/app/(app)/layout.tsx` (the seam) does the real
 * session+tenancy check (`requireWorkspaceMember()`) and passes only the resulting email,
 * workspace name, and permission bundle down; this component owns no auth logic of its own.
 *
 * `workspaces`/`activeWorkspaceId` (decisions/0070-several-workspaces-per-user.md) feed the
 * workspace switcher that replaces the plain workspace name wherever it appears. They are
 * display data only: switching goes through `src/modules/workspaces`' own Server Action,
 * which re-checks the membership server-side.
 */
export function DashboardShell({
  userEmail,
  workspaceName,
  activeWorkspaceId,
  workspaces,
  permissions,
  children,
}: {
  userEmail: string;
  workspaceName: string;
  activeWorkspaceId: string;
  workspaces: readonly SwitchableWorkspace[];
  permissions: readonly Permission[];
  children: React.ReactNode;
}) {
  const t = useTranslations("DashboardShell");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      {/* The sidebar stays put while the page scrolls.
          `self-start` is what makes `sticky` work at all here: a flex item stretches to the
          row's full height by default, and an element as tall as its container has nowhere to
          stick to. `h-screen` plus its own `overflow-y-auto` then keeps a long nav reachable
          instead of cutting it off. */}
      <aside className="hidden w-56 shrink-0 flex-col gap-6 border-r border-border p-4 md:sticky md:top-0 md:flex md:h-screen md:self-start md:overflow-y-auto">
        <div className="flex flex-col gap-0.5">
          {/* The wordmark is the serif, here as on the marketing page: one brand
              (decisions/0056-paper-brand.md). */}
          <span className="font-heading text-xl font-medium text-foreground">{t("appName")}</span>
          <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} workspaceName={workspaceName} />
        </div>
        <NavLinks permissions={permissions} />
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-expanded={mobileNavOpen}
              aria-controls="dashboard-mobile-nav"
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              <span className="sr-only">{t("toggleNav")}</span>
              {mobileNavOpen ? <X aria-hidden /> : <Menu aria-hidden />}
            </Button>
            <div className="flex flex-col md:hidden">
              <span className="font-heading text-base font-medium text-foreground">{t("appName")}</span>
              <WorkspaceSwitcher
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                workspaceName={workspaceName}
                className="text-xs"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{userEmail}</span>
            <form action={signOutAction}>
              <Button type="submit" variant="outline" size="sm">
                {t("signOut")}
              </Button>
            </form>
          </div>
        </header>

        {mobileNavOpen ? (
          <div id="dashboard-mobile-nav" className="border-b border-border p-4 md:hidden">
            <NavLinks onNavigate={() => setMobileNavOpen(false)} permissions={permissions} />
          </div>
        ) : null}

        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">{children}</main>
      </div>
    </div>
  );
}
