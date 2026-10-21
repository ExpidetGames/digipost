"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { switchWorkspaceAction } from "@/modules/workspaces/actions";
import { cn } from "@/shared/ui-primitives";

export type SwitchableWorkspace = { id: string; name: string };

/** Derived from the action itself rather than imported from `src/modules/workspaces`'
 * `core/error-codes.ts`: that file is not one of that owner's public entrypoints, and this
 * way the union can never drift from what the action can actually return. */
type SwitchErrorCode = Extract<Awaited<ReturnType<typeof switchWorkspaceAction>>, { status: "error" }>["errorCode"];

type SwitchState = { errorCode: SwitchErrorCode } | null;

/**
 * "Firma wechseln" (decisions/0070-several-workspaces-per-user.md): the sidebar's workspace
 * name becomes a disclosure listing every workspace the signed-in user belongs to, marking
 * the active one, plus a link to `/onboarding` for a further company.
 *
 * Built on `<details>`/`<summary>` and one plain `<form>` per workspace rather than a
 * JS-driven menu: the whole thing is keyboard reachable and works before hydration, and this
 * shell keeps its single piece of client state (the mobile-nav toggle) instead of gaining a
 * second one. `useActionState` exists only to surface the server's own error code - the happy
 * path is a `redirect()` the browser follows on its own.
 *
 * A single-workspace user sees exactly what they saw before this phase: the plain workspace
 * name, no control at all.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  workspaceName,
  className,
}: {
  workspaces: readonly SwitchableWorkspace[];
  activeWorkspaceId: string;
  workspaceName: string;
  className?: string;
}) {
  const t = useTranslations("DashboardShell.workspaceSwitcher");
  const tErrors = useTranslations("DashboardShell.workspaceSwitcher.errors");

  const [state, formAction] = useActionState<SwitchState, FormData>(async (_previous, formData) => {
    const result = await switchWorkspaceAction({ workspaceId: formData.get("workspaceId") });
    // Success never gets here: the action redirects, which React surfaces as a navigation,
    // not as a returned value.
    return result.status === "error" ? { errorCode: result.errorCode } : null;
  }, null);

  if (workspaces.length < 2) {
    return <span className={cn("text-sm text-muted-foreground", className)}>{workspaceName}</span>;
  }

  return (
    <details className={cn("group", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span className="truncate">{workspaceName}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">{t("toggle")}</span>
      </summary>

      <ul className="mt-2 flex flex-col gap-0.5 border-l border-border pl-2">
        {workspaces.map((workspace) => {
          const isActive = workspace.id === activeWorkspaceId;
          return (
            <li key={workspace.id}>
              <form action={formAction}>
                <input type="hidden" name="workspaceId" value={workspace.id} />
                <button
                  type="submit"
                  disabled={isActive}
                  aria-current={isActive ? "true" : undefined}
                  className="flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left text-sm text-muted-foreground hover:text-foreground disabled:cursor-default disabled:text-foreground"
                >
                  <Check aria-hidden className={cn("size-3.5 shrink-0", isActive ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{workspace.name}</span>
                </button>
              </form>
            </li>
          );
        })}
        <li>
          <a
            href="/onboarding"
            className="flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <Plus aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{t("createAnother")}</span>
          </a>
        </li>
      </ul>

      {state ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {tErrors(state.errorCode)}
        </p>
      ) : null}
    </details>
  );
}
