/**
 * Small shared helpers for the structure checker's rule modules. Real import
 * resolution lives in `./module-graph.ts` (STRUCTURE.md §15) - this file only adds
 * the bits module-graph.ts has no reason to know about (glob-ish path matching for
 * STRUCTURE.md's own blocks, markdown metadata/link scanning, file-content caching
 * for the checker's own repeated re-scans).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type Violation = {
  rule: string;
  /** Repo-relative, posix-separated path this violation is attributed to (what
   *  STRUCTURE.md §13's exceptions match against). */
  file: string;
  message: string;
};

const contentCache = new Map<string, string>();

/** Cached `readFileSync(file, "utf8")` - rules re-read the same files a lot. */
export function readCached(file: string): string {
  const cached = contentCache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(file, "utf8");
  contentCache.set(file, text);
  return text;
}

export function toPosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Whether repo-relative posix path `file` matches a STRUCTURE.md path pattern: an
 * exact path, a `prefix/` directory (matches the directory itself and everything
 * under it), or a `prefix/**`/`prefix/*` glob (matches everything under it, not the
 * bare directory).
 */
export function matchesPattern(file: string, pattern: string): boolean {
  if (pattern.endsWith("/**") || pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, pattern.lastIndexOf("/"));
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith("/")) {
    return file === pattern.slice(0, -1) || file.startsWith(pattern);
  }
  return file === pattern;
}

/** Whether `file` starts with plain prefix `dir` (no trailing slash required in
 *  `dir`; matches the directory itself and anything under it). */
export function underDir(file: string, dir: string): boolean {
  const d = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return file === d || file.startsWith(`${d}/`);
}

/** Every real file (posix, repo-relative) under `root` whose basename or full
 *  relative path matches glob `pattern` (only `*` as "any path segment content" is
 *  supported - enough for STRUCTURE.md's `src/modules/*\/README.md` style patterns;
 *  `**` is not needed here, unlike `matchesPattern` above). */
export function expandGlob(root: string, pattern: string): string[] {
  const segments = pattern.split("/");
  let current = [""];
  for (const seg of segments) {
    const next: string[] = [];
    for (const base of current) {
      const dir = path.join(root, base);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      if (seg.includes("*")) {
        const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        for (const entry of readdirSync(dir)) {
          if (re.test(entry)) next.push(base ? `${base}/${entry}` : entry);
        }
      } else {
        next.push(base ? `${base}/${seg}` : seg);
      }
    }
    current = next;
  }
  return current
    .map((p) => path.join(root, p))
    .filter((p) => existsSync(p) && statSync(p).isFile())
    .map((p) => toPosix(root, p));
}

/** Every directory (posix, repo-relative), depth-first, under `root`, excluding
 *  node_modules/.next/.git and other dot-directories. */
export function listDirsRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = path.join(dir, entry.name);
      out.push(p);
      walk(p);
    }
  };
  walk(root);
  return out;
}

export function isDirEmpty(dir: string): boolean {
  return readdirSync(dir).length === 0;
}

/**
 * Every file path (posix, relative to `root`) that git actually tracks (`git ls-files`,
 * scoped to `root` via `cwd`) - i.e. exactly what a fresh CI checkout of this ref would
 * contain. `null` when `root` is not inside a git working tree (or `git` itself is
 * unavailable), so callers can fall back to a raw `readdirSync` scan.
 *
 * This is what a rule that must mirror "what CI sees" (STRUCTURE.md's `roots` rule)
 * should scan instead of the raw filesystem: a raw `readdirSync` also picks up
 * gitignored build/test artifacts (`.next/`, `test-results/`, `playwright-report/`, a
 * locally present `docs/`) and anything merely uncommitted in a developer's working
 * copy - none of which CI's `verify:structure` run (against a fresh checkout, before
 * any build/test step) would ever see.
 */
export function gitTrackedPaths(root: string): string[] | null {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: root, encoding: "utf8" });
  } catch {
    return null;
  }
  return out.split("\0").filter(Boolean);
}

/** First line, after skipping blank lines and `//`/`/* ... *\/` comments, that
 *  actually has content - used to find a file's leading directive ("use
 *  client"/"use server") regardless of a preceding doc comment. */
export function firstStatementLine(text: string): string | null {
  let inBlockComment = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line === "") continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    return line;
  }
  return null;
}
