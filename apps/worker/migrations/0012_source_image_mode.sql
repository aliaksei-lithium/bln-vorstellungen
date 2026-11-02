-- Per-source settings (docs/09, 2026-11-02). image_mode: where its events' images come from; Luma and Berliner
-- Ensemble pages gave no image for any event in the first production run (0 of 47 and 0 of 19), so only their feeds'
-- own images count. community: a community the source is run by or for, for Browse's community filters.
ALTER TABLE `sources` ADD `image_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `community` text;--> statement-breakpoint
UPDATE `sources` SET `image_mode` = 'feed' WHERE `id` IN ('s_luma_berlin', 's_be');
