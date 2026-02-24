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
| Data Fetching | TanStack Query (React Query) + `EventSource` (SSE) |
| Video Download | yt-dlp CLI |
| Video Transcoding | FFmpeg + NVIDIA NVENC (h264_nvenc) |
| Validation | Zod — API request bodies, env parsing, SSE event shapes |
| Fastify–Zod bridge | `fastify-type-provider-zod` — infers route handler types from Zod schemas |
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
| `config` | text | JSON config blob — shape varies per type, see below |
| `enabled` | integer | boolean flag |

**`sources.config` JSON shape (TikTok):**
```jsonc
{
  "discoveryPlaylistLimit": 10,  // max playlist entries per poll (default 10)
  "discoveryMaxAgeDays": 3       // skip videos published more than N days ago (default 3)
}
```
Defaults come from Settings/Pipeline global config when not set on the source.

> Error tracking is on `creators` not `sources` — sources are static config, polling happens per creator.

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
| `lastTestedAt` | timestamp | When the last connection test ran |
| `lastTestOk` | integer | `1` / `0` — cached health state for UI health badges |

**`targets.config` JSON shape (Loops):**
```jsonc
{
  "maxVideoMb": 500,     // upload file size ceiling in MB (default 500)
  "retentionDays": 3    // archive videos this many days after sourcePubAt (default 3, 0 = never archive)
}
```
`retentionDays` is per-target — different targets can have different retention policies. `0` disables archival for videos uploaded to that target.

#### `creators`
Tracked creator accounts.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `handle` | text | Unique per source (composite unique with `sourceId`) |
| `sourceId` | integer FK → `sources` | Which source adapter to use |
| `targetId` | integer FK → `targets` | Upload destination (may be a mirror account target — see `targets.isMirror`) |
| `enabled` | integer | boolean — when `0` no new discovery polls are scheduled |
| `pollIntervalMs` | integer | Per-creator override; falls back to `POLL_INTERVAL_MS` |
| `maxBacklog` | integer | Discovery depth limit override |
| `lastPolledAt` / `lastDiscoveredAt` | timestamp | Audit timestamps |
| `lastPollError` | text | Last discovery error message (from Temporal activity failure) |
| `lastPollErrorAt` | timestamp | When the last poll error occurred |

> To mirror a creator to a dedicated account: use `POST /api/creators/:handle/provision-mirror` which calls the target adapter's `provisionMirrorAccount()`, creates a new `targets` row with `isMirror=1`, and updates `creator.targetId` to the new target. The creator then has one `targetId` — whether it points to a shared or mirror account is a property of the target row, not the creator.

#### `videos`
One row per discovered video. Stage is denormalized from Temporal for fast SQL queries. Full audit history lives in Temporal's event log.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `creatorId` | integer FK → `creators` | Cascades on delete |
| `sourceVideoId` | text unique | Platform video ID |
| `sourceVideoUrl` | text | Canonical source URL |
| `title` / `description` / `hashtags` | text | Metadata; `hashtags` = JSON array |
| `thumbnailUrl` | text \| null | Thumbnail URL from source metadata — nullable (yt-dlp may omit it) |
| `sourcePubAt` | timestamp | When the video was published on the source platform |
| `durationSecs` | integer | Video duration — for display and transcode decision context |
| `discoveredAt` | timestamp | When this row was inserted — for "recently found" queries |
| `stage` | enum | Current pipeline position (see §5) — never set to IGNORED |
| `isIgnored` | integer | `1` = Temporal workflow is suspended via `condition()` — display overlay, does not change `stage` |
| `stageUpdatedAt` | timestamp | When `stage` last changed — find stuck videos via SQL without hitting Temporal |
| `transcodeDecision` | enum | `passthrough` \| `encode` |
| `targetId` | integer FK → `targets` | Which target was used for this video — snapshot at upload time, survives creator retargeting |
| `targetPostId` | text | Platform post ID returned after successful upload |
| `targetPostUrl` | text | Direct URL to the published post on the target platform |
| `temporalWorkflowId` | text | `video-{id}` — correlates row to Temporal workflow |

> **Removed vs previous design:** `retryCount`, `nextRetryAt`, `bullmqJobId`, `preIgnoreStage`, `localPath`, `transcodedPath` columns are gone. `stage_transitions` and `pipeline_runs` tables are gone. `mirrorTargetId` on creators is gone — mirrors are just targets with `isMirror=1`. Temporal owns all retry/audit state.

#### `settings`
Global pipeline defaults — editable from the Settings/Pipeline UI page. Single-row table (seeded on first startup).

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | Always `1` |
| `pollIntervalMs` | integer | Global default discovery interval (default `300000` = 5 min); per-creator `pollIntervalMs` takes precedence |
| `artifactMaxAgeMs` | integer | Orphaned download/transcode file TTL for maintenance cleanup (default `7200000` = 2 h) |

