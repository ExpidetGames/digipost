// @vitest-environment jsdom
// Client-component unit test (WEBAPP_TEMPLATE_SPEC.md §10.2): Testing Library + jsdom, the
// Server Action mocked at the module path the component actually imports.
// decisions/0070-several-workspaces-per-user.md: this is the first piece of logic this shell
// owns beyond its mobile-nav toggle, so it gets a test here (its own README said to add one
// when that changed).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const switchMock = vi.fn();
vi.mock("@/modules/workspaces/actions", () => ({
  switchWorkspaceAction: (input: unknown) => switchMock(input),
}));

import { WorkspaceSwitcher } from "../ui/workspace-switcher";

const messages = {
  DashboardShell: {
    workspaceSwitcher: {
      toggle: "Firma wechseln",
      createAnother: "Weitere Firma anlegen",
      errors: { not_found: "Diese Firma steht Ihnen nicht zur Verfügung.", unknown: "Etwas ist schiefgelaufen." },
    },
  },
};

const FIRST = { id: "11111111-1111-4111-8111-111111111111", name: "Erste GmbH" };
const SECOND = { id: "22222222-2222-4222-8222-222222222222", name: "Zweite GmbH" };

function renderSwitcher(workspaces: { id: string; name: string }[], activeWorkspaceId = FIRST.id) {
  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <WorkspaceSwitcher
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        workspaceName={active?.name ?? "Erste GmbH"}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  switchMock.mockReset();
});

describe("WorkspaceSwitcher", () => {
  it("renders the plain workspace name, with no control, for a user with a single workspace", () => {
    renderSwitcher([FIRST]);

    expect(screen.getByText("Erste GmbH")).toBeTruthy();
    expect(screen.queryByText("Weitere Firma anlegen")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists every workspace, marks the active one, and offers creating another", () => {
    renderSwitcher([FIRST, SECOND]);

    expect(screen.getByRole("button", { name: /Zweite GmbH/ })).toBeTruthy();
    const activeEntry = screen.getByRole("button", { name: /Erste GmbH/ });
    expect(activeEntry.getAttribute("aria-current")).toBe("true");
    // The active workspace is not a switch target: switching to where you already are would
    // only cost a round trip.
    expect((activeEntry as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Weitere Firma anlegen" }).getAttribute("href")).toBe("/onboarding");
  });

  it("submits the chosen workspace's id to the Server Action", async () => {
    switchMock.mockResolvedValue({ status: "success", data: undefined });
    renderSwitcher([FIRST, SECOND]);

    fireEvent.click(screen.getByRole("button", { name: /Zweite GmbH/ }));

    await waitFor(() => expect(switchMock).toHaveBeenCalledWith({ workspaceId: SECOND.id }));
  });

  it("surfaces the action's stable error code as German copy", async () => {
    switchMock.mockResolvedValue({ status: "error", errorCode: "not_found" });
    renderSwitcher([FIRST, SECOND]);

    fireEvent.click(screen.getByRole("button", { name: /Zweite GmbH/ }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Diese Firma steht Ihnen nicht zur Verfügung."));
  });
});
