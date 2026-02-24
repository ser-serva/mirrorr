CREATE TABLE `creators` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`handle` text NOT NULL,
	`source_id` integer NOT NULL,
	`target_id` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`poll_interval_ms` integer,
	`max_backlog` integer,
	`last_polled_at` integer,
	`last_discovered_at` integer,
	`last_poll_error` text,
	`last_poll_error_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creators_handle_source_idx` ON `creators` (`handle`,`source_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`poll_interval_ms` integer DEFAULT 300000 NOT NULL,
	`artifact_max_age_ms` integer DEFAULT 7200000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`api_token_enc` text NOT NULL,
	`publication_config` text DEFAULT '{}' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`is_mirror` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_tested_at` integer,
	`last_test_ok` integer
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`target_id` integer,
	`source_video_id` text NOT NULL,
	`source_video_url` text NOT NULL,
	`title` text,
	`description` text,
	`hashtags` text DEFAULT '[]',
	`thumbnail_url` text,
	`source_pub_at` integer,
	`duration_secs` integer,
	`discovered_at` integer DEFAULT (unixepoch()) NOT NULL,
	`stage` text DEFAULT 'DOWNLOAD_QUEUED' NOT NULL,
	`is_ignored` integer DEFAULT false NOT NULL,
	`stage_updated_at` integer,
	`transcode_decision` text,
	`target_post_id` text,
	`target_post_url` text,
	`temporal_workflow_id` text,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_source_video_id_unique` ON `videos` (`source_video_id`);