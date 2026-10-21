import { describe, expect, it } from "vitest";
import { requestServicesRule } from "../rules/request-services";
import { runFixture } from "./helpers";

describe("request-services rule", () => {
  it("passes when only the allowed file declares the pattern", () => {
    expect(runFixture(requestServicesRule, "request-services", "good")).toEqual([]);
  });

  it("flags a second file declaring the pattern", () => {
    const violations = runFixture(requestServicesRule, "request-services", "bad");
    expect(violations.some((v) => v.file === "src/modules/foo/server.ts")).toBe(true);
  });
});
