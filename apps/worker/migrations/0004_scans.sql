CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`raw_item_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`candidates` text,
	`result` text,
	`error` text,
	`model` text,
	`prompt_version` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scans_user_idx` ON `scans` (`user_id`,`created_at`);