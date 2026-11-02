-- Event images (docs/09, 2026-11-02): the source's image URL, fetched once by the cron into a small WebP in R2
-- (image_key, already in 0000) and dropped once the event is over.
ALTER TABLE `events` ADD `image_src` text;--> statement-breakpoint
ALTER TABLE `events` ADD `image_checked_at` text;
