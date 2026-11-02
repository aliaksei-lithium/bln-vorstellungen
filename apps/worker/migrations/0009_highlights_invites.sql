CREATE TABLE `invite_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `invite_requests_status_idx` ON `invite_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `public_reviews` (
	`day` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
-- Deutsches Theater joins the venues visitors start without (docs/09, 2026-11-02).
UPDATE `sources` SET `default_off` = 1 WHERE `id` = 's_dt';
