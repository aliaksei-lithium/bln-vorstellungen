CREATE TABLE `daily_research` (
	`day` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `last_seen_at` text;--> statement-breakpoint
-- Everyone counts as recently seen at deploy, so no existing user loses their daily edition before their next visit.
UPDATE `users` SET `last_seen_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now');
