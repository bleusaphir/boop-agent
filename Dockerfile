# syntax=docker/dockerfile:1
FROM node:20-slim

# Run everything as the built-in non-root `node` user (uid 1000). The Claude Agent
# SDK passes --dangerously-skip-permissions (from permissionMode: "bypassPermissions"),
# and the Claude Code CLI REFUSES to run that under root/sudo — so as root every agent
# turn dies with "Claude Code process exited with code 1". Owning /app as `node` (and
# a real $HOME) also avoids runtime write-permission issues (tsx, CLI session state).
ENV HOME=/home/node
WORKDIR /app
RUN chown node:node /app
USER node

# Production dependencies only.
# --omit=dev      drops electron / electron-builder / vitest / typescript (devDeps)
# --omit=optional drops patchright (browser integration is off on Railway and is
#                 only ever imported lazily via import("patchright"), never at boot)
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

# App source (respects .dockerignore).
COPY --chown=node:node . .

# Convex codegen + function push at BUILD time. This produces convex/_generated,
# which scripts/preflight.mjs requires and which is gitignored (absent from the
# build context). CONVEX_DEPLOY_KEY is provided as a Railway build variable;
# declaring it ARG makes it available to this RUN. Baking _generated into the
# image avoids a re-deploy on every container restart.
# --typecheck=disable keeps the build deterministic. typescript is a devDep, absent
# under --omit=dev; convex's default (--typecheck=try) would emit a "can't find tsc"
# warning and skip the check anyway, so disabling it explicitly just removes that
# noise and the dependence on the `try` fallback. Codegen still runs (gated by
# --codegen, independent of typecheck) and writes convex/_generated.
ARG CONVEX_DEPLOY_KEY
RUN CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" npx convex deploy --typecheck=disable

# preflight now passes; tsx runs the TS entrypoint. Railway sets PORT; the
# server reads process.env.PORT and binds 0.0.0.0.
CMD ["npm", "start"]
