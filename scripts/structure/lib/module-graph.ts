/**
 * Small static module-graph walker for `scripts/structure/**`'s rules. Resolves
 * relative and `@/`-alias imports (`tsconfig.json`'s `paths: { "@/*": ["./src/*"] }`) to
 * files inside the repository, records bare package specifiers without descending
 * into `node_modules`. Self-contained: this template has no pre-existing
 * `tests/guards/lib/module-graph.ts` to build on (unlike a project that already had
 * import-graph guard tests, decisions/0001... see this task's own ADR), so every rule
 * that needs import resolution imports this file instead of a second copy.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];

// import x from 'a' | import 'a' | export { x } from 'a' | import('a') | require('a')
const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const re of IMPORT_RES) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

function resolveFile(base: string): string | null {
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => path.join(base, "index" + e))];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

export type Resolved = { kind: "file"; file: string } | { kind: "package"; name: string } | { kind: "unresolved"; spec: string };

export function resolveImport(spec: string, fromFile: string, root = REPO_ROOT): Resolved {
  let base: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = path.join(root, "src", spec.slice(2));
  else if (spec.startsWith("/")) base = spec;
  if (base === null) return { kind: "package", name: spec };
  const file = resolveFile(base);
  return file ? { kind: "file", file } : { kind: "unresolved", spec };
}

export type Graph = {
  /** Every repo file visited (absolute paths). */
  files: Set<string>;
  /** Bare specifier -> files importing it. */
  packages: Map<string, Set<string>>;
  /** Imports that could not be resolved (e.g. typos) -> importing file. */
  unresolved: Map<string, string>;
  /** Edges for readable error messages: file -> importer. */
  importedBy: Map<string, string>;
};

export function walkGraph(entries: string[], root = REPO_ROOT): Graph {
  const graph: Graph = { files: new Set(), packages: new Map(), unresolved: new Map(), importedBy: new Map() };
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (graph.files.has(file)) continue;
    graph.files.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of importSpecifiers(source)) {
      const r = resolveImport(spec, file, root);
      if (r.kind === "file") {
        if (!graph.importedBy.has(r.file)) graph.importedBy.set(r.file, file);
        queue.push(r.file);
      } else if (r.kind === "package") {
        const set = graph.packages.get(r.name) ?? new Set<string>();
        set.add(file);
        graph.packages.set(r.name, set);
      } else {
        graph.unresolved.set(r.spec, file);
      }
    }
  }
  return graph;
}

/** Import chain entry -> ... -> file, relative to the repo root. */
export function chain(graph: Graph, file: string, root = REPO_ROOT): string {
  const parts = [file];
  let cur = file;
  while (graph.importedBy.has(cur)) {
    cur = graph.importedBy.get(cur)!;
    parts.unshift(cur);
  }
  return parts.map((p) => path.relative(root, p).split(path.sep).join("/")).join(" -> ");
}

/**
 * Every source file of the repository that could end up in a deployment or be run
 * by hand: skips `node_modules`, dot-directories (`.next`, `.git`, `.github`,
 * `.claude`, ...) and generated test-output directories (`test-results`,
 * `playwright-report`), which are gitignored but may exist locally.
 */
export function repoSourceFiles(root = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "test-results" || entry.name === "playwright-report" || entry.name.startsWith(".")) {
        continue;
      }
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (EXTENSIONS.some((e) => entry.name.endsWith(e))) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Tooling files: allowed to import/reference things product code may not (test
 * helpers, DB scripts, test/build configuration, env files). Used by `env-access`
 * and `vendor-sdk` to exempt tests and scripts from confinement rules meant for
 * application code.
 */
export function isToolingFile(relPath: string): boolean {
  return (
    relPath.startsWith("scripts/") ||
    // Covers the top-level tests/ root (tests/e2e/, tests/integration/, tests/config/)
    // and every owner-local tests/ directory alike.
    relPath.split("/").includes("tests") ||
    /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/.test(relPath) ||
    relPath === "vitest.config.ts" ||
    relPath === "playwright.config.ts" ||
    relPath === "drizzle.config.ts" ||
    /(^|\/)\.env[^/]*$/.test(relPath)
  );
}
