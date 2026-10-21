/**
 * STRUCTURE.md §4: internal src/persistence/** layering (foundation < repositories <
 * use-cases < composition, a file imports its own rank or lower, never higher).
 * `src/persistence/tests/**` is exempt (may import any rank, like any test).
 */
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { readCached, toPosix, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";
import { importSpecifiers, repoSourceFiles, resolveImport } from "../lib/module-graph";

const PERSISTENCE = "src/persistence/";

/** `schema/`, `sql/` and `migrations/` are foundation-rank (STRUCTURE.md §4: "schema
 *  is what foundation's client is built against"). */
function rankOf(persistenceRelPath: string, ranks: string[]): number | null {
  const top = persistenceRelPath.split("/")[0];
  const rankName = top === "schema" || top === "sql" || top === "migrations" || top === "seed" ? "foundation" : top;
  const idx = ranks.indexOf(rankName);
  return idx === -1 ? null : idx;
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const { root } = ctx;
  const ranks = nonBlankLines(doc, "persistence-layers").map((l) => l.trim());
  const violations: Violation[] = [];

  for (const file of repoSourceFiles(root)) {
    const rel = toPosix(root, file);
    if (!rel.startsWith(PERSISTENCE)) continue;
    const inner = rel.slice(PERSISTENCE.length);
    if (inner.startsWith("tests/")) continue;
    const srcRank = rankOf(inner, ranks);
    if (srcRank === null) continue; // not a ranked kind (e.g. a stray non-code file)

    const source = readCached(file);
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveImport(spec, file, root);
      if (resolved.kind !== "file") continue;
      const targetRel = toPosix(root, resolved.file);
      if (!targetRel.startsWith(PERSISTENCE)) continue;
      const targetInner = targetRel.slice(PERSISTENCE.length);
      if (targetInner.startsWith("tests/")) continue;
      const targetRank = rankOf(targetInner, ranks);
      if (targetRank === null) continue;
      if (targetRank > srcRank) {
        violations.push({
          rule: "persistence",
          file: rel,
          message: `rank "${ranks[srcRank]}" imports higher rank "${ranks[targetRank]}" (${targetRel} via "${spec}", STRUCTURE.md §4)`,
        });
      }
    }
  }
  return violations;
}

export const persistenceRule: Rule = { name: "persistence", blockNames: ["persistence-layers"], run };
