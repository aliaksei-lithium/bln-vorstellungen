-- One line per event on what it is (docs/09, 2026-11-03), written once from its description by services/taglines.ts,
-- with the model and prompt version that wrote it.
ALTER TABLE `events` ADD `tagline` text;--> statement-breakpoint
ALTER TABLE `events` ADD `tagline_model` text;--> statement-breakpoint
ALTER TABLE `events` ADD `tagline_prompt` text;--> statement-breakpoint
ALTER TABLE `events` ADD `tagline_checked_at` text;
