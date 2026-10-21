/**
 * STRUCTURE.md §5: the root-to-root dependency matrix, the owner-public-entrypoint
 * boundary (crossing into a src/modules|shared|platform owner from outside must go
 * through index.ts/client.ts/server.ts/actions.ts, or a README-justified extra
 * entrypoint file, STRUCTURE.md §3), the persistence external door + narrow entries
 * (STRUCTURE.md §4's own targets, cross-checked here as import edges), and the two
 * `forbid` invariants.
 */
import path from "node:path";
import { nonBlankLines, splitRecords, type StructureDoc } from "../lib/doc-parser";
import { firstStatementLine, readCached, toPosix, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";
import { importSpecifiers, repoSourceFiles, resolveImport, walkGraph, type Graph } from "../lib/module-graph";
import { ownerReadmeMentions } from "./entrypoints";

type Category =
  | "app"
  | "modules"
  | "shared"
  | "platform"
  | "persistence"
  | "persistence-entry"
  | "persistence-narrow"
  | "persistence-internal"
  | "i18n"
  | "root-config"
  | "tests"
  | "integration-tests"
  | "scripts"
  | "e2e"
  | "e2e-helpers"
  | "other";

const OWNER_ENTRYPOINTS = new Set(["index.ts", "client.ts", "server.ts", "actions.ts"]);

function isOwnerEntrypoint(basename: string): boolean {
  return OWNER_ENTRYPOINTS.has(basename) || basename.endsWith("-actions.ts");
}

/** The `src/modules/<owner>` / `src/shared/<owner>` / `src/platform/<owner>` prefix
 *  of a path, or null if it is not under one of those three containers. */
function ownerOf(rel: string): string | null {
  const m = /^src\/(modules|shared|platform)\/([^/]+)\//.exec(rel);
  return m ? `src/${m[1]}/${m[2]}` : null;
}

type NarrowEntry = { target: string; importer: string[] };

function parseNarrowEntries(doc: StructureDoc): NarrowEntry[] {
  const records = doc.blocks.filter((b) => b.name === "narrow-entry").flatMap((b) => splitRecords(b.lines));
  return records.map((lines) => {
    const fields: Record<string, string> = {};
    let currentKey = "";
    for (const raw of lines) {
      const m = /^(target|owner|importer|reason)\s+(.*)$/.exec(raw.trim());
      if (m) {
        currentKey = m[1];
        fields[currentKey] = (fields[currentKey] ?? "") + m[2];
      } else if (currentKey) {
        fields[currentKey] += " " + raw.trim();
      }
    }
    return {
      target: fields.target ?? "",
      importer: (fields.importer ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  });
}

function matchesPathOrPrefix(rel: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return rel === prefix || rel.startsWith(prefix);
  }
  return rel === pattern;
}

function persistenceEntryTargets(entryLines: string[]): (rel: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const line of entryLines) {
    const l = line.trim();
    if (l.endsWith("/")) prefixes.push(`src/persistence/${l}`);
    else exact.add(`src/persistence/${l}`);
  }
  return (rel: string) => exact.has(rel) || prefixes.some((p) => rel.startsWith(p));
}

function classify(rel: string, entryMatcher: (rel: string) => boolean, narrowEntries: NarrowEntry[]): Category {
  // tests/e2e/ and tests/integration/ get their own categories first; after that, a
  // `tests/` path segment anywhere (tests/config/, owner-local src/modules/x/tests/,
  // src/platform/x/tests/, src/shared/x/tests/, src/persistence/tests/, or
  // scripts/structure/tests/) gets test-level import latitude, checked before any
  // owner/root-specific classification below.
  if (rel.startsWith("tests/e2e/helpers/")) return "e2e-helpers";
  if (rel.startsWith("tests/e2e/")) return "e2e";
  if (rel.startsWith("tests/integration/")) return "integration-tests";
  if (rel.split("/").includes("tests")) return "tests";

  if (rel.startsWith("src/app/")) return "app";
  if (rel.startsWith("src/modules/")) return "modules";
  if (rel.startsWith("src/shared/")) return "shared";
  if (rel.startsWith("src/platform/")) return "platform";
  if (rel.startsWith("src/i18n/")) return "i18n";
  if (rel.startsWith("scripts/")) return "scripts";
  if (rel.startsWith("src/persistence/")) {
    if (narrowEntries.some((n) => matchesPathOrPrefix(rel, n.target))) return "persistence-narrow";
    if (entryMatcher(rel)) return "persistence-entry";
    return "persistence-internal";
  }
  // Repo-root config files (next.config.ts, drizzle.config.ts, ...) and the Next.js
  // convention files directly under src/ (src/proxy.ts, instrumentation*.ts, the Sentry
  // configs): both are framework-wired entry files, not owner code.
  if (!rel.includes("/") || /^src\/[^/]+$/.test(rel)) return "root-config";
  return "other";
}

/** Collapses persistence's fine-grained target sub-categories (entry/narrow/
 *  internal - needed for target-side checks) to the one "persistence" row the
 *  ```structure direction block declares as a *source* - internal persistence-to-
 *  persistence layering is the `persistence` rule's job, not this one's. */
function topRoot(category: Category): Category {
  return category.startsWith("persistence") ? "persistence" : category;
}

function importerAllowedForNarrow(importerRel: string, narrow: NarrowEntry): boolean {
  return narrow.importer.some((pat) => matchesPathOrPrefix(importerRel, pat));
}

function parseMatrix(doc: StructureDoc): { matrix: Map<Category, Set<Category>>; forbids: Set<string> } {
  const matrix = new Map<Category, Set<Category>>();
  const forbids = new Set<string>();
  for (const line of nonBlankLines(doc, "direction")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "forbid") {
      forbids.add(parts[1]);
      continue;
    }
    if (parts[0] !== "may-import") continue;
    const src = parts[1] as Category;
    matrix.set(src, new Set(parts.slice(2) as Category[]));
  }
  return { matrix, forbids };
}

