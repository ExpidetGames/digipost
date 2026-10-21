/**
 * `parseJsonRequestWithSchema` treats "body is not valid JSON" and "body is valid
 * JSON but fails the schema" identically (both become `null`, which
 * `core/handler-factory.ts` turns into the endpoint contract's `invalidRequestError`);
 * a route whose contract needs to tell those two cases apart, or treats an empty
 * body specially, writes its own `parse` step instead of reaching for this helper.
 */
import type { ZodType } from "zod";

export async function parseJsonRequestWithSchema<TPayload>(request: Request, schema: ZodType<TPayload>): Promise<TPayload | null> {
  const payload = await request.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseQueryWithSchema<TPayload>(request: Request, schema: ZodType<TPayload>): TPayload | null {
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  return parsed.success ? parsed.data : null;
}
