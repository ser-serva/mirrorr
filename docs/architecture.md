# Mirrorr — Architecture Document

**Last Updated:** February 2026  
**Codebase:** `/mirrorr`

---

## 1. Overview

Mirrorr is a self-hosted short-form video mirroring pipeline. It discovers videos from creator accounts on source platforms (currently TikTok), downloads them via `yt-dlp`, optionally transcodes them with NVIDIA NVENC, and publishes them to a target platform (currently a self-hosted [Loops](https://github.com/Loops) instance).

The system is designed to run unattended. Temporal.io handles all workflow orchestration, durable execution, retries, and audit history — replacing a hand-rolled BullMQ queue system. A Fastify API serves the admin dashboard and drives Temporal via its client SDK.

---

## 2. Repository Layout

```
mirrorr/
├── apps/
│   ├── backend/              # Fastify API server + Temporal worker (Node.js / TypeScript)
│   │   └── src/
│   │       ├── activities/   # Temporal activity implementations
│   │       ├── workflows/    # Temporal workflow definitions (deterministic)
│   │       ├── worker.ts     # Temporal worker registration
│   │       ├── db/           # Drizzle ORM schema, migrations, seed, backfill
│   │       ├── lib/          # Column crypto, utilities
│   │       ├── plugins/      # Fastify auth plugin
│   │       ├── routes/       # REST API route handlers
│   │       └── services/     # Business logic (CreatorService, MirrorService, etc.)
│   └── frontend/             # React + Vite admin dashboard (TypeScript)
│       └── src/
│           ├── components/
│           ├── hooks/
│           ├── pages/
│           └── services/     # API client functions
├── packages/
│   ├── shared/               # @mirrorr/shared — types, enums, constants
│   ├── adapter-core/         # @mirrorr/adapter-core — SourceAdapter / TargetAdapter interfaces
│   ├── adapter-tiktok/       # @mirrorr/adapter-tiktok — TikTok discovery + download
│   ├── adapter-instagram/    # @mirrorr/adapter-instagram — stub
│   └── adapter-loops/        # @mirrorr/adapter-loops — Loops REST API upload
├── infra/
│   ├── dev/compose.yaml      # Local dev: Temporal + backend (hot-reload) + Gluetun + Firefox
│   └── prod/compose.yaml     # Production: Temporal + backend (NVIDIA GPU)
└── docs/
    └── architecture.md
```

---

## 3. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM) |
| Language | TypeScript (strict) |
| Web Framework | Fastify |
| ORM / Migrations | Drizzle ORM + drizzle-kit |
| Database | SQLite (better-sqlite3) |
| Workflow Orchestration | Temporal.io (self-hosted) |
| Monorepo Build | Turborepo + pnpm workspaces |
| Frontend Build | Vite + React 18 |
| Styling | TailwindCSS + shadcn/ui |
| Data Fetching | TanStack Query (React Query) |
| Video Download | yt-dlp CLI |
| Video Transcoding | FFmpeg + NVIDIA NVENC (h264_nvenc) |
| Auth | `@fastify/secure-session` (cookie-based, single admin) |
| Secret Storage | AES-256-GCM column encryption |
| Containerisation | Docker + Docker Compose |
| VPN | Gluetun (WireGuard) — all outbound traffic in dev |
| Testing | Vitest |

---

## 4. Database Schema

Stored as a single SQLite file at `DATABASE_PATH` (default `/data/pipeline.db`). Managed with Drizzle ORM. Temporal owns authoritative workflow state and audit history — SQLite is the fast query layer for the UI.

### 4.1 Tables

#### `sources`
Defines where content is discovered from.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `name` | text | Human label |
| `type` | enum | `tiktok` \| `instagram` \| `youtube_shorts` |
| `config` | text | JSON config blob (shape varies per type) |
| `enabled` | integer | boolean flag |
| `lastError` / `lastErrorAt` | text / timestamp | Last adapter error |

#### `targets`
Defines where content is published to.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `name` | text | Human label |
| `type` | enum | `loops` |
| `url` | text | Target API base URL |
| `apiTokenEnc` | text | AES-256-GCM ciphertext — never stored plaintext |
| `publicationConfig` | text | JSON: `titleTemplate`, `descriptionTemplate` |
| `isMirror` | integer | `1` = auto-provisioned mirror account |
| `enabled` | integer | boolean flag |

#### `creators`
Tracked creator accounts.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `handle` | text | Unique per source (composite unique with `sourceId`) |
| `sourceId` | integer FK → `sources` | Which source adapter to use |
| `targetId` | integer FK → `targets` | Default upload destination |
| `mirrorTargetId` | integer FK → `targets` | Per-creator mirror account (overrides `targetId` when set) |
| `pollIntervalMs` | integer | Per-creator override; falls back to `POLL_INTERVAL_MS` |
| `maxBacklog` | integer | Discovery depth limit override |
| `pollStage` | text | `IDLE` \| `POLLING` \| `POLL_SUCCEEDED` \| `POLL_FAILED` |
| `lastPolledAt` / `lastDiscoveredAt` | timestamp | Audit timestamps |

#### `videos`
One row per discovered video. Stage is denormalized from Temporal for fast SQL queries. Full audit history lives in Temporal's event log.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `creatorId` | integer FK → `creators` | Cascades on delete |
| `sourceVideoId` | text unique | Platform video ID |
| `sourceVideoUrl` | text | Canonical source URL |
| `title` / `description` / `hashtags` | text | Metadata; `hashtags` = JSON array |
| `stage` | enum | Denormalized pipeline stage (see §5) |
| `transcodeDecision` | enum | `passthrough` \| `encode` |
| `loopsPostId` | text | ID returned after successful upload |
| `temporalWorkflowId` | text | `video-{id}` — correlates row to Temporal workflow |

> **Removed vs previous design:** `retryCount`, `nextRetryAt`, `bullmqJobId`, `preIgnoreStage`, `localPath`, `transcodedPath` columns are gone. `stage_transitions` and `pipeline_runs` tables are gone. Temporal owns all of this.

---

## 5. Pipeline State Machine

Videos move through pipeline stages tracked in both Temporal (authoritative) and the `videos.stage` column (denormalized for fast queries). The `updateVideoStage` activity writes both.

```
DOWNLOAD_QUEUED
    │
    ▼
DOWNLOADING
    │
    ▼
DOWNLOAD_SUCCEEDED
    │
    ▼
TRANSCODING
    │
    ▼
TRANSCODE_SUCCEEDED
    │
    ▼
UPLOADING
    │
    ▼
UPLOAD_SUCCEEDED  (terminal ✓)

Failure: Temporal retry policy handles all retries automatically.
After max attempts → workflow fails → stage set to *_FAILED.

IGNORED: video can be paused via Signal at any point.
         Temporal workflow suspends on condition until unignore signal received.
```

Retry backoff is declared in the activity retry policy (not in application code):
`1 min → 2 min → 4 min → 32 min → 60 min → terminal failure`

---

## 6. Adapter System

Adapters are standalone packages under `packages/`. The backend never imports adapter implementations directly — it resolves them at runtime via the registry using the `source.type` / `target.type` string.

### 6.1 `@mirrorr/adapter-core`

Defines the interfaces only. No implementation.

```typescript
interface SourceAdapter {
  discover(config, ctx): Promise<{ videos: VideoMetadata[], failures: DiscoveryFailure[] }>
  download(config, url, destDir): Promise<string>          // returns local path
  fetchMeta(config, url): Promise<VideoMetadata>
}

interface TargetAdapter {
  upload(config, video, filePath): Promise<{ postId: string }>
  test(config): Promise<{ ok: boolean, message?: string }>
}
```

### 6.2 `@mirrorr/adapter-tiktok`

Active implementation. Uses `yt-dlp` CLI for discovery and download. Cookie authentication via:
- `--cookies <file>` (Netscape `cookies.txt`)
- Or `--cookies-from-browser firefox:<path>` when `FIREFOX_PROFILE_PATH` is set

### 6.3 `@mirrorr/adapter-instagram`

Stub — throws `AdapterNotImplementedError` on all methods.

### 6.4 `@mirrorr/adapter-loops`

Active implementation. Uploads video files and metadata to a self-hosted Loops instance via REST API. API token is decrypted from `target.apiTokenEnc` in-memory at call time.

### 6.5 Adding a new adapter

1. Create `packages/adapter-<name>/`
2. Implement `SourceAdapter` or `TargetAdapter` from `@mirrorr/adapter-core`
3. Register in the backend registry (`getSourceAdapter` / `getTargetAdapter`)
4. Add the type value to the `sources.type` or `targets.type` enum in the DB schema

The backend, workflows, and activities require zero changes.

---

## 7. Temporal Workflow Architecture

All async pipeline work is orchestrated through Temporal. The backend registers a single Temporal worker that handles both workflows and activities.

```
creatorDiscoveryWorkflow (scheduled)
    │
    └─► discoverCreatorVideos (activity)
            │ inserts new video rows
            └─► startChild videoPipelineWorkflow per new video

videoPipelineWorkflow (workflowId: "video-{id}")
    │
    ├─► updateVideoStage(DOWNLOADING)
    ├─► downloadVideo
    ├─► updateVideoStage(TRANSCODING)
    ├─► transcodeVideo
    ├─► updateVideoStage(UPLOADING)
    ├─► uploadVideo
    ├─► cleanupArtifacts
    └─► updateVideoStage(UPLOAD_SUCCEEDED)
```

### 7.1 `creatorDiscoveryWorkflow`

- **Triggered by:** Temporal Schedule (one per creator, keyed `discover-{handle}`)
- **Actions:**
  1. Calls `discoverCreatorVideos` activity
  2. Inserts new `videos` rows at `DOWNLOAD_QUEUED`
  3. Starts a child `videoPipelineWorkflow` per new video (idempotent — duplicate `workflowId` starts are no-ops)
  4. Updates `creator.pollStage` and timestamps

### 7.2 `videoPipelineWorkflow`

- **WorkflowId:** `video-{videoId}` — permanent correlation key
- **Signal handler:** `pipeline-control` — accepts `{ type: 'ignore' | 'unignore' }`
  - On `ignore`: workflow suspends via `condition()` — no polling, no resource use
  - On `unignore`: workflow resumes from where it paused
- **Retry policy (all activities):**
  - `maximumAttempts: 6`
  - `initialInterval: 1m`, `backoffCoefficient: 2`, `maximumInterval: 1h`
  - Terminal failure after attempt 6 → workflow fails → stage written to `*_FAILED`

### 7.3 Activities

| Activity | Description |
|---|---|
| `discoverCreatorVideos` | Polls creator feed via source adapter; inserts new video rows |
| `downloadVideo` | Downloads video via source adapter yt-dlp to `/data/downloads/` |
| `transcodeVideo` | FFmpeg probe + optional NVENC encode to `/data/transcodes/` |
| `uploadVideo` | Decrypts API token + calls target adapter upload; writes `loopsPostId` |
| `cleanupArtifacts` | Deletes local download and transcode files after successful upload |
| `updateVideoStage` | Writes denormalized stage to `videos.stage` in SQLite |

Activities contain no retry logic — that is entirely declared in the workflow's `proxyActivities` retry policy.

---

## 8. REST API

All endpoints under `/api/*` require an authenticated admin session (cookie). Auth managed by `@fastify/secure-session`.

| Route | Description |
|---|---|
| `POST /login` / `POST /logout` | Session auth |
| `GET /health` | Liveness check (Temporal connectivity, DB status) |
| `GET /api/config` | Returns `{ temporalUiUrl }` for frontend deep-links |
| `GET /api/creators` | List creators with stage-count breakdown |
| `POST /api/creators` | Add a creator + register Temporal schedule |
| `DELETE /api/creators/:handle` | Remove creator, cancel Temporal schedule, cascade videos |
| `PATCH /api/creators/:handle` | Update creator settings |
| `POST /api/creators/:handle/trigger` | Manually trigger discovery workflow run |
| `POST /api/creators/:handle/provision-mirror` | Provision mirror account on target |
| `GET /api/videos` | Paginated video list with filters (SQL query on `videos` table) |
| `GET /api/videos/:id` | Video detail + link to Temporal workflow |
| `POST /api/videos/:id/manage` | Send `pipeline-control` signal to Temporal workflow (ignore/unignore/retry) |
| `POST /api/videos/bulk-manage` | Bulk signal across multiple workflows |
| `GET /api/sources` | List sources |
| `POST /api/sources` | Create source |
| `PATCH /api/sources/:id` | Update source |
| `DELETE /api/sources/:id` | Delete source |
| `GET /api/targets` | List targets |
| `POST /api/targets` | Create target (token stored encrypted) |
| `POST /api/targets/:id/test` | Test target connectivity |
| `DELETE /api/targets/:id` | Delete target |

---

## 9. Frontend (Admin Dashboard)

Single-page React app built with Vite. In production, served as static files by Fastify. In dev, Vite HMR server runs on the host and proxies `/api/*` to the backend port.

The frontend is a **management console** — it controls what the system should do. Temporal UI is the operational/debugging interface.

**Pages:**

| Page | Route | Description |
|---|---|---|
| `LoginPage` | `/login` | Single-admin password form |
| `Dashboard` | `/` | Per-creator stage-count summary, recent activity |
| `VideoListPage` | `/videos` | Paginated, filterable list; ignore/unignore/retry actions |
| `VideoDetail` | `/videos/:id` | Metadata + "View in Temporal ↗" deep-link (when `TEMPORAL_UI_URL` set) |
| `CreatorsPage` | `/creators` | Add, remove, enable/disable creators; provision mirror accounts |
| `Settings/SourcesPage` | `/settings/sources` | Source CRUD |
| `Settings/TargetsPage` | `/settings/targets` | Target CRUD + connection test |

**Temporal deep-link pattern:**

The frontend calls `GET /api/config` on startup. If `temporalUiUrl` is returned, "View in Temporal ↗" links appear on video detail and creator pages. If not set, links are hidden — the app works fully without Temporal UI running.

```
Video workflow:  {temporalUiUrl}/namespaces/default/workflows/video-{id}
Creator schedule: {temporalUiUrl}/namespaces/default/schedules/discover-{handle}
Failed workflows: {temporalUiUrl}/namespaces/default/workflows?status=Failed
```

---

## 10. Infrastructure

### 10.1 Development

`infra/dev/compose.yaml`:

| Container | Role |
|---|---|
| `gluetun` | Gluetun WireGuard VPN gateway — all outbound traffic from backend via VPN |
| `backend` | Backend in hot-reload mode (`tsx watch`); network namespace inside gluetun |
| `temporal` | Temporal server (`auto-setup` image, SQLite backend) |
| `temporal-ui` | Temporal Web UI on port 8080 |
| `firefox` | Firefox inside container (noVNC on port 3002) for TikTok cookie management |

Frontend Vite dev server runs on the host (`pnpm dev --filter frontend`) and proxies `/api` to `localhost:4001`.

`FIREWALL_OUTBOUND_SUBNETS` allows traffic to Docker bridge (host.docker.internal → local Loops instance) to bypass the VPN.

### 10.2 Production

`infra/prod/compose.yaml`:

| Container | Role |
|---|---|
| `backend` | Combined Fastify API + Temporal worker (serves static frontend) |
| `temporal` | Temporal server (`auto-setup` image, PostgreSQL backend for durability) |
| `temporal-ui` | Temporal Web UI on port 8080 |
| `postgres` | PostgreSQL — Temporal persistence backend (prod only) |

NVIDIA Container Toolkit required on the host for GPU transcoding. The service mounts `/data` for SQLite, downloads, transcodes, and cookies.

---

## 11. Startup Sequence

```
1. Validate env secrets — exit immediately on missing required vars
2. Run Drizzle ORM migrations
3. Seed default source + target rows if not present
4. Backfill any creator rows with null sourceId/targetId
5. Connect Temporal client — verify server is reachable
6. Start Fastify server (serves API + static frontend)
7. Start Temporal worker (registers workflows + activities)
8. Re-register Temporal schedules for all enabled creators (idempotent)
9. Register maintenance cleanup schedule (6-hour interval)
```

---

## 12. Security

| Concern | Implementation |
|---|---|
| API token storage | AES-256-GCM with random IV; key from `ENCRYPTION_KEY` env var |
| Session auth | `@fastify/secure-session`; single `ADMIN_PASSWORD`; `SESSION_SECRET` + `SESSION_SALT` |
| Startup validation | All 4 required secrets checked at start; missing = immediate exit |
| Shell injection | yt-dlp invoked via `child_process.spawn` with argument arrays (no shell interpolation) |
| Token in memory only | `target.apiTokenEnc` decrypted inside `uploadVideo` activity, plaintext never persisted |

---

## 13. Key Configuration Variables

| Variable | Default | Description |
|---|---|---|
| `ENCRYPTION_KEY` | required | AES-256 key (32-byte hex) |
| `ADMIN_PASSWORD` | required | Dashboard login password |
| `SESSION_SECRET` | required | Session cookie key (32+ bytes) |
| `SESSION_SALT` | required | Session key derivation salt (16 chars) |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server gRPC address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `mirrorr-pipeline` | Worker task queue name |
| `TEMPORAL_UI_URL` | `""` | Optional — enables deep-links in frontend |
| `DATABASE_PATH` | `/data/pipeline.db` | SQLite file path |
| `POLL_INTERVAL_MS` | `300000` (5 min) | Global discovery poll interval |
| `DISCOVERY_PLAYLIST_LIMIT` | `10` | Max playlist entries per poll |
| `DISCOVERY_MAX_AGE_DAYS` | `3` | Skip videos older than this |
| `DOWNLOAD_CONCURRENCY` | `2` | Temporal worker max concurrent download activities |
| `UPLOAD_CONCURRENCY` | `2` | Temporal worker max concurrent upload activities |
| `LOOPS_MAX_VIDEO_MB` | `500` | Upload file size ceiling |
| `ARTIFACT_MAX_AGE_MS` | `7200000` (2 h) | Orphaned file TTL for maintenance cleanup |
| `TIKTOK_COOKIES_FILE` | `/data/cookies/cookies.txt` | Netscape cookies file |
| `FIREFOX_PROFILE_PATH` | `""` | Live Firefox profile path (overrides cookies file) |
