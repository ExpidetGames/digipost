import { describe, expect, it } from "vitest";
import { envAccessRule } from "../rules/env-access";
import { runFixture } from "./helpers";

describe("env-access rule", () => {
  it("passes a named variable read in its declared prefix", () => {
    expect(runFixture(envAccessRule, "env-access", "good")).toEqual([]);
  });

  it("flags the same variable read outside its declared prefix", () => {
    const violations = runFixture(envAccessRule, "env-access", "bad");
    expect(violations.some((v) => v.file === "src/modules/foo/index.ts" && v.message.includes("SECRET_TOKEN"))).toBe(true);
  });
});
