# Mirrorr — Domain Context Map

**Last Updated:** March 2026  
**Status:** Working draft — evolves alongside the spec backlog

---

## 1. Purpose

This document maps the bounded contexts in mirrorr, their responsibilities, the language each owns, and how they integrate. It is the reference for design decisions about where new behaviour belongs, what constitutes a domain boundary, and how contexts communicate without bleeding into each other.

---

## 2. System Context (one-liner)

> Mirrorr discovers short-form videos from source platforms and publishes them to target platforms under creator-specific accounts — automatically, durably, and without the creator's involvement after initial setup.

---

## 3. Bounded Context Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           mirrorr system                                │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────────────┐   │
│  │   Creator    │    │   Pipeline   │    │   Source (per-type)     │   │
│  │  Management  │───▶│Orchestration │◀───│  TikTok / Instagram /   │   │
│  │              │    │  (Temporal)  │    │  YouTube Shorts         │   │
│  └──────┬───────┘    └──────┬───────┘    └─────────────────────────┘   │
│         │                   │                                           │
│         ▼                   ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Target Domain                                 │   │
│  │  ┌─────────────────────────┐  ┌──────────────────────────────┐  │   │
│  │  │  Target Connection      │  │  Mirror Account              │  │   │
│  │  │  Service                │  │  Lifecycle                   │  │   │
│  │  │  (resolves + uploads)   │  │  (provision / refresh /      │  │   │
│  │  │                         │  │   delete)                    │  │   │
│  │  └─────────────────────────┘  └──────────────────────────────┘  │   │
│  │                                                                  │   │
│  │  ┌──────────────┐  ┌──────────────┐                             │   │
│  │  │  Adapter:    │  │  Adapter:    │  … (pluggable per type)     │   │
│  │  │  Loops       │  │  (future)    │                             │   │
│  │  └──────────────┘  └──────────────┘                             │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────┐    ┌──────────────────────────────────────────────┐   │
│  │  Settings /  │    │   Admin Dashboard (read-mostly, thin)        │   │
│  │  Config      │    │   REST API surface + SSE event bus           │   │
│  └──────────────┘    └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Bounded Contexts

### 4.1 Creator Management

**Responsibility:** Everything about *who* is being mirrored and *which connections* they use. Tracks creator handles, their source connection (which platform, which config), their target connection (where videos go), and scheduling preferences.

**What it owns:**
- Creator identity (`handle` + `sourceId` — composite unique key)
- Active target reference — a single pointer to the effective upload target
- Scheduling configuration (`pollIntervalMs`, `maxBacklog`, `initialSyncWindowDays`)
- Discovery audit timestamps (`lastPolledAt`, `lastDiscoveredAt`, `lastPollError`)
- Enabled/disabled state

**What it does NOT own:**
- How targets are connected, provisioned, or managed — that is Target Domain
- How videos are discovered or downloaded — that is Source context
- How pipeline steps are ordered or retried — that is Pipeline Orchestration

**Key aggregate root:** `Creator`  
**Key invariant:** A creator has exactly one effective target reference and one source reference. It does not store multiple targets or fallback chains.

**Integration points:**
- Asks Target Domain: "give me an upload connection for creator X" (`TargetConnectionService.resolveUploadTarget`)
- Asks Target Domain: "provision a mirror account for creator X against this admin target" (`TargetConnectionService.provisionMirror`)
- Asks Pipeline: "start discovery for creator X now" (triggers Temporal workflow)

**Language:**
- *Creator* — a tracked content source account (e.g. a TikTok handle)
- *Source connection* — the source the creator is discovered on
- *Target connection* — the upload destination for this creator (opaque — creator doesn't know if it's a mirror or admin)
- *Poll interval* — how often this creator's videos are checked
- *Sync window* — how far back to consider videos on first sync

---

### 4.2 Target Domain

**Responsibility:** Everything about *where* content is published. Owns the full lifecycle of upload destinations — admin targets, mirror targets, their credentials, their configuration, their health state, and how they relate to each other.

**What it owns:**
- Target records (admin and mirror)
- Encrypted credentials per target
- Target configuration (upload limits, retention, transcode preferences, `mirroringEnabled` flag)
- Parent-child relationship between mirror and admin targets
- Health/connection test state
- Mirror account lifecycle (provision, refresh, delete) — delegated to adapters

**What it does NOT own:**
- Which creator uses which target — that is Creator Management
- How the target platform works internally — that is the adapter implementation
- Video metadata — that is Pipeline / Video

