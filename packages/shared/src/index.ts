// @mirrorr/shared
// Types, enums and constants shared between backend, frontend and adapter packages.
// Add exports here as the project grows.

// ── Video stage (canonical enum shared across packages) ───────────────────────
export type VideoStage =
  | 'DOWNLOAD_QUEUED'
  | 'DOWNLOADING'
  | 'DOWNLOAD_SUCCEEDED'
  | 'TRANSCODING'
  | 'TRANSCODE_SUCCEEDED'
  | 'UPLOADING'
  | 'UPLOAD_SUCCEEDED'
  | 'ARCHIVE_PENDING'
  | 'ARCHIVING'
  | 'ARCHIVE_SUCCEEDED'
  | 'DOWNLOAD_FAILED'
  | 'TRANSCODE_FAILED'
  | 'UPLOAD_FAILED'
  | 'ARCHIVE_FAILED';

// ── SSE event types (FR-012, FR-013) ─────────────────────────────────────────
export const SSE_EVENT_NAMES = ['video:update', 'creator:update', 'stats:update', 'discovery:status'] as const;
export type SseEventName = typeof SSE_EVENT_NAMES[number];

export type VideoUpdateEvent = {
  id: number;              // video.id
  creatorId: number;       // for SSE filtering
  stage: VideoStage;
  stageUpdatedAt: string;  // ISO 8601
};

export type CreatorUpdateEvent = {
  id: number;                      // creator.id
  lastDiscoveredAt: string | null; // ISO 8601
  lastDiscoveryError?: string;     // present on discovery failure
};

export type StatsUpdateEvent = {
  videos: Record<VideoStage, number>; // counts by stage
  lastDiscoveredAt: string | null;    // ISO 8601
};

export type DiscoveryStatusEvent = {
  paused: boolean;
  nextRunAt: string | null; // ISO 8601, null when paused
};

export type SseEventPayload =
  | VideoUpdateEvent
  | CreatorUpdateEvent
  | StatsUpdateEvent
  | DiscoveryStatusEvent;
