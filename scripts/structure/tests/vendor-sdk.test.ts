import { describe, expect, it } from "vitest";
import { vendorSdkRule } from "../rules/vendor-sdk";
import { runFixture } from "./helpers";

describe("vendor-sdk rule", () => {
  it("passes a vendor SDK imported from its declared owner prefix", () => {
    expect(runFixture(vendorSdkRule, "vendor-sdk", "good")).toEqual([]);
  });

  it("flags the same SDK imported outside its declared owner prefix", () => {
    const violations = runFixture(vendorSdkRule, "vendor-sdk", "bad");
    expect(violations.some((v) => v.file === "src/modules/foo/index.ts" && v.message.includes("sonner"))).toBe(true);
  });
});