**Key aggregate root:** `Target` (an admin target is the root; mirror targets belong to their admin parent)  
**Key invariants:**
- Hierarchy depth = 1. A mirror target has exactly one admin parent. Admin targets have no parent.
- A target with `parentTargetId` set has `isMirror = true`.
- `mirroringEnabled` lives on the admin target. It is the admin target's decision, not the creator's.

**Sub-domains:**

| Sub-domain | Responsibility |
|---|---|
| **Target Configuration** | Stores and validates target settings: upload size limits, retention policy, transcode adapter preference, `mirroringEnabled` |
| **Target Hierarchy** | Models the admin → mirror parent-child relationship; enforces single-level constraint; provides config inheritance (mirror falls back to admin for any unset field) |
| **Mirror Account Lifecycle** | Provision (find-or-create), refresh (reset tokens), delete (and revert creator to admin target) — all delegated to the adapter via `MirrorCapableTargetAdapter` |
| **Target Connection Service** | The boundary: resolves a fully-baked `TargetConnection` (credentials + merged config) for any creator, traverses hierarchy for config inheritance, handles `mirroringEnabled` routing |

**Integration points:**
- Exposes `TargetConnectionService` to Creator Management and Pipeline
- Calls `TargetAdapter` implementations for upload and connectivity test
- Calls `MirrorCapableTargetAdapter` implementations for mirror lifecycle operations

