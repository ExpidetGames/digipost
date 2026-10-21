/**
 * The one place that decides what `Sentry.init()` gets called with - shared by
 * `src/sentry.server.config.ts`, `src/sentry.edge.config.ts` and `src/instrumentation-client.ts`
 * (all directly under `src/`: Next.js/`@sentry/nextjs` file conventions, not movable into
 * `src/platform/observability/**`). Pure and neutral (no `server-only`, no SDK import) so
 * it is trivially unit-testable: `sentryInitOptions(undefined)` is the "no DSN, no
 * Sentry" case every one of those three files must honor.
 */
/**
 * Structurally typed subset of `@sentry/nextjs`'s `Event`/`Breadcrumb` shapes - just
 * enough to redact a URL, without importing the SDK here (this file stays pure and
 * SDK-import-free, see the file header comment).
 */
type MinimalSentryBreadcrumb = {
  data?: Record<string, unknown> | null;
  message?: string | null;
};
type MinimalSentryEvent = {
  request?: { url?: string | null } | null;
  breadcrumbs?: MinimalSentryBreadcrumb[] | null;
};

export type SentryInitOptions = {
  dsn: string;
  /**
   * No user IP, no request cookies/headers, no default PII in events (Sentry's own
   * default is already `false`; set explicitly so it survives an SDK default
   * change). AGENTS.md "Security": no secrets/PII leaves this app uncontrolled.
   */
  sendDefaultPii: false;
  /**
   * Fraction of transactions traced (performance monitoring). A fixed, modest
   * default; raise it (or make it env-driven) once a real project's Sentry quota
   * and the value of finer sampling justify the extra complexity.
   */
  tracesSampleRate: number;
  /** Redacts an invitation token from any event URL before it ever leaves this app
   * (P6 review finding B3). See `redactInviteTokenFromUrl` below. Generic (not typed
   * as a fixed `MinimalSentryEvent -> MinimalSentryEvent` function) so it stays
   * assignable to `@sentry/nextjs`'s own, much larger `beforeSend` signature: the SDK
   * calls this with its real `Event` type, which structurally satisfies
   * `MinimalSentryEvent`, and this function returns that exact same object back
   * (mutated in place), never a narrowed-down copy. */
  beforeSend: <T extends MinimalSentryEvent>(event: T) => T;
  /** Same redaction, for breadcrumbs recorded before an event is even sent (a
   * navigation to `/invite/<token>`, or an XHR/fetch breadcrumb whose URL contains
   * one) - `beforeSend` alone would not scrub a breadcrumb's own `data.url`. */
  beforeBreadcrumb: <T extends MinimalSentryBreadcrumb>(breadcrumb: T) => T;
};

const TRACES_SAMPLE_RATE = 0.2;

/**
 * An invitation token travels in the URL path (`/invite/<token>`, decisions/0014's
 * onboarding flow) - unlike a cookie or an Authorization header, Sentry's default
 * instrumentation captures the request/breadcrumb URL as a matter of course, so this
 * token would otherwise reach Sentry verbatim in every event/breadcrumb generated while
 * viewing that page (P6 review finding B3). The token itself is a single opaque
 * path segment (no further `/` inside it), so a plain regex match on the invite path
 * shape is enough; this never throws on a malformed/relative URL, worst case leaving it
 * unchanged.
 */
const INVITE_TOKEN_PATH_PATTERN = /\/invite\/[^/?#\s]+/g;
const INVITE_TOKEN_PATH_REPLACEMENT = "/invite/[redacted]";

/** Replaces every `/invite/<token>` path segment in `value` with a redacted
 * placeholder. Safe to call on any string, URL or not - a string with no match is
 * returned unchanged. */
export function redactInviteTokenFromUrl(value: string): string {
  return value.replace(INVITE_TOKEN_PATH_PATTERN, INVITE_TOKEN_PATH_REPLACEMENT);
}

function redactBreadcrumb<T extends MinimalSentryBreadcrumb>(breadcrumb: T): T {
  const data = breadcrumb.data;
  if (data) {
    for (const key of ["url", "to", "from"]) {
      const value = data[key];
      if (typeof value === "string") data[key] = redactInviteTokenFromUrl(value);
    }
  }
  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = redactInviteTokenFromUrl(breadcrumb.message);
  }
  return breadcrumb;
}

function redactEvent<T extends MinimalSentryEvent>(event: T): T {
  if (event.request?.url) {
    event.request.url = redactInviteTokenFromUrl(event.request.url);
  }
  if (event.breadcrumbs) {
    for (const breadcrumb of event.breadcrumbs) {
      if (breadcrumb) redactBreadcrumb(breadcrumb);
    }
  }
  return event;
}

/**
 * Returns the shared `Sentry.init()` options, or `undefined` when there is no DSN -
 * the caller must then skip calling `Sentry.init()` entirely (not just pass an
 * empty `dsn`) so the SDK adds zero instrumentation overhead, not just zero network
 * traffic (Sentry's own guidance: call `init` conditionally for a true no-op).
 */
export function sentryInitOptions(dsn: string | undefined): SentryInitOptions | undefined {
  const trimmed = dsn?.trim();
  if (!trimmed) return undefined;
  return {
    dsn: trimmed,
    sendDefaultPii: false,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    beforeSend: redactEvent,
    beforeBreadcrumb: redactBreadcrumb,
  };
}