/** Owner root of `rel`, given as an absolute directory, for README-justification lookups. */
function ownerDirOf(root: string, rel: string): string | null {
  const owner = ownerOf(rel);
  return owner ? path.join(root, owner) : null;
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const { root } = ctx;
  const { matrix } = parseMatrix(doc);
  const entryLines = nonBlankLines(doc, "persistence-entry");
  const entryMatcher = persistenceEntryTargets(entryLines);
  const narrowEntries = parseNarrowEntries(doc);
  const violations: Violation[] = [];

  const graph = walkGraph(entryFiles(root), root);

  for (const file of graph.files) {
    const rel = toPosix(root, file);
    const srcCategoryRaw = classify(rel, entryMatcher, narrowEntries);
    if (srcCategoryRaw === "other") continue;
    const srcCategory = topRoot(srcCategoryRaw);

    const source = readCached(file);
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveImport(spec, file, root);
      if (resolved.kind !== "file") continue;
      const targetRel = toPosix(root, resolved.file);
      const targetCategory = classify(targetRel, entryMatcher, narrowEntries);
      if (targetCategory === "other") continue;
      if (topRoot(srcCategoryRaw) === topRoot(targetCategory)) continue; // same-root: governed by a different rule, or trivially fine

      // src/proxy.ts: no persistence at all, not even the entry/narrow door.
      if (rel === "src/proxy.ts" && targetCategory.startsWith("persistence")) {
        violations.push({
          rule: "direction",
          file: rel,
          message: `src/proxy.ts must not import src/persistence/** at all (found "${spec}" -> ${targetRel}, STRUCTURE.md §4/§5)`,
        });
        continue;
      }

      // A narrow-entry target: allowed only for its declared importer(s) - except
      // for test code, which legitimately imports these exact internals directly
      // to test them, and falls through to the ordinary matrix below instead.
      const narrow = narrowEntries.find((n) => matchesPathOrPrefix(targetRel, n.target));
      if (narrow && srcCategory !== "tests" && srcCategory !== "integration-tests" && srcCategory !== "e2e-helpers") {
        if (!importerAllowedForNarrow(rel, narrow)) {
          violations.push({
            rule: "direction",
            file: rel,
            message: `imports narrow entry ${targetRel} ("${spec}") but is not among its declared importers (STRUCTURE.md §4)`,
          });
        }
        continue;
      }

      // Owner public-entrypoint boundary: crossing into a src/modules|shared|platform
      // owner from a different owner (or from outside entirely) must land on that
      // owner's public entrypoint file, or on an extra top-level file its own
      // README names (STRUCTURE.md §3's "weitere Subpaths ... nur mit Begründung im
      // Owner-README", e.g. src/platform/auth/proxy-gate.ts, imported by src/proxy.ts).
      const targetOwner = ownerOf(targetRel);
      if (targetOwner) {
        const srcOwner = ownerOf(rel);
        if (srcOwner !== targetOwner) {
          const basename = path.basename(targetRel);
          const targetOwnerDir = ownerDirOf(root, targetRel);
          const isJustifiedExtra =
            targetOwnerDir !== null && path.dirname(targetRel) === targetOwner && ownerReadmeMentions(targetOwnerDir, basename);
          if (!isOwnerEntrypoint(basename) && !isJustifiedExtra) {
            violations.push({
              rule: "direction",
              file: rel,
              message: `imports ${targetRel} ("${spec}") directly, bypassing ${targetOwner}'s public entrypoint (STRUCTURE.md §3/§5)`,
            });
            continue;
          }
        }
      }

      const allowed = matrix.get(srcCategory);
      if (!allowed || !allowed.has(targetCategory)) {
        violations.push({
          rule: "direction",
          file: rel,
          message: `"${srcCategory}" may not import "${targetCategory}" (${targetRel} via "${spec}", STRUCTURE.md §5)`,
        });
      }
    }
  }

  violations.push(...clientReachViolations(graph, root));
  return violations;
}

