# Mirrorr

A self-hosted short-form video mirroring pipeline. Discovers creator content from source platforms (TikTok), downloads via `yt-dlp`, optionally transcodes with NVIDIA NVENC, and publishes to a target platform (self-hosted [Loops](https://github.com/joinloops/loops-server)).

Temporal.io handles all workflow orchestration — durable execution, retries, and audit history. A React dashboard gives full visibility into the pipeline and lets you manage creators, sources, targets, and individual videos.

---

## Features

- **Unattended operation** — Temporal schedules drive periodic discovery; no cron jobs needed
- **Durable pipeline** — every video moves through a Temporal workflow; crashes and restarts are handled automatically
- **Per-video controls** — ignore/unignore, manual retry, bulk actions from the dashboard
- **Real-time dashboard** — Server-Sent Events push stage updates to the UI without polling
- **Encrypted credentials** — target API tokens stored as AES-256-GCM ciphertext
- **Adapter architecture** — add new source or target platforms with zero changes to the core pipeline
- **VPN routing** — all outbound traffic routed through Gluetun (WireGuard) in dev and preprod

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (ESM) |
| Language | TypeScript (strict) |
| API | Fastify + Zod |
| ORM | Drizzle ORM + drizzle-kit |
| Database | SQLite (better-sqlite3) |
| Orchestration | Temporal.io (self-hosted) |
| Frontend | React 18 + Vite + TailwindCSS + shadcn/ui |
| Data fetching | TanStack Query + SSE (EventSource) |
| Video download | yt-dlp |
| Video transcode | FFmpeg + NVIDIA NVENC (`h264_nvenc`) |
| Monorepo | Turborepo + pnpm workspaces |
| Containers | Docker + Docker Compose |
| VPN | Gluetun (WireGuard) |

---

## Repository Layout

```
mirrorr/
├── apps/
│   ├── backend/          # Fastify API server + Temporal worker
│   └── frontend/         # React admin dashboard
├── packages/
│   ├── shared/           # @mirrorr/shared — types, enums, constants
│   ├── adapter-core/     # SourceAdapter / TargetAdapter interfaces
│   ├── adapter-tiktok/   # TikTok discovery + download (yt-dlp)
│   ├── adapter-instagram/# Stub (not implemented)
│   └── adapter-loops/    # Loops REST API upload
├── infra/
│   ├── dev/              # Local dev stack (Temporal + hot-reload + Gluetun + Firefox)
│   ├── preprod/          # Pre-production stack
│   └── prod/             # Production stack (NVIDIA GPU)
└── docs/
    └── architecture.md   # Full architecture reference
```

---

## Getting Started

### Prerequisites

- Docker + Docker Compose
- pnpm 9+
- Node.js 22+
- A self-hosted [Loops](https://github.com/joinloops/loops-server) instance (upload target)
- TikTok session cookies (`cookies.txt` in Netscape format) or a Firefox profile path

### Local Development

```bash
# Install dependencies
pnpm install

# Copy and fill in env vars
cp infra/dev/.env.example infra/dev/.env

# Start the dev stack (Temporal + backend hot-reload + Gluetun)
cd infra/dev
docker compose up -d

# The API is available at http://localhost:4001
# Temporal UI at http://localhost:8233
```

### Environment Variables

Key variables for `infra/dev/.env` (see `.env.example` for the full list):

| Variable | Description |
|---|---|
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM column encryption |
| `ADMIN_PASSWORD` | Dashboard login password |
| `SESSION_SECRET` | 32-byte hex key for session cookie signing |
| `SESSION_SALT` | 16-byte hex salt for password hashing |
| `WIREGUARD_PRIVATE_KEY` | WireGuard private key for Gluetun VPN |
| `WIREGUARD_ADDRESSES` | VPN assigned address (e.g. `10.x.x.x/32`) |

Generate secrets with:
```bash
openssl rand -hex 32   # ENCRYPTION_KEY, SESSION_SECRET
openssl rand -hex 16   # SESSION_SALT
```

---

## Pipeline

Videos flow through a Temporal workflow with the following stages:

```
DOWNLOAD_QUEUED → DOWNLOADING → DOWNLOAD_SUCCEEDED
  → TRANSCODING → TRANSCODE_SUCCEEDED
  → UPLOADING → UPLOAD_SUCCEEDED
```

Retries use exponential backoff: `1m → 2m → 4m → 32m → 60m → FAILED`.

Videos can be **ignored** at any stage — the Temporal workflow suspends in-place (preserving its current position) and resumes on unignore.

---

## Adapters

The pipeline is decoupled from specific platforms via an adapter interface:

- **Source adapters** — `discover()`, `download()`, `fetchMeta()`
- **Target adapters** — `upload()`, `test()`, `provisionMirrorAccount()` (optional)

Currently implemented: `adapter-tiktok` (source) and `adapter-loops` (target). To add a new platform, create a package implementing the interface from `@mirrorr/adapter-core` and register it — no changes to the core pipeline required.

---

## CI / Security

| Check | Tool |
|---|---|
| Secret scanning | Gitleaks (full git history) |
| Dependency audit | `pnpm audit --audit-level=high` |
| CVE scanning | Grype (filesystem + published images) |

See [docs/architecture.md](docs/architecture.md) for the full system design.
You can build a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

```
# With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended)
turbo build --filter=docs

# Without [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation), use your package manager
npx turbo build --filter=docs
yarn exec turbo build --filter=docs
pnpm exec turbo build --filter=docs
```

### Develop

To develop all apps and packages, run the following command:

```
cd my-turborepo

# With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended)
turbo dev

# Without [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation), use your package manager
npx turbo dev
yarn exec turbo dev
pnpm exec turbo dev
```

You can develop a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

```
# With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended)
turbo dev --filter=web

# Without [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation), use your package manager
npx turbo dev --filter=web
yarn exec turbo dev --filter=web
pnpm exec turbo dev --filter=web
```

### Remote Caching

> [!TIP]
> Vercel Remote Cache is free for all plans. Get started today at [vercel.com](https://vercel.com/signup?/signup?utm_source=remote-cache-sdk&utm_campaign=free_remote_cache).

Turborepo can use a technique known as [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching) to share cache artifacts across machines, enabling you to share build caches with your team and CI/CD pipelines.

By default, Turborepo will cache locally. To enable Remote Caching you will need an account with Vercel. If you don't have an account you can [create one](https://vercel.com/signup?utm_source=turborepo-examples), then enter the following commands:

```
cd my-turborepo

# With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended)
turbo login

# Without [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation), use your package manager
npx turbo login
yarn exec turbo login
pnpm exec turbo login
```

This will authenticate the Turborepo CLI with your [Vercel account](https://vercel.com/docs/concepts/personal-accounts/overview).

Next, you can link your Turborepo to your Remote Cache by running the following command from the root of your Turborepo:

```
# With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended)
turbo link

# Without [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation), use your package manager
npx turbo link
yarn exec turbo link
pnpm exec turbo link
```

## Useful Links

Learn more about the power of Turborepo:

- [Tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks)
- [Caching](https://turborepo.dev/docs/crafting-your-repository/caching)
- [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching)
- [Filtering](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters)
- [Configuration Options](https://turborepo.dev/docs/reference/configuration)
- [CLI Usage](https://turborepo.dev/docs/reference/command-line-reference)
