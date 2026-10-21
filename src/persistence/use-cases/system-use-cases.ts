// Owner: none (see `src/persistence/repositories/contracts/system-repository.ts`'s
// header comment). The only caller is `GET /api/health` (`src/app/api/health/route.ts`).
import type { Repositories } from "@/persistence/repositories/contracts";

export interface SystemUseCases {
  /**
   * Never throws: catches any repository failure and reports it as `{ ok: false }`
   * instead, so the health route never needs its own try/catch and an unreachable
   * database never turns into an uncaught error (which could produce a response
   * this endpoint is not meant to give out, WEBAPP_TEMPLATE_SPEC.md §13.4: "liefert
   * nach außen nur { ok, ... }, keine Details über die Infrastruktur").
   */
  health(): Promise<{ ok: boolean }>;
}

export function createSystemUseCases(deps: { repos: Pick<Repositories, "system"> }): SystemUseCases {
  return {
    async health() {
      try {
        await deps.repos.system.ping();
        return { ok: true };
      } catch (err) {
        console.error("[system] health check failed", err);
        return { ok: false };
      }
    },
  };
}
