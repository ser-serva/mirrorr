# Mirrorr — Domain Context Map

**Last Updated:** March 2026  
**Status:** Working draft — evolves alongside the spec backlog

---

## 1. Purpose

This document maps the bounded contexts in mirrorr, their responsibilities, the language each owns, and how they integrate. It is the **system-level reference** for design decisions about where new behaviour belongs, what constitutes a domain boundary, and how domains communicate without bleeding into each other.

This document sits above individual feature specs in the three-tier hierarchy:

```
System Level   →  Domain Interaction Specs  (this document)
Domain Level   →  Domain Behaviour Specs
Feature Level  →  Feature Specs (SpecKit)
```

---

## 2. System Context

> Mirrorr configures connections to source content platforms, discovers videos per creator, downloads content, optionally processes it to meet target platform requirements, and re-uploads it to target platforms under per-creator mirror accounts — automatically, durably, and without creator involvement after initial setup.

---

## 3. Domain Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                             mirrorr system                                   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                       Pipeline Domain                               │    │
│  │           (general-purpose orchestration engine)                    │    │
│  │                                                                     │    │
│  │   ┌──────────────────────────┐   ┌───────────────────────────┐     │    │
│  │   │    Content Workflow      │   │   Provisioning Workflow    │     │    │
│  │   │  spec: Video Domain      │   │   spec: Creator Domain     │     │    │
│  │   │  discovered → published  │   │   creator_discovered →     │     │    │
│  │   │                          │   │   mirror_ready             │     │    │
│  │   └──────────────────────────┘   └───────────────────────────┘     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│          ▲ triggers              ▲ triggers             ▲                    │
│          │                      │                       │                    │
│  ┌───────┴──────┐   ┌───────────┴──────┐   ┌───────────┴──────────────┐    │
│  │   Creator    │   │   Video /        │   │      Target Domain        │    │
│  │   Domain     │   │   Content Domain │   │                           │    │
│  │              │   │                  │   │  ┌─────────────────────┐  │    │
│  │  "who is     │   │  "the content    │   │  │  Target Parent      │  │    │
│  │   mirrored"  │   │   item journey"  │   │  │  (admin account)    │  │    │
│  │              │   │                  │   │  │  config + lifecycle  │  │    │
│  └──────┬───────┘   └──────┬───────────┘   │  └────────┬────────────┘  │    │
│ needs   │      content     │               │  parent   │               │    │
│ mirror  ▼(event)  items    ▼(upload)       │  ┌────────▼────────────┐  │    │
│      [contract]         [service call]     │  │  Target Child       │  │    │
│         └────────────────────────────────► │  │  (mirror account)   │  │    │
│                                            │  │  upload + processing│  │    │
│                                            │  └─────────────────────┘  │    │
│                                            │  TargetConnectionService   │    │
│                                            │  (ACL — single boundary)   │    │
│                                            └───────────────────────────┘    │
│                                                         │ adapter            │
│  ┌──────────────────────────────┐                       ▼                   │
│  │       Source Domain          │              Target Platform (Loops …)    │
│  │  (per-type, pluggable)       │                                           │
│  └──────────────────────────────┘                                           │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  API Layer — entry point only; translates requests to workflow        │   │
│  │  starts; reads state; no business logic; not a domain                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Domains

### 4.1 Source Domain
*"I know how to get content from a source platform."*

**Responsibility:** Platform-specific logic for discovering and downloading content. Each source type is a separate adapter. The context is fully bounded by the adapter interface — the rest of mirrorr never knows which platform it is talking to.

**Owns:**
- Connection configuration to the source platform
- Authentication and API client (cookies, OAuth, rate-limiting, pagination)
- Discovery logic (crawl, RSS, API polling)
- Download logic (yt-dlp invocation, auth/cookie handling)
- Platform-specific metadata normalisation (title, hashtags, publish date, duration)

**Does NOT own:**
- Creator records or state
- Database state
- Retry or scheduling logic — that is Pipeline Domain

**Key invariant:** No other domain knows the specifics of the source platform API — only Source does.

**Key interface exposed:** `SourceAdapter` (`discover`, `download`, `fetchMeta`)

**Current implementations:**

| Adapter | Status |
|---|---|
| `@mirrorr/adapter-tiktok` | Active — yt-dlp with cookie/Firefox profile auth |
| `@mirrorr/adapter-instagram` | Stub |
| `@mirrorr/adapter-youtube-shorts` | Stub |

---

### 4.2 Target Domain
*"I know how to receive, process, and host content on the target platform."*

