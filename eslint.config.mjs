import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Vendor SDKs that would couple application code to one hosting provider
// (WEBAPP_TEMPLATE_SPEC.md §2.8, decisions/0003-provider-independent-postgres-with-drizzle.md).
// None are dependencies yet; this rule is forward-looking so adding one by accident
// outside src/persistence/foundation/** fails lint immediately instead of during review.
const noVendorSdk = [
  {
    group: ["@supabase/*", "@neondatabase/*"],
    message:
      "Provider SDKs are only allowed inside src/persistence/foundation/** (decisions/0003). Use the pg driver via src/persistence/foundation/client.ts instead.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-nested-ternary": "error",
      "no-restricted-imports": ["error", { patterns: noVendorSdk }],
    },
  },
  {
    // src/shared/<purpose>/ is neutral: it never imports src/app/, src/modules/, or src/persistence/
    // (WEBAPP_TEMPLATE_SPEC.md §4.3's dependency matrix).
    files: ["src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...noVendorSdk,
            {
              group: ["@/app/*", "@/modules/*", "@/persistence/*"],
              message: "src/shared/** must stay neutral: it may not import src/app/, src/modules/, or src/persistence/.",
            },
          ],
        },
      ],
    },
  },
  {
    // src/platform/<concern>/ is app-wide infrastructure: it never imports src/app/ (Next seams
    // delegate to platform, not the other way around).
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...noVendorSdk,
            {
              group: ["@/app/*"],
              message: "src/platform/** must not import src/app/ (Next seams delegate to platform, never the reverse).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Test/tool output
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    // Git worktrees of parallel agents (separate checkouts) and local agent tooling
    ".claude/**",
  ]),
]);

export default eslintConfig;
