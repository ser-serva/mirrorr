# Mirrorr — Multi-stage monorepo build
#
# Targets:
#   app    → Fastify API server (serves built frontend via @fastify/static)
#   worker → Temporal worker + yt-dlp + ffmpeg  (needs NVIDIA runtime)
#   dev    → Hot-reload dev image (yt-dlp + all deps; source bind-mounted at runtime)
#
# Build:
#   docker build --target app    -t mirrorr-app:latest .
#   docker build --target worker -t mirrorr-worker:latest .
#   docker build --target dev    -t mirrorr:dev .
#
# Note: NVIDIA GPU support for the worker requires:
#   - nvidia-container-toolkit on the Docker host
#   - `deploy.resources.reservations.devices` in the compose file (see infra/prod/compose.yaml)

# ── Global build args ─────────────────────────────────────────────────────────
# Single source of truth for the yt-dlp version used by both worker and dev.
# Bump here when upgrading — both targets rebuild automatically.
# Release index: https://github.com/yt-dlp/yt-dlp/releases
ARG YTDLP_VERSION=2026.02.21

# ── Stage 1: base ─────────────────────────────────────────────────────────────
# node:22-slim (Debian/glibc) is used for ALL stages so that native modules
# (better-sqlite3, sodium-native) are compiled and run against the same libc.
# Alpine (musl) would cause ERR_DLOPEN_FAILED when the binaries are copied into
# the glibc-based runtime stages.
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ── Stage 2: deps ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/backend/package.json  apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/shared/package.json            packages/shared/package.json
COPY packages/adapter-core/package.json      packages/adapter-core/package.json
COPY packages/adapter-tiktok/package.json    packages/adapter-tiktok/package.json
COPY packages/adapter-loops/package.json     packages/adapter-loops/package.json
COPY packages/ytdlp/package.json             packages/ytdlp/package.json
COPY packages/eslint-config/package.json     packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
# Production deps only (skip devDependencies for final stages)
RUN pnpm install --frozen-lockfile --prod
# Ensure per-package node_modules dirs exist even when the package has no
# external deps of its own (pnpm won't create them, but COPY --from=deps needs
# a path to exist or the build fails with "not found").
RUN mkdir -p \
      packages/shared/node_modules \
      packages/adapter-core/node_modules \
      packages/adapter-tiktok/node_modules \
      packages/adapter-loops/node_modules \
      packages/ytdlp/node_modules

# ── Stage 3: build ────────────────────────────────────────────────────────────
# Need devDependencies (tsc, vite, tsx) — separate install then build
FROM base AS builder
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/         apps/
COPY packages/     packages/
COPY turbo.json    ./
RUN pnpm install --frozen-lockfile
# Build all packages in dependency order (turbo handles the DAG)
RUN pnpm turbo build

# Copy migration files (SQL + JSON) into dist — tsc only emits .js files.
# migrationsFolder in db/index.ts resolves relative to the compiled file, so
# migrations must live alongside the compiled output at dist/db/migrations/.
RUN cp -r apps/backend/src/db/migrations apps/backend/dist/db/migrations

# ── Stage 4: app ─────────────────────────────────────────────────────────────
# Lean runtime — API server only; no yt-dlp tooling needed
# Inherits node:22-slim from base (glibc) — consistent with deps/builder so that
# native modules (sodium-native, better-sqlite3) load correctly at runtime.
FROM node:22-slim AS app
WORKDIR /app

# Copy production node_modules
COPY --from=deps    /app/node_modules                    ./node_modules
COPY --from=deps    /app/apps/backend/node_modules       ./apps/backend/node_modules
COPY --from=deps    /app/packages/shared/node_modules    ./packages/shared/node_modules
COPY --from=deps    /app/packages/adapter-core/node_modules ./packages/adapter-core/node_modules
COPY --from=deps    /app/packages/adapter-loops/node_modules ./packages/adapter-loops/node_modules

# Copy compiled outputs
COPY --from=builder /app/apps/backend/dist              ./apps/backend/dist
COPY --from=builder /app/apps/frontend/dist             ./apps/frontend/dist
COPY --from=builder /app/packages/shared/dist           ./packages/shared/dist
COPY --from=builder /app/packages/adapter-core/dist     ./packages/adapter-core/dist
COPY --from=builder /app/packages/adapter-loops/dist    ./packages/adapter-loops/dist

# Copy package.json files (needed for workspace resolution at runtime)
COPY --from=builder /app/package.json                    ./package.json
COPY --from=builder /app/pnpm-workspace.yaml             ./pnpm-workspace.yaml
COPY --from=builder /app/apps/backend/package.json       ./apps/backend/package.json
COPY --from=builder /app/packages/shared/package.json    ./packages/shared/package.json
COPY --from=builder /app/packages/adapter-core/package.json ./packages/adapter-core/package.json
COPY --from=builder /app/packages/adapter-loops/package.json ./packages/adapter-loops/package.json

WORKDIR /app/apps/backend

ENV NODE_ENV=production
# DB defaults to /data/mirrorr.db — override via DATABASE_PATH env var
RUN mkdir -p /data

