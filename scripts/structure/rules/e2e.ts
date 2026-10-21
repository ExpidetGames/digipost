/**
 * STRUCTURE.md §12: no `.spec.ts` file anywhere under tests/e2e/ (this covers
 * tests/e2e/serial/ too, not only the parallel default project; tests/e2e/helpers/ is excluded since it is
 * never itself a spec) may resolve an import, directly or transitively, following
 * only repo-relative/`@/`-alias imports, into a forbidden root - an e2e spec drives
 * the app over HTTP, never by importing a Next.js seam directly.
 */
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { toPosix, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";
import { chain, repoSourceFiles, walkGraph } from "../lib/module-graph";

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const forbidden = nonBlankLines(doc, "e2e").map((l) => l.trim().replace(/^forbid\s+/, ""));
  const violations: Violation[] = [];

  const specs = repoSourceFiles(ctx.root).filter((f) => {
    const rel = toPosix(ctx.root, f);
    return rel.startsWith("tests/e2e/") && !rel.startsWith("tests/e2e/helpers/") && rel.endsWith(".spec.ts");
  });

  for (const spec of specs) {
    const graph = walkGraph([spec], ctx.root);
    for (const file of graph.files) {
      const rel = toPosix(ctx.root, file);
      if (forbidden.some((f) => rel.startsWith(f))) {
        violations.push({
          rule: "e2e",
          file: toPosix(ctx.root, spec),
          message: `resolves into forbidden root "${rel}" (${chain(graph, file, ctx.root)}, STRUCTURE.md §12)`,
        });
      }
    }
  }
  return violations;
}

export const e2eRule: Rule = { name: "e2e", blockNames: ["e2e"], run };
