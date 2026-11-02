CREATE TABLE `discover_editions` (
	`audience` text NOT NULL,
	`day` text NOT NULL,
	`content` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`audience`, `day`)
);
