-- Keyword search (docs/04). Maintained by the resolve step, which knows performer and venue names;
-- triggers cannot join, so the app writes rows here after each event upsert.
CREATE VIRTUAL TABLE `events_fts` USING fts5(
	`event_id` UNINDEXED,
	`title`,
	`description`,
	`performers`,
	`venue`,
	tokenize = 'unicode61 remove_diacritics 2'
);
