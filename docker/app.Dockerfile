# syntax=docker/dockerfile:1.7
#
# Stages (WEBAPP_TEMPLATE_SPEC.md §10.3):
#   deps    - installs dependencies only (cacheable independently of source changes)
#   tools   - deps + full source; runs migrations/seed/db-tests/vitest scripts
#             (docker/compose.test.yml's migrate/tests services, scripts/test/docker.mjs)
#   build   - tools + `next build` (a real production build, not `next dev`)
#   runner  - the build's output only, `next start` (docker/compose.test.yml's app service,
#             which the e2e service reaches via `network_mode: "service:app"`)

FROM node:24-slim AS deps

# Node 24 does not bundle Corepack by default; install it explicitly, then let it
# read the pinned version from package.json's "packageManager" field (no separate
# `corepack use` needed - that pins the exact pnpm version).
RUN npm install --global corepack@latest && corepack enable

WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Only the files pnpm needs to resolve/install, so this layer (and its cache mount)
# stays valid across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=digipost-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

FROM deps AS tools
WORKDIR /app
COPY . .

# `next build` inlines NEXT_PUBLIC_* into the client bundle at build time
# (WEBAPP_TEMPLATE_SPEC.md §9); passed as build args by docker/compose.test.yml's `app`
# service, never read from any .env* file inside the image.
FROM tools AS build
WORKDIR /app
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN --mount=type=cache,id=digipost-next-build-cache,target=/app/.next/cache \
    pnpm build

# Runner only gets the build's output, never the source tree or dev dependencies -
# smaller image, and it can't accidentally read a bind-mounted host file the build
# stage didn't produce. Kept on the same base image as `deps`/`tools` (not an
# alpine/distroless swap) so native deps built against `deps` (esbuild,
# lightningcss, Tailwind's oxide binary, `pg`'s optional native bits) still match.
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
# `next start` re-loads and re-transpiles next.config.ts at runtime - it is NOT
# fully baked into .next at build time. next.config.ts only imports the
# `next-intl/plugin` package (already in node_modules) and references
# `./src/i18n/request.ts` as a path string next-intl bundles at build time, not a
# runtime import of next.config.ts itself - so no local source tree besides this
# file needs to ship here. Revisit this list if next.config.ts starts importing a
# local module directly (see docker/app.Dockerfile's own header comment history via
# git blame for the Deeplify precedent this pattern is based on).
COPY --from=build /app/next.config.ts ./next.config.ts

EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
