# syntax=docker/dockerfile:1
FROM node:20-slim

# Run everything as the built-in non-root `node` user. The Claude Agent SDK passes
# --dangerously-skip-permissions (permissionMode: "bypassPermissions"), which the
# Claude Code CLI REFUSES under root/sudo — as root every agent turn dies with
# "Claude Code process exited with code 1". Do not revert this.
ENV HOME=/home/node
WORKDIR /app
RUN chown node:node /app
USER node

# FULL install: dev deps (vite, react plugin, tailwind) are needed to build the
# dashboard UI. They are pruned again after the build (last RUN), so the final image
# stays lean.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

# App source (respects .dockerignore).
COPY --chown=node:node . .

# Convex codegen + function push at BUILD time. Produces convex/_generated, which
# scripts/preflight.mjs requires AND which the dashboard build imports — so this must
# run BEFORE build:debug. --typecheck=disable keeps the build deterministic (typescript
# is a dev dep and is about to be pruned anyway).
ARG CONVEX_DEPLOY_KEY
RUN CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" npx convex deploy --typecheck=disable

# Build the dashboard UI. Vite inlines VITE_CONVEX_URL into the bundle so the browser
# can reach Convex directly; without it the bundle renders a "VITE_CONVEX_URL is not
# set" error page. Set it to the same value as the runtime CONVEX_URL.
ARG VITE_CONVEX_URL
RUN VITE_CONVEX_URL="$VITE_CONVEX_URL" npm run build:debug

# Drop dev + optional deps now that debug/dist is built. jose is a runtime dependency
# (not a dev dep), so it survives. patchright (optional), electron/vitest/typescript
# (dev) are removed.
RUN npm prune --omit=dev --omit=optional

# preflight passes (convex/_generated present); tsx runs the TS entrypoint. Railway
# sets PORT; the server reads process.env.PORT and binds 0.0.0.0.
CMD ["npm", "start"]
