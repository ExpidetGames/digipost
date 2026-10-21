import { cache } from "react";

// A second, rogue copy of the request-services memoization - exactly what
// STRUCTURE.md §6 forbids ("genau eine Datei").
function createRequestServices() {
  return {};
}

export const getRequestServicesAgain = cache(createRequestServices);
