ALTER TABLE `sources` ADD `default_off` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Off for visitors by default (docs/09, 2026-11-02): venues most visitors don't come for.
UPDATE `sources` SET `default_off` = 1 WHERE `id` IN ('s_privatclub', 's_atrane', 's_theleftberlin', 's_bjv');