---

## 5. Pipeline State Machine

Videos move through pipeline stages tracked in both Temporal (authoritative) and the `videos.stage` column (denormalized for fast queries). The `updateVideoStage` activity writes both. `isIgnored` is a separate boolean overlay — it never changes `stage`.

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

isIgnored=1: Temporal workflow suspends via condition() at its current position.
             stage column is unchanged — UI renders "DOWNLOADING (paused)", not "IGNORED".
             Signal unignore → workflow resumes from the exact suspension point.
             isIgnored reset to 0 after resumption.
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
  test(config): Promise<{ ok: boolean, latencyMs: number, message?: string }>
  provisionMirrorAccount?(config, handle: string): Promise<{ url: string, apiToken: string }>
  // provisionMirrorAccount is optional — only adapters that support auto-provisioning implement it
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
  4. Updates `creator.lastPolledAt` / `lastDiscoveredAt` and clears `lastPollError`
  5. On failure: writes error message to `creator.lastPollError` + `lastPollErrorAt`

### 7.2 `videoPipelineWorkflow`

- **WorkflowId:** `video-{videoId}` — permanent correlation key
- **Signal handler:** `pipeline-control` — accepts `{ type: 'ignore' | 'unignore' }`
  - On `ignore`: sets `videos.isIgnored = 1`, workflow suspends via `condition()` — stage column unchanged, no resources consumed
  - On `unignore`: condition resolves, workflow resumes from its suspended position, sets `videos.isIgnored = 0`
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
| `uploadVideo` | Decrypts API token + calls target adapter upload; writes `targetPostId` + `targetPostUrl` |
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
| `GET /api/stats` | Pre-aggregated dashboard stats: video counts by stage, creator totals, last discovered |
| `GET /api/creators` | List all creators with per-creator stage-count breakdown |
| `GET /api/creators/:handle` | Single creator detail |
| `POST /api/creators` | Add a creator + register Temporal schedule |
| `DELETE /api/creators/:handle?videos=delete\|keep` | Remove creator, cancel Temporal schedule; `videos=keep` retains upload history |
| `PATCH /api/creators/:handle` | Update creator settings |
| `POST /api/creators/:handle/trigger` | Manually trigger discovery workflow run |
| `POST /api/creators/:handle/provision-mirror` | Calls `target.provisionMirrorAccount()`, creates a new `targets` row (`isMirror=1`), updates `creator.targetId` to the new target |
| `GET /api/videos` | Cursor-paginated video list — `?cursor=<id>&limit=50&stage=<stage>&creatorId=<id>&sort=discoveredAt:desc` → `{ items, nextCursor, total }` |
| `GET /api/videos/:id` | Video detail + Temporal workflow deep-link |
| `POST /api/videos/:id/manage` | Send `pipeline-control` signal to Temporal workflow (ignore/unignore/retry) |
| `POST /api/videos/bulk-manage` | Bulk action by explicit IDs or filter — `{ action, videoIds? }` or `{ action, filter: { stage, creatorId } }` |
| `GET /api/settings` | Fetch global pipeline config (`pollIntervalMs`, `artifactMaxAgeMs`) |
| `PATCH /api/settings` | Update global pipeline config |
| `GET /api/sources` | List sources |
| `POST /api/sources` | Create source |
| `PATCH /api/sources/:id` | Update source (including `config` JSON with discovery tuning) |
| `DELETE /api/sources/:id` | Delete source |
| `GET /api/targets` | List targets |
| `POST /api/targets` | Create target (token stored encrypted) |
| `POST /api/targets/:id/test` | Test connectivity → `{ ok, latencyMs, testedAt }`; persists `lastTestedAt` + `lastTestOk` on target row |
| `PATCH /api/targets/:id` | Update target settings |
| `DELETE /api/targets/:id` | Delete target |
| `GET /api/events` | SSE stream — push state change events to the dashboard |

### 8.1 Real-time Updates (Server-Sent Events)

The management console requires live updates without constant polling. The pattern is:

1. **Activities write stage changes** to SQLite via `updateVideoStage`, then emit to a module-level `EventEmitter`.
2. **`GET /api/events`** subscribes to that emitter and streams events over a persistent `text/event-stream` connection.
3. **The frontend** opens one `EventSource` connection on load; React state updates on each received event.

```
Activity (worker process)
  → writes videos.stage to SQLite
  → emits event to in-process EventEmitter

GET /api/events (Fastify route)
  → subscribes to EventEmitter
  → streams named events as text/event-stream
  → cleans up listener on client disconnect

Frontend EventSource
  → listens for named events
  → triggers React state update (no re-fetch needed for stage changes)
  → auto-reconnects on drop
```

**Named event types:**

