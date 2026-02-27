import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ── Stage enum ────────────────────────────────────────────────────────────────

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

// ── Config JSON types ─────────────────────────────────────────────────────────

export type TikTokSourceConfig = {
  discoveryPlaylistLimit?: number; // default 10
  discoveryMaxAgeDays?: number;    // default 3
};

export type LoopsTargetConfig = {
  maxVideoMb?: number;   // default 500
  retentionDays?: number; // 0 = never archive, default 3
};

// ── Tables ────────────────────────────────────────────────────────────────────

export const sources = sqliteTable('sources', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  name:    text('name').notNull(),
  type:    text('type', { enum: ['tiktok', 'instagram', 'youtube_shorts'] }).notNull(),
  config:  text('config', { mode: 'json' }).$type<TikTokSourceConfig>().notNull().default({}),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
});

export const targets = sqliteTable('targets', {
  id:                integer('id').primaryKey({ autoIncrement: true }),
  name:              text('name').notNull(),
  type:              text('type', { enum: ['loops'] }).notNull(),
  url:               text('url').notNull(),
  apiTokenEnc:       text('api_token_enc').notNull(),
  publicationConfig: text('publication_config', { mode: 'json' })
                       .$type<{ titleTemplate?: string; descriptionTemplate?: string }>()
                       .notNull()
                       .default({}),
  config:            text('config', { mode: 'json' }).$type<LoopsTargetConfig>().notNull().default({}),
  isMirror:          integer('is_mirror', { mode: 'boolean' }).notNull().default(false),
  enabled:           integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastTestedAt:      integer('last_tested_at', { mode: 'timestamp' }),
  lastTestOk:        integer('last_test_ok', { mode: 'boolean' }),
});

export const creators = sqliteTable('creators', {
  id:               integer('id').primaryKey({ autoIncrement: true }),
  handle:           text('handle').notNull(),
  sourceId:         integer('source_id').notNull().references(() => sources.id),
  targetId:         integer('target_id').notNull().references(() => targets.id),
  enabled:          integer('enabled', { mode: 'boolean' }).notNull().default(true),
  pollIntervalMs:           integer('poll_interval_ms'),
  maxBacklog:               integer('max_backlog'),
  initialSyncWindowDays:    integer('initial_sync_window_days').default(3),
  lastPolledAt:             integer('last_polled_at', { mode: 'timestamp' }),
  lastDiscoveredAt:         integer('last_discovered_at', { mode: 'timestamp' }),
  lastPollError:            text('last_poll_error'),
  lastPollErrorAt:          integer('last_poll_error_at', { mode: 'timestamp' }),
}, (t) => [
  uniqueIndex('creators_handle_source_idx').on(t.handle, t.sourceId),
]);

export const videos = sqliteTable('videos', {
  id:                  integer('id').primaryKey({ autoIncrement: true }),
  creatorId:           integer('creator_id').notNull().references(() => creators.id, { onDelete: 'cascade' }),
  targetId:            integer('target_id').references(() => targets.id),
  sourceVideoId:       text('source_video_id').notNull(),
  sourceVideoUrl:      text('source_video_url').notNull(),
  title:               text('title'),
  description:         text('description'),
  hashtags:            text('hashtags', { mode: 'json' }).$type<string[]>().default([]),
  thumbnailUrl:        text('thumbnail_url'),
  sourcePubAt:         integer('source_pub_at', { mode: 'timestamp' }),
  durationSecs:        integer('duration_secs'),
  discoveredAt:        integer('discovered_at', { mode: 'timestamp' })
                         .notNull()
                         .default(sql`(unixepoch())`),
  stage:               text('stage').$type<VideoStage>().notNull().default('DOWNLOAD_QUEUED'),
  isIgnored:           integer('is_ignored', { mode: 'boolean' }).notNull().default(false),
  stageUpdatedAt:      integer('stage_updated_at', { mode: 'timestamp' }),
  transcodeDecision:   text('transcode_decision', { enum: ['passthrough', 'encode'] }),
  targetPostId:        text('target_post_id'),
  targetPostUrl:       text('target_post_url'),
  temporalWorkflowId:  text('temporal_workflow_id'),
}, (t) => [
  // Per-creator deduplication: same video ID may appear for different creators
  uniqueIndex('videos_source_video_creator_idx').on(t.sourceVideoId, t.creatorId),
]);

export const settings = sqliteTable('settings', {
  id:               integer('id').primaryKey(),           // always 1
  pollIntervalMs:   integer('poll_interval_ms').notNull().default(300_000),
  artifactMaxAgeMs: integer('artifact_max_age_ms').notNull().default(7_200_000),
});
