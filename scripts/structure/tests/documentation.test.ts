import { describe, expect, it } from "vitest";
import { documentationRule } from "../rules/documentation";
import { runFixture } from "./helpers";

describe("documentation rule", () => {
  it("passes a document with every metadata key and resolving links", () => {
    expect(runFixture(documentationRule, "documentation", "good")).toEqual([]);
  });

  it("flags a required document missing a metadata key", () => {
    const violations = runFixture(documentationRule, "documentation", "bad");
    expect(violations.some((v) => v.file === "README.md" && v.message.includes("Owner:"))).toBe(true);
  });
});
