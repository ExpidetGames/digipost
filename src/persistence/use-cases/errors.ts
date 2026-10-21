// Use cases throw stable error codes, never UI text (WEBAPP_TEMPLATE_SPEC.md §5.4).
// A Server Action or route handler catches `UseCaseError` and maps `.code` to a
// stable, `as const` error-code union of its own; the UI translates codes to copy,
// never the reverse.
export class UseCaseError<C extends string = string> extends Error {
  override readonly name = "UseCaseError";

  constructor(readonly code: C) {
    super(code);
  }
}