**Language:**
- *Admin target* — a manually registered upload destination; credentials belong to the operator
- *Mirror target* — an auto-provisioned per-creator account on the same platform; credentials are creator-specific
- *Parent target* — the admin target for a given mirror target
- *Effective target* — whichever target a creator ultimately uploads to (may be admin or mirror, caller doesn't know)
- *Target connection* — a resolved, ready-to-use object containing decrypted credentials + merged config
- *Mirroring enabled* — the admin target's flag indicating per-creator accounts should be used
- *Provision* — create (or find-and-map) a mirror account on the remote platform
- *Refresh* — reset credentials on an existing mirror account
- *Delete* — remove the mirror account from the remote platform and revert the creator

---

### 4.3 Source Context (per adapter type)

**Responsibility:** Platform-specific logic for discovering and downloading content. Each source type is a separate adapter. The context is bounded by the adapter interface — mirrorr's internals never know which platform they are talking to.

**What it owns:**
- Discovery logic (crawl, RSS, API polling)
- Download logic (yt-dlp invocation, auth/cookie handling)
- Platform-specific metadata normalisation (title, hashtags, publish date, duration)

**What it does NOT own:**
- Creator records
- Storage or database state
- Retry or scheduling logic — that is Pipeline

**Key interface exposed:** `SourceAdapter` (`discover`, `download`, `fetchMeta`)

**Current adapters:**

| Adapter | Status |
|---|---|
| `@mirrorr/adapter-tiktok` | Active — yt-dlp with cookie/Firefox profile auth |
| `@mirrorr/adapter-instagram` | Stub — throws `AdapterNotImplementedError` |
| `@mirrorr/adapter-youtube-shorts` | Stub |

**Language:**
- *Discovery* — finding new video URLs for a creator handle
- *Download* — fetching the video file to local storage
- *Source video ID* — the platform's own identifier for a video (deduplication key)

---

### 4.4 Pipeline Orchestration

**Responsibility:** Durable, ordered execution of the per-video processing sequence. Owns the video lifecycle state machine and scheduling of per-creator discovery. Does NOT contain business logic — it delegates all work to activities, which delegate to adapters or services.

**What it owns:**
- Workflow definitions (deterministic, no I/O)
- Activity implementations (I/O, adapters, DB writes)
- Video stage machine (`DOWNLOAD_QUEUED` → … → `UPLOAD_SUCCEEDED` or `*_FAILED`)
- Retry policies (declared, not coded)
- `isIgnored` suspension/resume signalling

**What it does NOT own:**
- Platform-specific logic — adapters handle that
- Target configuration resolution — Target Connection Service handles that
- Creator scheduling preferences — Creator Management owns that (pipeline reads it)

**Aggregate-like notion:** `VideoWorkflow` — one Temporal workflow per video, WorkflowId = `video-{id}`

**Key activities:**

| Activity | Delegates to |
|---|---|
| `discoverCreatorVideos` | Source adapter (`discover`) |
| `downloadVideo` | Source adapter (`download`) |
| `transcodeVideo` | Transcode adapter (per `001-transcode-adapters` spec) |
| `uploadVideo` | `TargetConnectionService.resolveUploadTarget` → Target adapter (`upload`) |
| `cleanupArtifacts` | Filesystem |
| `updateVideoStage` | SQLite + SSE bus |

**Language:**
- *Stage* — current position in the pipeline (denormalized from Temporal to SQLite)
- *Ignored* — a suspended workflow; stage is unchanged, loop is paused
- *Workflow* — a Temporal durable execution unit for one video
- *Activity* — a single retryable unit of work within a workflow

---

### 4.5 Settings / Config

**Responsibility:** Global runtime configuration. Operator-editable without deploying. Provides defaults when per-entity config is absent.

**What it owns:**
- Global `pollIntervalMs` (default discovery interval)
- Global `artifactMaxAgeMs` (orphaned file TTL)

**Intentionally thin.** Most config has migrated to entity-level JSON blobs (`sources.config`, `targets.config`). The settings table is for system-wide operational knobs only.

---

### 4.6 Admin Dashboard

**Responsibility:** Thin read-mostly interface for the operator. Presents state from SQLite (fast queries) and Temporal (deep-links for workflow history). Drives actions via REST. Receives live updates via SSE.

**What it owns:**
- REST API surface (request validation, auth, response shaping)
- SSE event bus (push updates to connected browsers)
- Frontend (Creator, Video, Target, Source, Settings pages)

**What it does NOT own:**
- Business rules — it calls services and activities
- State — it reads from SQLite; Temporal owns authoritative audit state

---

## 5. Context Integration Map

```
Creator Management
  │
  │  resolveUploadTarget(creatorId)         [Customer/Supplier]
  │  provisionMirror(creatorId, adminTargetId)
  │  refreshMirror(creatorId)
  │  deleteMirror(creatorId)
  ▼
Target Domain  ──────────────────────────────────────────────────────────►  Target Platform (Loops, …)
  (TargetConnectionService)    [Conformist — wraps platform API exactly as-is]    (adapter)
  
Creator Management → Pipeline Orchestration
  [Notification — creator triggers a Temporal workflow start]

Pipeline Orchestration → Source Context
  [Downstream — pipeline calls adapter.discover() / adapter.download()]

Pipeline Orchestration → Target Domain
  [Downstream — pipeline calls TargetConnectionService.resolveUploadTarget()]
  [Never calls adapters directly]

Pipeline Orchestration → Settings / Config
  [Downstream — reads defaults when per-creator/per-source config absent]

Admin Dashboard → all contexts
  [Open Host Service — REST + SSE; thin translation layer; no business logic]
```

### Integration patterns in use

| Pair | Pattern | Notes |
|---|---|---|
| Pipeline → Target | **Downstream via ACL** | `TargetConnectionService` is the Anti-Corruption Layer. Pipeline never sees `isMirror`, `parentTargetId`, `mirroringEnabled`. |
| Pipeline → Source | **Downstream (conformist)** | Pipeline hands `source.config` (opaque JSON) directly to adapter; no translation needed. |
| Creator → Target | **Customer/Supplier** | Creator Management is the customer — it drives what connections it needs. Target Domain supplies them via a defined service interface. |
| Adapter → Platform | **Conformist** | Adapter wraps platform API as-is; quirks contained inside the adapter. |
| Dashboard → All | **Open Host Service** | REST API is the published integration point. Other contexts don't need to know the dashboard exists. |

---

## 6. Ubiquitous Language

Terms that have precise meaning within this system. Use these consistently in code, specs, and conversation to avoid ambiguity.

| Term | Meaning |
|---|---|
| **Creator** | A tracked content source account (e.g. a TikTok handle). A user of the source platform we are mirroring. |
| **Source** | A registered source platform configuration. One source can serve many creators. |
| **Target** | A registered upload destination. May be an admin target or a mirror target. |
| **Admin target** | A manually registered target using the operator's own credentials. `isMirror = false`. |
| **Mirror target** | An auto-provisioned per-creator account on a target platform. `isMirror = true`, has a `parentTargetId`. |
| **Parent target** | The admin target that a mirror target was provisioned from. |
| **Effective target** | The target a creator's next video will be uploaded to. Opaque outside Target Domain. |
| **Mirroring enabled** | Admin target config flag. When `true`, per-creator mirror accounts are used for upload instead of the admin account. |
| **Target connection** | A fully resolved, ready-to-use upload context (credentials + merged config). Output of `TargetConnectionService.resolveUploadTarget`. |
| **Provision** | Create (or find-and-map if already exists) a mirror account on the target platform. |
| **Refresh** | Reset credentials on an existing mirror account (e.g. after token expiry). |
| **Stage** | Current position of a video in the pipeline state machine. Denormalized from Temporal to SQLite. |
| **Ignored** | A video whose Temporal workflow is suspended. Stage is unchanged; processing resumes on un-ignore signal. |
| **Discovery** | The process of finding new video URLs for a creator handle on a source platform. |
| **Backlog** | Historical videos found during discovery that have not yet been processed. |
| **Sync window** | On first discovery only — the maximum age (in days) of videos to include. Prevents flooding the pipeline with years of history. |
| **Pipeline** | The ordered sequence of activities that takes a video from discovered to uploaded. |
| **Workflow** | A single Temporal durable execution for one video. |
| **Activity** | A single, retryable unit of work within a workflow. |
| **Transcode adapter** | Plugin that handles video encoding (CPU or GPU-accelerated). Config lives on the target. |

---

## 7. Key Design Tensions & Decisions

### T-001: Mirror decisions belong to Target Domain, not Creator Management

**Tension:** A creator's upload behaviour changes based on whether mirroring is enabled. It's tempting to put `mirroringEnabled` on the creator.

**Resolution:** `mirroringEnabled` is an admin target configuration. The admin target sets the upload strategy for all creators that use it. Creators don't decide this — they just hold a reference to their effective target. The Target Connection Service resolves what "effective" means. See spec `007-target-hierarchy`.

---

### T-002: Configuration inheritance should not leak outside Target Domain

**Tension:** Transcode adapter settings, upload limits, and retention are target-level config. Mirror targets may not set all fields, so fallback to the parent admin target is needed. This inheritance chain could pollute activity code.

**Resolution:** `TargetConnectionService.resolveUploadTarget` returns a fully merged `TargetConnection`. Callers receive only the resolved values; the inheritance traversal is entirely internal to the Target Domain. See specs `007-target-hierarchy` and `001-transcode-adapters`.

---

### T-003: More complex targets shouldn't require changes to the pipeline

**Tension:** Each time we add a new target platform, or add new target capabilities (mirroring, transcode config), would pipeline activities need to change?

**Resolution:** The `TargetConnectionService` ACL absorbs all target-domain changes. `MirrorCapableTargetAdapter` adds mirror lifecycle methods without changing the base `TargetAdapter` interface. Pipeline activities only depend on the service interface — they are not aware of which adapter is behind it.

---

### T-004: provisionMirrorAccount must be idempotent

**Tension:** If provisioning succeeds on the remote platform but the DB write fails, a retry would attempt to create a duplicate remote account.

**Resolution:** `provisionMirrorAccount` on the adapter MUST implement a find-or-create guard: detect an existing account for the handle and return its credentials rather than erroring or duplicating. This makes the entire creator registration flow safe to retry from any failure point.

---

### T-005: Creator should not know whether it uploads to an admin or mirror target

**Tension:** `effectiveTargetId = creator.mirrorTargetId ?? creator.targetId` is already in the upload activity. This pattern would also be needed in transcode config resolution, in health checks, in UI display — every time it reappears the domain boundary erodes further.

**Resolution:** Creator holds a single `targetId` — always the effective target. If mirroring is provisioned, the creator's `targetId` is updated to the mirror target. The admin target relationship is expressed as `mirror.parentTargetId`, owned by Target Domain. Creator Management never traverses this. See spec `007-target-hierarchy`.

---

## 8. Spec Dependency Order

Based on this context map, the implementation sequence that minimizes rework:

```
007-target-hierarchy  (data model + TargetConnectionService contract)
        │
        ├─► 001-transcode-adapters  (TranscodeAdapter interface + target config inheritance)
        │         depends on: TargetConnectionService.resolveUploadTarget returns merged config
        │
        └─► (future) new target platform adapter
                  depends on: TargetAdapter / MirrorCapableTargetAdapter contract is stable
```

---

## 9. Open Questions

> These are unresolved at time of writing. Update as decisions are made.

- **Q1: Should `TargetConnectionService` be a Temporal activity or a plain service?**  
  Currently assumed to be an injected plain service called from activities. If target operations become long-running (e.g. remote provisioning takes seconds), they may need to become Temporal activities themselves with heartbeating.

- **Q2: What is the retry model for `refreshMirror` and `deleteMirror`?**  
  These are operator-triggered — not currently invoked from Temporal workflows. If they are exposed via REST only, they fail or succeed synchronously. If they need durability (e.g. delete involves remote API + DB atomicity), they should be Temporal activities.

- **Q3: What happens to existing video rows when a creator's mirror target is deleted?**  
  Video rows have a snapshot `targetId` at upload time. They should not be affected. But the question of whether old videos are still reachable on the old mirror account (which may be deleted from the platform) needs a UX decision.

- **Q4: Multi-target support (one creator → multiple targets)?**  
  Not in scope. Single target per creator is a firm constraint today. Document the constraint explicitly if it affects API design.
