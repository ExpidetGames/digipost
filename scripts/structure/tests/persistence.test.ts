import { describe, expect, it } from "vitest";
import { persistenceRule } from "../rules/persistence";
import { runFixture } from "./helpers";

describe("persistence rule", () => {
  it("passes a lower rank importing a higher rank", () => {
    expect(runFixture(persistenceRule, "persistence", "good")).toEqual([]);
  });

  it("flags foundation importing use-cases (a higher rank)", () => {
    const violations = runFixture(persistenceRule, "persistence", "bad");
    expect(violations.some((v) => v.file === "src/persistence/foundation/client.ts" && v.message.includes("higher rank"))).toBe(true);
  });
});
