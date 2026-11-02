-- Where each source's event images come from (docs/09, 2026-11-02). Luma and Berliner Ensemble pages gave no image
-- for any event in the first production run (0 of 47 and 0 of 19): only their feeds' own images count.
ALTER TABLE `sources` ADD `image_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
UPDATE `sources` SET `image_mode` = 'feed' WHERE `id` IN ('s_luma_berlin', 's_be');
