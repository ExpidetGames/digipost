/**
 * STRUCTURE.md §6: exactly one file may declare `cache(createRequestServices)`.
 */
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { readCached, toPosix, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";
import { repoSourceFiles } from "../lib/module-graph";

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const fields = new Map<string, string>();
  for (const line of nonBlankLines(doc, "request-services")) {
    const [key, ...rest] = line.trim().split(/\s+/);
    fields.set(key, rest.join(" "));
  }
  const pattern = fields.get("pattern") ?? "cache(createRequestServices)";
  const allowed = fields.get("allowed") ?? "";

  const violations: Violation[] = [];
  const declarers: string[] = [];
  for (const file of repoSourceFiles(ctx.root)) {
    const rel = toPosix(ctx.root, file);
    // The checker's own source necessarily mentions the pattern string as data,
    // not as a declaration of it - exclude it from the scan of product code.
    if (rel.startsWith("scripts/structure/")) continue;
    const source = readCached(file);
    if (source.includes(pattern)) declarers.push(rel);
  }

  for (const rel of declarers) {
    if (rel !== allowed) {
      violations.push({
        rule: "request-services",
        file: rel,
        message: `declares "${pattern}" but only ${allowed} may (STRUCTURE.md §6)`,
      });
    }
  }
  if (declarers.length === 0) {
    violations.push({
      rule: "request-services",
      file: allowed,
      message: `no file declares "${pattern}" (expected exactly one, at ${allowed})`,
    });
  }
  return violations;
}

export const requestServicesRule: Rule = { name: "request-services", blockNames: ["request-services"], run };
