-- Staatsoper moves from the html (LLM) adapter to its own structured one (docs/09, 2026-11-21): the Spielplan page
-- shows two days, later weeks load as fragments the adapter walks. Old Markdown chunks still pending would fail
-- in mapItem, so they are skipped; the cursor was an HTTP validator for the single page.
UPDATE `sources`
   SET `type` = 'staatsoper',
       `config` = '{"url":"https://www.staatsoper-berlin.de/de/spielplan/","venue":{"name":"Staatsoper Unter den Linden","address":"Unter den Linden 7, 10117 Berlin"},"category":"opera","lang":"de","maxPages":16}',
       `cursor` = NULL,
       `next_run_at` = NULL
 WHERE `id` = 's_staatsoper';--> statement-breakpoint
UPDATE `raw_items` SET `extraction_status` = 'skipped' WHERE `source_id` = 's_staatsoper' AND `extraction_status` = 'pending';