**Responsibility:** Everything about *where* content is published. Owns the full lifecycle of upload destinations — admin accounts, per-creator mirror accounts, their credentials, their configuration, and the parent-child relationship between them. Processing logic (transcoding, metadata normalisation, format conversion) **also lives here** because processing rules are target-platform-specific: what matters is what the target platform requires, not what the source provides.

**Internal structure — Parent / Child:**

- **Target Parent (admin target)** — manually registered by the operator. Owns admin credentials, platform-level configuration (`mirroringEnabled`, upload limits, transcode preferences, retention policy), and the full lifecycle of child accounts it spawns.
- **Target Child (mirror target)** — auto-provisioned per-creator account on the same platform. Encapsulates all mirroring behaviour for one creator: their profile, upload credentials, and the processing applied to their content. Inherits any unset config from the parent.

**Owns:**
- Target records (parent and child) with encrypted credentials
- `mirroringEnabled` flag — the parent's decision about upload strategy for all its creators; not a creator concern
- Parent-child relationship (hierarchy depth = 1, enforced at write time)
- Config inheritance: child inherits any unset field from parent, then system default
- Mirror account lifecycle: provision (find-or-create), refresh, delete — delegated to `MirrorCapableTargetAdapter`
- Connection health state (`lastTestedAt`, `lastTestOk`)
- Processing configuration (transcode adapter selection, format requirements)

**Does NOT own:**
- Which creator uses which target — that is Creator Domain
- The mechanics of the target platform API — that is the adapter
- Content item state — that is Video Domain

**Key invariants:**
- Hierarchy depth = 1. A child target has exactly one parent. Parents have no parent.
- Any target with `parentTargetId` set has `isMirror = true`.
- `mirroringEnabled` lives on the parent target only.
- No other domain traverses or interprets the parent-child relationship.

**`TargetConnectionService`** is the Anti-Corruption Layer (ACL) exposed to all callers. It returns a fully resolved `TargetConnection` (decrypted credentials + merged config with all inheritance applied). Callers never see `isMirror`, `parentTargetId`, `mirroringEnabled`, or any hierarchy fields.

**Key interfaces:**
- `TargetAdapter` — base: `upload`, `test`
- `MirrorCapableTargetAdapter` — extends base: `provisionMirrorAccount`, `refreshMirrorAccount`, `deleteMirrorAccount`
- `TargetConnectionService` — domain boundary: `resolveUploadTarget`, `provisionMirror`, `refreshMirror`, `deleteMirror`

---

### 4.3 Creator Domain
*"I know who the creators are and coordinate their presence across platforms."*

**Responsibility:** Creator profiles, source identity, mapping to a mirror presence on the target platform, and scheduling preferences.

**Owns:**
- Creator identity (`handle` + `sourceId` — composite unique key)
- Single effective target reference (always the actual upload target — no fallback chains, no second target field)
- Scheduling configuration (`pollIntervalMs`, `maxBacklog`, `initialSyncWindowDays`)
- Discovery audit state (`lastPolledAt`, `lastDiscoveredAt`, `lastPollError`)
- Enabled/disabled state
- The **provisioning workflow spec** (the ordered steps to take a creator from discovered to mirror-ready)

**Does NOT own:**
- How targets are provisioned or managed — that is Target Domain
- How content is discovered or downloaded — that is Source Domain
- How content items move through the pipeline — that is Video/Pipeline Domain

**Key invariant:** Creator **expresses need** — it does not orchestrate Target provisioning directly. Creator holds the target identity as the result of provisioning but Target Domain owns the act of creating it. Interaction with Target Domain happens through a contract (event or service call), not direct API coupling. A creator's content cannot be uploaded until a mirror account exists for them (when mirroring is enabled on their target).

**Key design principle:** If a second target platform is added, Creator Domain must not need to change.

**Integration pattern:** Creator emits "this creator needs a mirror account" → Target Domain acts and returns the effective `targetId` → Creator stores it without interpreting the internals.

---

### 4.4 Video / Content Domain
*"I am the source of truth for a content item's journey through the system."*

**Responsibility:** The content item catalogue per creator and the lifecycle state machine for each item. Video is a **neutral** domain — it spans Source and Target worlds and outlives any single pipeline run. Neither Source nor Target owns it.

