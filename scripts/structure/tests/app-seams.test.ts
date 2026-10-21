import { describe, expect, it } from "vitest";
import { appSeamsRule } from "../rules/app-seams";
import { runFixture } from "./helpers";

describe("app-seams rule", () => {
  it("passes declared Next.js convention filenames, and exempts _private segments", () => {
    expect(runFixture(appSeamsRule, "app-seams", "good")).toEqual([]);
  });

  it("flags a non-convention filename directly under src/app/", () => {
    const violations = runFixture(appSeamsRule, "app-seams", "bad");
    expect(violations.some((v) => v.file === "src/app/dashboard/helpers.ts")).toBe(true);
  });
});