| Event | Payload | Trigger |
|---|---|---|
| `video:update` | `{ id, stage, stageUpdatedAt }` | Any stage transition |
| `creator:update` | `{ id, lastPolledAt, lastPollError? }` | Poll completion or failure |
| `stats:update` | `{ videos: { byStage }, lastDiscoveredAt }` | After discovery runs |

SSE requires no additional dependencies — `reply.raw` (Node `http.ServerResponse`) handles `text/event-stream` natively in Fastify.

For actions (ignore, retry, bulk-manage), the frontend still sends normal REST calls. SSE is strictly server → browser.

### 8.2 Request Validation with Zod

Zod is used in three places:

**1. Environment validation at startup** — fail fast with a clear error before any server code runs:

```ts
const Env = z.object({
  ENCRYPTION_KEY: z.string().length(64),
  ADMIN_PASSWORD:  z.string().min(12),
  SESSION_SECRET:  z.string().min(32),
  SESSION_SALT:    z.string().length(16),
  DATABASE_PATH:   z.string().default('./data/mirrorr.db'),
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'),
  TEMPORAL_UI_URL: z.string().optional(),
});
export const env = Env.parse(process.env); // throws with field-level error on missing
```

**2. Route body/query schemas via `fastify-type-provider-zod`** — TypeScript types flow from the schema automatically:

```ts
const CreatorBody = z.object({
  handle:        z.string().min(1),
  sourceId:      z.number().int(),
  targetId:      z.number().int(),
  pollIntervalMs: z.number().int().optional(),
});

// req.body is typed as z.infer<typeof CreatorBody> — no manual typing needed
fastify.post('/api/creators', { schema: { body: CreatorBody } }, async (req, reply) => {
  const { handle, sourceId } = req.body; // fully typed
});
```

**3. SSE event shapes** — shared via `@mirrorr/shared` so the frontend can import the same Zod schema and parse with confidence.

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
| `Settings/SourcesPage` | `/settings/sources` | Source CRUD — includes per-source discovery config (`discoveryPlaylistLimit`, `discoveryMaxAgeDays`) |
| `Settings/TargetsPage` | `/settings/targets` | Target CRUD + connection test — includes per-target `maxVideoMb`, `retentionDays` |
| `Settings/PipelinePage` | `/settings/pipeline` | Global pipeline defaults — `pollIntervalMs`, `artifactMaxAgeMs` |

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
4. Seed `settings` row (id=1) with defaults if not present
5. Backfill any creator rows with null sourceId/targetId
5. Backfill any creator rows with null sourceId/targetId
6. Connect Temporal client — verify server is reachable
7. Start Fastify server (serves API + static frontend)
8. Start Temporal worker (registers workflows + activities)
9. Re-register Temporal schedules for all enabled creators (idempotent)
10. Register maintenance cleanup schedule (6-hour interval)
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

Only infrastructure, secrets, and values that require a process restart live here. Operational tuning lives in the Settings UI (DB-backed).

### 13.1 Required secrets (no defaults — missing = startup exit)

| Variable | Description |
|---|---|
| `ENCRYPTION_KEY` | AES-256 key (64 hex chars / 32 bytes) |
| `ADMIN_PASSWORD` | Dashboard login password (min 12 chars) |
| `SESSION_SECRET` | Session cookie signing key (min 32 chars) |
| `SESSION_SALT` | Session key derivation salt (exactly 16 chars) |

### 13.2 Infrastructure (deployment topology)

| Variable | Default | Description |
|---|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server gRPC address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `mirrorr-pipeline` | Worker task queue name |
| `TEMPORAL_UI_URL` | `""` | Optional — enables deep-links in the frontend |
| `DATABASE_PATH` | `/data/pipeline.db` | SQLite file path |

### 13.3 Worker concurrency (requires worker restart to change)

| Variable | Default | Description |
|---|---|---|
| `DOWNLOAD_CONCURRENCY` | `2` | Max concurrent Temporal download activities |
| `UPLOAD_CONCURRENCY` | `2` | Max concurrent Temporal upload activities |

### 13.4 File system paths

| Variable | Default | Description |
|---|---|---|
| `TIKTOK_COOKIES_FILE` | `/data/cookies/cookies.txt` | Netscape cookies file |
| `FIREFOX_PROFILE_PATH` | `""` | Live Firefox profile path (overrides cookies file when set) |

> **Moved to Settings UI:** `POLL_INTERVAL_MS` → `settings.pollIntervalMs`, `ARTIFACT_MAX_AGE_MS` → `settings.artifactMaxAgeMs`, `DISCOVERY_PLAYLIST_LIMIT` / `DISCOVERY_MAX_AGE_DAYS` → `sources.config` JSON, `LOOPS_MAX_VIDEO_MB` / `VIDEO_RETENTION_DAYS` → `targets.config` JSON.
