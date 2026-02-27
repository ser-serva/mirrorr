DROP INDEX `videos_source_video_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `videos_source_video_creator_idx` ON `videos` (`source_video_id`,`creator_id`);--> statement-breakpoint
ALTER TABLE `creators` ADD `initial_sync_window_days` integer DEFAULT 3;