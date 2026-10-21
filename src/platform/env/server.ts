// Privileged entrypoint of the src/platform/env owner. Never imported from client-reachable
// code (see STRUCTURE.md once it exists; direction rule "forbid client-reachable-reaches-privileged").
import "server-only";

export { serverEnv, resetServerEnvCacheForTests } from "@/platform/env/server/env";
export type { ServerEnv } from "@/platform/env/server/env";