**Owns:**
- Content item catalogue (one row per discovered video, per creator)
- Content identity across platforms: `sourceVideoId` + `sourceVideoUrl` (from Source), `targetPostId` + `targetPostUrl` (from Target)
- The lifecycle state machine:
  ```
  DOWNLOAD_QUEUED → DOWNLOADING → DOWNLOAD_SUCCEEDED
    → TRANSCODING → TRANSCODE_SUCCEEDED
    → UPLOADING → UPLOAD_SUCCEEDED   (terminal ✓)
  *_FAILED                           (terminal ✗, after max retries)
  ```
- `isIgnored` overlay — suspended state without changing stage position
- Denormalized `stage` in SQLite for fast queries (authoritative state lives in Temporal)
- The **content workflow spec** (the ordered steps: `discovered → downloaded → processed → published`)

**Does NOT own:**
- How to download content — that is Source Domain (via pipeline activity)
- How to upload or process content — that is Target Domain (via `TargetConnectionService`)
- Retry or scheduling logic — that is Pipeline Domain

**Key invariant:** Video state is the authoritative record of where a content item is in its lifecycle. Source writes source fields. Target writes target fields. Pipeline advances the stage. No single domain owns the whole video — each domain writes to its slice.

**Why its own domain:** Video spans both Source and Target worlds. It has its own lifecycle state machine. It outlives pipeline runs. It needs a neutral home that neither Source nor Target can claim.

---

### 4.5 Pipeline Domain
*"I orchestrate any multi-stage operation."*

**Responsibility:** General-purpose durable workflow execution engine. Owns *how* workflows run, how stages transition, how failures are handled and retried, and how execution history is recorded. Does NOT contain business logic — all decision-making belongs in the domain that submitted the workflow.

**Owns:**
- Workflow execution engine (Temporal)
- Execution instances and their history / audit trail
- Stage transition mechanics
- Failure handling and retry policies (declared, not coded)
- `isIgnored` suspension and resume signalling

**Does NOT own:**
- The definition of what a content workflow does — that spec belongs to Video Domain
- The definition of what a provisioning workflow does — that spec belongs to Creator Domain
- Platform-specific logic — adapters handle that
- Target configuration resolution — `TargetConnectionService` handles that
- Any business rules — Pipeline receives outcomes and advances stages accordingly

**Key design decision — Pipeline is not content-specific:**

```
Pipeline Domain (execution engine)
       │
       ├── Content Workflow            ← spec owned by Video Domain
       │     DOWNLOAD_QUEUED → … → UPLOAD_SUCCEEDED
       │
       └── Provisioning Workflow       ← spec owned by Creator Domain
             creator_discovered → account_created → profile_configured → mirror_ready
```

**Current content workflow activities:**

| Activity | Delegates to |
|---|---|
| `discoverCreatorVideos` | Source adapter (`discover`) |
| `downloadVideo` | Source adapter (`download`) |
| `transcodeVideo` | Transcode adapter (per `001-transcode-adapters` spec) |
| `uploadVideo` | `TargetConnectionService.resolveUploadTarget` → Target adapter (`upload`) |
| `cleanupArtifacts` | Filesystem |
| `updateVideoStage` | SQLite + SSE bus |

---

### 4.6 Settings / Config

**Responsibility:** Global runtime configuration. Operator-editable without deploying. Provides defaults when per-entity config is absent.

**Owns:** Global `pollIntervalMs`, global `artifactMaxAgeMs`.

**Intentionally thin.** Most configuration has migrated to entity-level JSON blobs (`sources.config`, `targets.config`). This is for system-wide operational knobs only.

---

### 4.7 API Layer _(entry point — not a domain)_

The API is not a domain. It is a thin trigger and translation layer.

**Owns:** Request validation, session auth, response shaping, SSE event bus for live dashboard updates.

**Key principle:**
```
POST /provision-creator  →  Pipeline.start(ProvisioningWorkflow, { creatorId })
POST /sync-content       →  Pipeline.start(ContentWorkflow, { creatorId })
```
The API hands off to Pipeline and does not implement business logic or domain rules.

---

## 5. Inter-Domain Contracts

| From | To | Contract |
|---|---|---|
| API Layer | Pipeline | Trigger workflow (provisioning or content) with typed input parameters |
| Pipeline | Creator Domain | "Get enabled creators for this discovery run" — activity reads creator + source config |
| Creator Domain | Target Domain | "This creator needs a mirror account" — event/service call; Creator emits the need, Target acts |
| Target Domain | Creator Domain | Returns effective `targetId` after provisioning; Creator stores it without interpreting internals |
| Pipeline | Video Domain | "Enumerate content for this creator" — inserts new video rows, starts per-video workflows |
| Video Domain | Source Domain | "Download this content item" — activity calls source adapter |
| Pipeline | Target Domain | "Resolve upload context for this creator" — activity calls `TargetConnectionService.resolveUploadTarget` |
| Target Child | Video Domain | Writes `targetPostId`, `targetPostUrl` after successful upload |
| Pipeline | SSE Bus | Emits stage change events after each activity |

