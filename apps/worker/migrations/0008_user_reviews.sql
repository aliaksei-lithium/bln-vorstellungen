CREATE TABLE `user_reviews` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`content` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
