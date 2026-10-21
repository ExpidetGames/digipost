/**
 * Runs the whole checker against the real, current STRUCTURE.md and repository
 * root - the same thing `pnpm verify:structure` does. If this fails, the repository
 * itself has a structural violation (or STRUCTURE.md and `scripts/structure/rules/`
 * have drifted out of the 1:1 block/rule correspondence §0 requires); a fixture-only
 * test suite could pass while the real repository is red.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULES, runChecker, symmetryErrors } from "../verify-structure";
import { parseStructureDoc } from "../lib/doc-parser";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STRUCTURE_MD = path.join(REPO_ROOT, "STRUCTURE.md");

describe("verify-structure against the real repository", () => {
  it("has no block/rule-name asymmetry", () => {
    const doc = parseStructureDoc(STRUCTURE_MD);
    expect(symmetryErrors(doc.names, RULES)).toEqual([]);
  });

  it("reports zero violations for the real repository tree", () => {
    const { ok, output } = runChecker(STRUCTURE_MD, REPO_ROOT);
    expect(output).toEqual([]);
    expect(ok).toBe(true);
  });
});