---

## 6. Integration Patterns

| Pair | Pattern | Notes |
|---|---|---|
| Pipeline → Target | **Downstream via ACL** | `TargetConnectionService` is the Anti-Corruption Layer. Pipeline never sees `isMirror`, `parentTargetId`, or `mirroringEnabled`. |
| Pipeline → Source | **Downstream (conformist)** | Pipeline hands opaque `source.config` JSON directly to the adapter. No translation needed. |
| Creator → Target | **Published contract / event** | Creator emits a provisioning need. Target Domain acts and returns the result. Creator holds the result without knowing Target internals. |
| Adapter → Platform | **Conformist** | Each adapter wraps the platform API as-is. Platform quirks are contained inside the adapter boundary. |
| API Layer → All | **Open Host Service** | REST + SSE is the published integration surface. Other domains don't need to know the API exists. |

---

## 7. Ubiquitous Language

| Term | Meaning |
|---|---|
| **Creator** | A tracked content source account (e.g. a TikTok handle) whose content is being mirrored. |
| **Source** | A registered source platform configuration. One source can serve many creators. |
| **Target** | A registered upload destination. May be a parent (admin) target or a child (mirror) target. |
| **Parent target / Admin target** | A manually registered target using the operator's credentials. `isMirror = false`. No `parentTargetId`. |
| **Child target / Mirror target** | An auto-provisioned per-creator account on a target platform. `isMirror = true`, has a `parentTargetId`. |
| **Mirroring enabled** | Parent target config flag. When `true`, per-creator child accounts are used for upload instead of the admin account. |
| **Effective target** | The target a creator's content will be uploaded to. Opaque outside Target Domain. |
| **Target connection** | A fully resolved, ready-to-use upload context (decrypted credentials + merged config with inheritance applied). Output of `TargetConnectionService.resolveUploadTarget`. |
| **Provision** | Create (or find-and-map if already exists) a child mirror account on the target platform. |
| **Refresh** | Reset credentials on an existing child mirror account (e.g. after token expiry or sync failure). |
| **Delete** | Remove the child mirror account from the target platform and revert the creator's target reference to the parent. |
| **Content item / Video** | A single piece of content in the system. Has its own lifecycle state machine spanning Source and Target. |
| **Stage** | Current position of a content item in its lifecycle state machine. Denormalized from Temporal to SQLite. |
| **Ignored** | A content item whose pipeline workflow is suspended. Stage unchanged; processing resumes on un-ignore signal. |
| **Discovery** | Finding new content URLs for a creator handle on a source platform. |
| **Sync window** | On first discovery only — maximum age (days) of content items to include. Prevents historical backlog flooding. |
| **Content workflow** | Pipeline workflow spec for taking a content item from `DOWNLOAD_QUEUED` to `UPLOAD_SUCCEEDED`. Spec owned by Video Domain. |
| **Provisioning workflow** | Pipeline workflow spec for taking a creator from discovered to mirror-ready. Spec owned by Creator Domain. |
| **Transcode adapter** | Pluggable processing component. Configuration lives on the target (target requirements drive processing decisions). |
| **Activity** | A single, retryable unit of work within a pipeline workflow. All I/O happens in activities. |

---

## 8. Key Design Tensions & Decisions

### T-001: Mirror decisions belong to Target Domain, not Creator Domain
`mirroringEnabled` is an admin target configuration. The admin target sets the upload strategy for all creators that use it. Creators hold a reference to their effective target; `TargetConnectionService` resolves what "effective" means. See spec `007-target-hierarchy`.

### T-002: Processing (transcoding) belongs to Target Domain, not Pipeline
Transcoding sits between download and upload in the stage sequence, but processing rules are target-platform-specific. A target may require H.264, a specific resolution, or a maximum file size. The transcode adapter configuration lives on the target. Pipeline executes the activity; what to do comes from the target config resolved by `TargetConnectionService`. See spec `001-transcode-adapters`.

### T-003: Configuration inheritance must not leak outside Target Domain
Child targets may inherit config from their parent. `TargetConnectionService.resolveUploadTarget` returns a fully merged `TargetConnection`. All traversal is internal to Target Domain. Callers receive only resolved values. See specs `007-target-hierarchy` and `001-transcode-adapters`.

