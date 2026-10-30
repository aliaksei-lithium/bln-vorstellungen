ALTER TABLE `events` ADD `next_start_utc` text;--> statement-breakpoint
ALTER TABLE `events` ADD `next_start_local` text;--> statement-breakpoint
ALTER TABLE `events` ADD `upcoming_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `events_next_idx` ON `events` (`next_start_utc`);--> statement-breakpoint
CREATE INDEX `events_category_next_idx` ON `events` (`category`,`next_start_utc`);