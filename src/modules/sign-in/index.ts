// Neutral entrypoint: reaches neither client- nor server-only code. `src/app/(auth)/login/page.tsx`
// (a seam) uses `safeNextPath` to sanitize `next` before both redirecting an
// already-signed-in visitor and handing it to `LoginForm` as a hidden field.
export { safeNextPath } from "./core/safe-next-path";