EXPOSE 4001
CMD ["node", "dist/server.js"]

# ── Stage 5: system-tools ────────────────────────────────────────────────────
# Shared base for both worker (prod) and dev (hot-reload).
# Installs: yt-dlp (pinned via ARG YTDLP_VERSION), ffmpeg, python3, curl.
# Debian bookworm-slim is required — Alpine (musl) breaks native Node modules.
FROM node:22-bookworm-slim AS system-tools
# Re-declare ARG so this stage inherits the global value
ARG YTDLP_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg curl ca-certificates sqlite3 \
   && curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
        -o /usr/local/bin/yt-dlp \
   && chmod +x /usr/local/bin/yt-dlp \
   && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ── Stage 6: worker ───────────────────────────────────────────────────────────
# Extends system-tools — yt-dlp + ffmpeg are already installed.
FROM system-tools AS worker
WORKDIR /app

# Copy production node_modules (same as app stage)
COPY --from=deps    /app/node_modules                        ./node_modules
COPY --from=deps    /app/apps/backend/node_modules           ./apps/backend/node_modules
COPY --from=deps    /app/packages/shared/node_modules        ./packages/shared/node_modules
COPY --from=deps    /app/packages/adapter-core/node_modules  ./packages/adapter-core/node_modules
COPY --from=deps    /app/packages/adapter-tiktok/node_modules ./packages/adapter-tiktok/node_modules
COPY --from=deps    /app/packages/adapter-loops/node_modules ./packages/adapter-loops/node_modules
COPY --from=deps    /app/packages/ytdlp/node_modules        ./packages/ytdlp/node_modules

# Copy compiled outputs (worker also needs tiktok adapter and ytdlp wrapper)
COPY --from=builder /app/apps/backend/dist               ./apps/backend/dist
COPY --from=builder /app/packages/shared/dist            ./packages/shared/dist
COPY --from=builder /app/packages/adapter-core/dist      ./packages/adapter-core/dist
COPY --from=builder /app/packages/adapter-tiktok/dist    ./packages/adapter-tiktok/dist
COPY --from=builder /app/packages/adapter-loops/dist     ./packages/adapter-loops/dist
COPY --from=builder /app/packages/ytdlp/dist             ./packages/ytdlp/dist

COPY --from=builder /app/package.json                         ./package.json
COPY --from=builder /app/pnpm-workspace.yaml                  ./pnpm-workspace.yaml
COPY --from=builder /app/apps/backend/package.json            ./apps/backend/package.json
COPY --from=builder /app/packages/shared/package.json         ./packages/shared/package.json
COPY --from=builder /app/packages/adapter-core/package.json   ./packages/adapter-core/package.json
COPY --from=builder /app/packages/adapter-tiktok/package.json ./packages/adapter-tiktok/package.json
COPY --from=builder /app/packages/adapter-loops/package.json  ./packages/adapter-loops/package.json
COPY --from=builder /app/packages/ytdlp/package.json          ./packages/ytdlp/package.json

WORKDIR /app/apps/backend

ENV NODE_ENV=production
RUN mkdir -p /data/cookies /data/downloads /data/transcodes /data/upload /data/logs

# yt-dlp proxy is set via YTDLP_PROXY env var (points to gluetun:8888)
# NVIDIA GPU access is configured via Docker runtime in infra/prod/compose.yaml
#
# NOTE: worker.ts has `workflowsPath: '...workflow.ts'` — before building for
# prod, change the extension to '.js' so the compiled entrypoint resolves:
#   workflowsPath: resolve(__dirname, './workflows/video-pipeline.workflow.js')
CMD ["node", "dist/worker.js"]

# ── Stage 7: dev ──────────────────────────────────────────────────────────────
# Hot-reload development image. Extends system-tools (yt-dlp + ffmpeg included).
# Source code is NOT copied — bind-mounted at runtime by infra/dev/compose.yaml.
# Includes devDependencies (tsx, vitest, drizzle-kit, turbo, ...) for the dev workflow.
#
# Used by infra/dev/compose.yaml --profile dev services: packages-watch, app, worker.
FROM system-tools AS dev
WORKDIR /app

# Copy workspace manifests only — pnpm needs these to resolve the workspace graph.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/backend/package.json   apps/backend/package.json
COPY apps/frontend/package.json  apps/frontend/package.json
COPY packages/shared/package.json            packages/shared/package.json
COPY packages/adapter-core/package.json      packages/adapter-core/package.json
COPY packages/adapter-tiktok/package.json    packages/adapter-tiktok/package.json
COPY packages/adapter-loops/package.json     packages/adapter-loops/package.json
COPY packages/ytdlp/package.json             packages/ytdlp/package.json
COPY packages/ui/package.json                packages/ui/package.json
COPY packages/eslint-config/package.json     packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json

# Full install — devDeps included (tsx, vitest, drizzle-kit, turbo, …)
RUN pnpm install --frozen-lockfile

# Data directories expected by activities at runtime
RUN mkdir -p /data/cookies /data/downloads /data/transcodes /data/logs

EXPOSE 4001