/** Every source file under the repo, used as walk seeds so every edge gets checked
 *  from its own file. */
function entryFiles(root: string): string[] {
  return repoSourceFiles(root);
}

/**
 * A file is a client entrypoint if its own first statement is the "use client"
 * directive - not merely because it is a `.tsx` file somewhere under `src/app/**` or a
 * module's `ui/`, most of which are ordinary React Server Components (the Next.js
 * default) that legitimately import server-only code directly.
 */
function isClientEntry(file: string, root: string): boolean {
  const rel = toPosix(root, file);
  if (!(rel.endsWith(".tsx") || rel.endsWith(".jsx") || path.basename(rel) === "client.ts")) return false;
  const first = firstStatementLine(readCached(file));
  return first === '"use client";' || first === "'use client';";
}

/** A boundary file's own further imports are not followed - Next replaces a Server
 *  Function's body with an RPC stub in the client bundle, so a client file
 *  importing actions.ts never actually pulls its implementation in. */
function isBoundary(rel: string): boolean {
  const basename = path.basename(rel);
  return basename === "actions.ts" || basename.endsWith("-actions.ts");
}

function clientReachViolations(graph: Graph, root: string): Violation[] {
  const seeds = [...graph.files].filter((f) => isClientEntry(f, root));
  const seen = new Set<string>();
  const violations: Violation[] = [];
  const queue = [...seeds];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = toPosix(root, file);
    const source = readCached(file);
    if (/^import\s+["']server-only["']/m.test(source)) {
      violations.push({
        rule: "direction",
        file: rel,
        message: "reachable from a client entrypoint but imports server-only (STRUCTURE.md §5 forbid client-reachable-reaches-privileged)",
      });
    }
    if (path.basename(rel) === "server.ts" && ownerOf(rel) !== null) {
      violations.push({
        rule: "direction",
        file: rel,
        message: "server.ts entrypoint is reachable from a client entrypoint (STRUCTURE.md §5 forbid client-reachable-reaches-privileged)",
      });
    }
    if (isBoundary(rel)) continue;
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveImport(spec, file, root);
      if (resolved.kind === "file") queue.push(resolved.file);
    }
  }
  return violations;
}

export const directionRule: Rule = {
  name: "direction",
  blockNames: ["direction", "persistence-entry", "narrow-entry"],
  run,
};
