# Node version: .nvmrc is binding for hosting/CI/Docker, engines.node is a range locally

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Which Node.js version hosting, CI, and Docker images must run, versus what a
developer's own machine may run
Canonical responsibility: Active source for the Node version policy and upgrade rule
Maintenance triggers:
- `.nvmrc`'s pinned major version changes
- `package.json`'s `engines.node` field changes
Last verified: 2026-09-14 against .nvmrc (24) and package.json (`engines.node`: `>=24`)

## Status
Accepted

## Context

Pinning Node to one exact version everywhere (hosting, CI, Docker, and every developer's
machine) is precise but brittle: a developer who has already moved to a newer local Node
either has to downgrade or gets a false sense that their environment does not match. What
actually needs to match exactly is hosting, CI, and Docker, since those are what a commit
is actually validated and run against; a developer's local machine only needs to be
new enough.

## Decision

1. `.nvmrc` (currently `24`) is the single binding source for the Node major version used
   by the hosting provider's project setting, CI (`actions/setup-node@v4` with
   `node-version-file: .nvmrc` once CI is built), and Docker base images. All three read
   from it rather than hardcoding a version independently.
2. `package.json` declares `engines.node` as an open-ended range from that same major
   (currently `">=24"`), so a developer's locally newer Node still works; local parity to
   `.nvmrc` is optional and only enforced by choice (for example via fnm, which reads
   `.nvmrc` itself).
3. An upgrade to the next LTS major happens as one commit that changes `.nvmrc`, the
   hosting provider's project setting, and every Dockerfile's base image together, only
   once that version is both LTS and supported by the hosting provider.

## Consequences

- Positive: there is exactly one file to bump for a Node upgrade across every execution
  environment that matters (hosting, CI, Docker); a developer's own machine is never
  forced to match it exactly.
- Negative: `engines.node` being a range (not pinned) means a developer's local
  `pnpm install`/`next build` can technically run on a Node major `.nvmrc` has not been
  validated against, until they choose to align locally.
- Implementation status: **already true today**. `.nvmrc` (`24`) and `package.json`'s
  `engines.node` (`">=24"`) both exist as of this step (T1); CI and Docker images that
  read from `.nvmrc` are built in a later step.
