// The stable return shape for every Server Action (WEBAPP_TEMPLATE_SPEC.md §7, §8: "Server
// Actions werfen nur für redirect/notFound; alles andere ist ein ActionResult"). Neutral: no
// "use client"/"use server" of its own, importable from both a module's actions.ts and its
// client components. `TErrorCode` is always a project-local `as const` union (AGENTS.md
// "Code": stable error codes, never raw text) that the UI translates to copy via i18n keys,
// never the reverse.
export type ActionResult<TData = void, TErrorCode extends string = string> =
  | { status: "success"; data: TData }
  | { status: "error"; errorCode: TErrorCode };
