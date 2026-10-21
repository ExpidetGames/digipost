import { describe, expect, it } from "vitest";

import { safeNextPath } from "../core/safe-next-path";

describe("safeNextPath", () => {
  it("passes through a plain relative path", () => {
    expect(safeNextPath("/dashboard/settings")).toBe("/dashboard/settings");
  });

  it("passes through a relative path with a query string", () => {
    expect(safeNextPath("/dashboard/domains/new?import=example.com")).toBe(
      "/dashboard/domains/new?import=example.com",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(safeNextPath("  /dashboard  ")).toBe("/dashboard");
  });

  it("falls back to /dashboard for null", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
  });

  it("falls back to /dashboard for undefined", () => {
    expect(safeNextPath(undefined)).toBe("/dashboard");
  });

  it("falls back to /dashboard for an empty string", () => {
    expect(safeNextPath("")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a value that does not start with /", () => {
    expect(safeNextPath("dashboard")).toBe("/dashboard");
  });

  it("falls back to /dashboard for an absolute URL", () => {
    expect(safeNextPath("https://evil.example.com")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a protocol-relative URL (//)", () => {
    expect(safeNextPath("//evil.example.com")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a backslash trick (/\\evil.com)", () => {
    expect(safeNextPath("/\\evil.example.com")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a javascript: URL", () => {
    expect(safeNextPath("javascript:alert(1)")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a value containing control characters", () => {
    expect(safeNextPath("/dashboard\n/evil")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a non-string value", () => {
    expect(safeNextPath(42 as unknown as string)).toBe("/dashboard");
  });
});
