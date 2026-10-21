// @vitest-environment jsdom
// No `@testing-library/jest-dom` in this repository's dependencies (only
// `@testing-library/react` is installed, see src/modules/workspaces/tests/onboarding-form.test.tsx
// for the established pattern): presence/absence is asserted via `getByText`/`queryByText`
// (the former throws if missing, the latter returns `null`) rather than `.toBeInTheDocument()`,
// and DOM attributes are read with `.getAttribute()` rather than `.toHaveAttribute()`.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FaqAccordion, type FaqItem } from "../faq-accordion";

const items: FaqItem[] = [
  { id: "a", question: "Question A", answer: "Answer A" },
  { id: "b", question: "Question B", answer: "Answer B" },
];

afterEach(() => {
  cleanup();
});

describe("FaqAccordion", () => {
  it("starts with every answer collapsed", () => {
    render(<FaqAccordion items={items} />);

    expect(screen.queryByText("Answer A")).toBeNull();
    expect(screen.queryByText("Answer B")).toBeNull();
    expect(screen.getByRole("button", { name: /Question A/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the clicked item and keeps only one item open at a time", () => {
    render(<FaqAccordion items={items} />);

    fireEvent.click(screen.getByRole("button", { name: /Question A/ }));
    expect(screen.getByText("Answer A")).not.toBeNull();
    expect(screen.queryByText("Answer B")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Question B/ }));
    expect(screen.getByText("Answer B")).not.toBeNull();
    expect(screen.queryByText("Answer A")).toBeNull();
    expect(screen.getByRole("button", { name: /Question A/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /Question B/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("closes the open item when clicked again", () => {
    render(<FaqAccordion items={items} />);

    fireEvent.click(screen.getByRole("button", { name: /Question A/ }));
    expect(screen.getByText("Answer A")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Question A/ }));
    expect(screen.queryByText("Answer A")).toBeNull();
  });
});
