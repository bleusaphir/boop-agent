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

# Production deps + the dashboard build tools. vite / react / tailwind live in
# "dependencies" (not devDependencies), so --omit=dev installs everything
# `npm run build:debug` needs while still dropping electron / electron-builder /
# vitest / typescript / npm-run-all (dev) and patchright (optional).
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

# App source (respects .dockerignore).
COPY --chown=node:node . .

# Convex codegen + function push at BUILD time. Produces convex/_generated, which
# scripts/preflight.mjs requires AND which the dashboard build imports — so this must
# run BEFORE build:debug. --typecheck=disable keeps the build deterministic and avoids
# depending on tsc (typescript is a devDep, absent under --omit=dev).
ARG CONVEX_DEPLOY_KEY
RUN CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" npx convex deploy --typecheck=disable

# Build the dashboard UI. Vite inlines VITE_CONVEX_URL into the bundle so the browser
# can reach Convex directly; without it the bundle renders a "VITE_CONVEX_URL is not
# set" error page. Set it to the same value as the runtime CONVEX_URL.
ARG VITE_CONVEX_URL
RUN VITE_CONVEX_URL="$VITE_CONVEX_URL" npm run build:debug

# preflight passes (convex/_generated present); tsx runs the TS entrypoint. Railway
# sets PORT; the server reads process.env.PORT and binds 0.0.0.0.
CMD ["npm", "start"]
