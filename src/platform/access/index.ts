// Neutral entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2): permission bundle constants and types
// only, safe to import from client-reachable code (a client component may want to hide a
// button the server would reject anyway - display only, never the real authorization,
// which always happens server-side in `server.ts`).
export {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  permissionsForRole,
  roleHasPermission,
  type Permission,
  type Role,
} from "./core/permissions";
