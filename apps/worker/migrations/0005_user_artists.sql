CREATE TABLE `user_artists` (
	`user_id` text NOT NULL,
	`name_lc` text NOT NULL,
	`name` text NOT NULL,
	`genres` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'spotify' NOT NULL,
	`rank` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `name_lc`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_artists_name_idx` ON `user_artists` (`name_lc`);