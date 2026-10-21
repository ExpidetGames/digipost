# syntax=docker/dockerfile:1.7
#
# Runs the e2e suite (docker/compose.test.yml's `e2e` service, scripts/test/docker.mjs).
# The base image's Playwright/browser version must match the repo's
# `@playwright/test` exactly, or the installed browsers can silently drift from
# what the test run expects - scripts/test/docker.mjs reads the resolved version
# out of pnpm-lock.yaml/node_modules and passes it as the PLAYWRIGHT_VERSION build
# arg (docker/compose.test.yml), never hardcoded here.
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# Node 24 does not bundle Corepack by default; install it explicitly, then let it
# read the pinned version from package.json's "packageManager" field (mirrors
# docker/app.Dockerfile's `deps` stage) - the base image's own Node version doesn't
# matter here as long as Corepack/pnpm can install the lockfile.
RUN npm install --global corepack@latest && corepack enable

WORKDIR /work
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# The base image already ships browsers matching PLAYWRIGHT_VERSION at
# PLAYWRIGHT_BROWSERS_PATH (set by the base image); nothing in the lockfile has a
# postinstall step that would re-download them, but skip it defensively in case a
# future dependency bump adds one.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Only the files pnpm needs to resolve/install first, so this layer (and its cache
# mount) stays valid across source-only changes - same pattern as
# app.Dockerfile's `deps` stage, with its own cache mount id so the two builds
# never fight over one store directory.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=digipost-e2e-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

# tests/e2e/helpers/** import a few app modules directly (src/persistence/foundation/**, via
# `pg`, for data factories - WEBAPP_TEMPLATE_SPEC.md §10.4), so the suite needs the
# whole source tree, not just tests/e2e/**.
COPY . .

ENV CI=1

# No default CMD: `docker compose run --build e2e [ARGS...]` appends ARGS to this
# entrypoint (e.g. `pnpm test:e2e:docker -- --grep @smoke` -> `pnpm exec playwright
# test --grep @smoke`); with none given it runs the full suite.
ENTRYPOINT ["pnpm", "exec", "playwright", "test"]
