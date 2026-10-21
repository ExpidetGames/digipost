import type { Repositories } from "@/persistence/repositories/contracts";

/**
 * Completes a partial `Repositories` bundle for unit tests (WEBAPP_TEMPLATE_SPEC.md
 * §10.2): every slot the test does not provide throws on first use. Each owner
 * area's fakes (e.g. `fake-projects-repositories.ts`) stay independent of the
 * others, and a use case that unexpectedly reaches into another area's repository
 * fails loudly instead of silently reading `undefined`.
 */
export function withUnusedRepositories(provided: Partial<Repositories>): Repositories {
  return new Proxy(provided as Repositories, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      // Symbols (inspection) and `then` (thenable checks by `await`) must not throw.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`Repositories.${String(prop)} is not provided by this test's fake`);
    },
  });
}