### T-004: New target types must not require pipeline changes
`TargetConnectionService` as an ACL absorbs all target-domain changes. `MirrorCapableTargetAdapter` adds mirror lifecycle methods without modifying `TargetAdapter`. Pipeline activities depend only on the service interface.

### T-005: `provisionMirrorAccount` must be idempotent (find-or-create)
If provisioning succeeds on the remote platform but the DB write fails, a retry must not create a duplicate account. The adapter MUST detect an existing account for the handle, map to it, and return its credentials. This makes the entire provisioning flow safe to retry from any failure point.

### T-006: Creator holds a single target reference — no fallback fields
`effectiveTargetId = creator.mirrorTargetId ?? creator.targetId` already exists in upload activity code and would spread to transcode config, health checks, and UI rendering. Creator holds exactly one `targetId` — always the effective target. The parent relationship is expressed as `childTarget.parentTargetId`, owned entirely by Target Domain. See spec `007-target-hierarchy`.

### T-007: Pipeline is a general execution engine, not a content pipeline
Pipeline will run provisioning workflows with the same engine as content workflows. Each domain (Video, Creator) owns its own workflow spec. Pipeline owns execution only — no domain logic.

---

## 9. Spec Placement Guide

| Spec Topic | Domain |
|---|---|
| Creator discovery (finding new creator handles) | Creator Domain |
| Mirror account creation / provisioning | Target Domain (child target lifecycle) |
| Creator profile management on target platform | Target Domain (child target) |
| Content enumeration per creator | Video / Content Domain |
| Content download behaviour | Source Domain |
| Transcoding / processing rules | Target Domain (target config drives processing) |
| Content upload | Target Domain (child target, via `TargetConnectionService`) |
| Video lifecycle state transitions | Video / Content Domain |
| Stage sequencing, failure, retry | Pipeline Domain |
| Platform authentication, rate limiting, retry | Source / Target Domain (adapter layer) |
| API request → workflow mapping | API Layer (entry point, not a domain) |
| Target parent-child config inheritance | Target Domain |
| Cross-domain contracts and boundaries | System-level (this document) |
| Global pipeline config (poll interval, artifact TTL) | Settings / Config |

---

## 10. Spec Dependency Order

```
007-target-hierarchy    (Target Domain data model + TargetConnectionService + MirrorCapableTargetAdapter)
        │
        ├─► 001-transcode-adapters    (Target Domain processing config + TranscodeAdapter)
        │         depends on: TargetConnectionService returns merged config incl. transcode settings
        │
        └─► (future) new target platform adapter
                  depends on: TargetAdapter / MirrorCapableTargetAdapter contract is stable

(future) provisioning-workflow-spec    (Creator Domain + Pipeline Domain)
        depends on: Target Domain mirror lifecycle contract is stable (from 007)
```

---

## 11. Open Questions

- **Q1: Should `TargetConnectionService` operations be Temporal activities or plain service calls?**  
  Currently assumed to be an injected plain service called from within activities. If target operations become long-running (e.g. remote provisioning), they may need to become Temporal activities with heartbeating.

- **Q2: Retry model for `refreshMirror` and `deleteMirror`?**  
  These are operator-triggered and not currently Temporal workflows. If delete requires remote API + DB atomicity, it should be a Temporal activity for durability.

- **Q3: What happens to video rows when a mirror target is deleted?**  
  Video rows snapshot `targetId` at upload time — existing rows are unaffected. But whether historical content remains reachable on the now-deleted remote account needs a UX decision.

- **Q4: Multi-target (one creator → multiple targets)?**  
  Not in scope. Single effective target per creator is a firm constraint. Document the constraint explicitly if it affects API design.

- **Q5: Are there operation types beyond content sync and creator provisioning that will run through Pipeline?**  
  If so, Pipeline's workflow model needs to be explicitly generic. This shapes how workflow definitions are registered and how the API triggers them.

- **Q6: What is the full lifecycle of a Target Child account?**  
  Can it be suspended independently of the creator (without deleting)? Transferred to a different creator? Updated (e.g. username change) without full deprovision/reprovision? This shapes the `MirrorCapableTargetAdapter` interface surface.

- **Q7: If a second target platform is added, does Target Domain split into bounded contexts or is it parameterised?**  
  The adapter pattern handles platform variation at the code level. The question is whether different target platforms have sufficiently different domain concepts to warrant separate contexts at the spec level.
