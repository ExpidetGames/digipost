// The one allowed `cache(createRequestServices)` (WEBAPP_TEMPLATE_SPEC.md §5.5).
// Entry points (pages, layouts, read models, Server Actions, route handlers) get
// services ONLY through `getRequestServices()`, never by calling
// `createRequestServices()` directly: that way a request builds the persistence
// graph at most once.
import "server-only";

import { cache } from "react";

import { createRequestServices } from "./create-request-services";

export const getRequestServices = cache(createRequestServices);
