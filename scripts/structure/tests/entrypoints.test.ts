import { describe, expect, it } from "vitest";
import { entrypointsRule } from "../rules/entrypoints";
import { runFixture } from "./helpers";

describe("entrypoints rule", () => {
  it("passes correctly-directived index/client/server/actions files", () => {
    expect(runFixture(entrypointsRule, "entrypoints", "good")).toEqual([]);
  });

  it("flags a client.ts missing the \"use client\" directive", () => {
    const violations = runFixture(entrypointsRule, "entrypoints", "bad");
    expect(violations.some((v) => v.file === "src/modules/foo/client.ts" && v.message.includes("use client"))).toBe(true);
  });
});
