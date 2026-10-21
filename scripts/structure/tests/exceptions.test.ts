import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStructureDoc } from "../lib/doc-parser";
import { filterExceptions, parseExceptions, staleExceptions } from "../lib/exceptions";

const here = path.dirname(fileURLToPath(import.meta.url));
const scratchRoot = path.join(here, "fixtures", "exceptions-scratch");

function writeDoc(text: string): string {
  const file = path.join(scratchRoot, "structure.md");
  writeFileSync(file, text);
  return file;
}

describe("exceptions", () => {
  beforeEach(() => {
    mkdirSync(scratchRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("parses a well-formed exceptions block", () => {
    const file = writeDoc("```structure exceptions\nfoo/** | a reason | remove by: never\n```\n");
    const doc = parseStructureDoc(file);
    const exceptions = parseExceptions(doc);
    expect(exceptions).toEqual([{ pattern: "foo/**", reason: "a reason", removeBy: "remove by: never" }]);
  });

  it("throws on a malformed exceptions line (wrong field count)", () => {
    const file = writeDoc("```structure exceptions\nfoo/** | only one field\n```\n");
    const doc = parseStructureDoc(file);
    expect(() => parseExceptions(doc)).toThrow();
  });

  it("filters violations matching an exception pattern", () => {
    const exceptions = [{ pattern: "foo/**", reason: "r", removeBy: "never" }];
    const violations = [
      { rule: "roots", file: "foo/bar.ts", message: "m" },
      { rule: "roots", file: "baz.ts", message: "m" },
    ];
    expect(filterExceptions(violations, exceptions)).toEqual([{ rule: "roots", file: "baz.ts", message: "m" }]);
  });

  it("flags an exception whose pattern matches nothing in the repository as stale", () => {
    writeFileSync(path.join(scratchRoot, "real-file.ts"), "export {};\n");
    const exceptions = [
      { pattern: "real-file.ts", reason: "r", removeBy: "never" },
      { pattern: "nothing-here/**", reason: "r", removeBy: "never" },
    ];
    const stale = staleExceptions(exceptions, scratchRoot);
    expect(stale.map((e) => e.pattern)).toEqual(["nothing-here/**"]);
  });
});
