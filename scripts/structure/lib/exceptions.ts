/**
 * STRUCTURE.md §13 "Exceptions": `<path or glob> | <reason> | <remove-by note>`
 * lines inside a ```structure exceptions block. Not a rule (no scanning of its
 * own) - data every other rule's violations are filtered through, plus one
 * self-check (a stale exception is a hard error, STRUCTURE.md §13).
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { nonBlankLines, type StructureDoc } from "./doc-parser";
import { matchesPattern, type Violation } from "./repo";
import { repoSourceFiles } from "./module-graph";

export type Exception = { pattern: string; reason: string; removeBy: string };

export function parseExceptions(doc: StructureDoc): Exception[] {
  return nonBlankLines(doc, "exceptions").map((line, i) => {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 3) {
      throw new Error(`STRUCTURE.md exceptions block, entry ${i + 1}: expected "<path> | <reason> | <remove-by>", got: ${line}`);
    }
    const [pattern, reason, removeBy] = parts;
    return { pattern, reason, removeBy };
  });
}

/** Removes violations whose `file` matches any exception pattern. */
export function filterExceptions(violations: Violation[], exceptions: Exception[]): Violation[] {
  return violations.filter((v) => !exceptions.some((e) => matchesPattern(v.file, e.pattern)));
}

/**
 * An exception is stale if nothing in the repository matches its pattern anymore (an
 * exact file that no longer exists, or a `/**`/`/*` prefix under which no file
 * exists). Checked against the real repo root regardless of which root a given
 * rule's fixtures used, since exceptions are a whole-repo concept.
 */
export function staleExceptions(exceptions: Exception[], root: string): Exception[] {
  const files = repoSourceFiles(root).map((f) => path.relative(root, f).split(path.sep).join("/"));
  return exceptions.filter((e) => {
    if (e.pattern.endsWith("/**") || e.pattern.endsWith("/*") || e.pattern.endsWith("/")) {
      return !files.some((f) => matchesPattern(f, e.pattern)) && !dirExists(root, e.pattern);
    }
    return !existsSync(path.join(root, e.pattern));
  });
}

function dirExists(root: string, pattern: string): boolean {
  const prefix = pattern.replace(/\/\*\*$|\/\*$|\/$/, "");
  const p = path.join(root, prefix);
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
