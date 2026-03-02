ALTER TABLE `creators` ADD `mirror_target_id` integer REFERENCES `targets`(`id`);--> statement-breakpoint
ALTER TABLE `videos` ADD `local_path` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `transcoded_path` text;
