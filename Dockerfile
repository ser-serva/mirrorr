# Mirrorr — Multi-stage monorepo build
#
# Targets:
#   app    → Fastify API server (serves built frontend via @fastify/static)
#   worker → Temporal worker + yt-dlp + ffmpeg  (needs NVIDIA runtime)
#
# Build:
#   docker build --target app    -t mirrorr-app:latest .
#   docker build --target worker -t mirrorr-worker:latest .
#
# Note: NVIDIA GPU support for the worker requires:
#   - nvidia-container-toolkit on the Docker host
#   - `deploy.resources.reservations.devices` in the compose file (see infra/prod/compose.yaml)

# ── Stage 1: base ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
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
COPY packages/eslint-config/package.json     packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
# Production deps only (skip devDependencies for final stages)
RUN pnpm install --frozen-lockfile --prod

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

# ── Stage 4: app ─────────────────────────────────────────────────────────────
# Lean runtime — API server only; no yt-dlp tooling needed
FROM node:22-alpine AS app
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

# ── Stage 5: worker ───────────────────────────────────────────────────────────
# Debian-based to install yt-dlp + ffmpeg without Alpine glibc issues
FROM node:22-bookworm-slim AS worker
WORKDIR /app

# System tools: yt-dlp, ffmpeg, python3 (yt-dlp dep), curl
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      ffmpeg \
      curl \
      ca-certificates \
   && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp \
   && chmod +x /usr/local/bin/yt-dlp \
   && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy production node_modules (same as app stage)
COPY --from=deps    /app/node_modules                        ./node_modules
COPY --from=deps    /app/apps/backend/node_modules           ./apps/backend/node_modules
COPY --from=deps    /app/packages/shared/node_modules        ./packages/shared/node_modules
COPY --from=deps    /app/packages/adapter-core/node_modules  ./packages/adapter-core/node_modules
COPY --from=deps    /app/packages/adapter-tiktok/node_modules ./packages/adapter-tiktok/node_modules
COPY --from=deps    /app/packages/adapter-loops/node_modules ./packages/adapter-loops/node_modules

# Copy compiled outputs (worker also needs tiktok adapter)
COPY --from=builder /app/apps/backend/dist               ./apps/backend/dist
COPY --from=builder /app/packages/shared/dist            ./packages/shared/dist
COPY --from=builder /app/packages/adapter-core/dist      ./packages/adapter-core/dist
COPY --from=builder /app/packages/adapter-tiktok/dist    ./packages/adapter-tiktok/dist
COPY --from=builder /app/packages/adapter-loops/dist     ./packages/adapter-loops/dist

COPY --from=builder /app/package.json                         ./package.json
COPY --from=builder /app/pnpm-workspace.yaml                  ./pnpm-workspace.yaml
COPY --from=builder /app/apps/backend/package.json            ./apps/backend/package.json
COPY --from=builder /app/packages/shared/package.json         ./packages/shared/package.json
COPY --from=builder /app/packages/adapter-core/package.json   ./packages/adapter-core/package.json
COPY --from=builder /app/packages/adapter-tiktok/package.json ./packages/adapter-tiktok/package.json
COPY --from=builder /app/packages/adapter-loops/package.json  ./packages/adapter-loops/package.json

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
