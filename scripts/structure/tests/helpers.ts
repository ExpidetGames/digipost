/**
 * Shared helper for the structure checker's own fixture tests. Each rule's fixture
 * directory (`scripts/structure/tests/fixtures/<rule>/`) carries its own tiny
 * `structure.md` (only the block(s) that rule needs, kept independent of the real
 * repository STRUCTURE.md so these tests do not break when that document's own
 * content changes) plus `good/` and `bad/` subdirectories used as the rule's `root`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStructureDoc } from "../lib/doc-parser";
import type { Violation } from "../lib/repo";
import type { Rule } from "../lib/rule";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, "fixtures");

export function runFixture(rule: Rule, ruleDir: string, variant: "good" | "bad"): Violation[] {
  const dir = path.join(FIXTURES_DIR, ruleDir);
  const doc = parseStructureDoc(path.join(dir, "structure.md"));
  return rule.run(doc, { root: path.join(dir, variant) });
}
