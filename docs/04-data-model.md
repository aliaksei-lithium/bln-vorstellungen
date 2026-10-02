# 04 Data model (D1 / Drizzle)

Key modelling decision: an **event** is the thing (a production, a concert, an exhibition) and an **occurrence** is a
date/time it happens. "Vorstellungen" are occurrences. Lists and scoring work on events; the agenda works on
occurrences.

```
users ─┬─ sessions / accounts / verifications      (better-auth tables)
       ├─ api_keys
       ├─ user_profiles           taste text, toggles, spotify import, home location
       ├─ user_event_state        interest/rating/notes per event
       └─ user_event_scores       AI score + explanation per event

sources ─── source_runs ─── raw_items ─┐
                                       ├─ event_sources (event ↔ raw_item, with extraction payload)
events ─┬─ occurrences                 │
        ├─ event_performers ─ performers (aliases)
        ├─ venue_id ─ venues (aliases)
        ├─ event_tags ─ tags
        ├─ event_embeddings
        └─ enrichments (log of AI/web steps with provenance)

uploads (photos) ─ raw_items
review_queue
usage_counters
```

## Tables (abridged, Drizzle names)

**events**
`id`, `slug`, `title`, `title_en`, `description`, `description_en`, `lang`, `category`, `genres` (json), `venue_id`,
`price_min`, `price_max`, `is_free`, `price_note`, `url_official`, `url_tickets`, `image_key` (R2), `status`
(`draft|published|cancelled|merged_into:<id>`), `first_start_at`, `last_start_at` (denormalized for list queries),
`dedup_key`, `created_by` (`source|user:<id>|mcp`), `created_at`, `updated_at`.

**occurrences**
`id`, `event_id`, `start_local` (ISO, Europe/Berlin), `start_utc`, `end_local?`, `doors_local?`, `note`,
`status` (`scheduled|cancelled|sold_out`), unique(`event_id`, `start_utc`).

**venues**
`id`, `name`, `aliases` (json), `address`, `district`, `lat`, `lng`, `url`, `geocode_source`.

**performers**
`id`, `name`, `aliases` (json), `kind` (`artist|band|ensemble|company|speaker`), `musicbrainz_id?`, `spotify_id?`,
`genres` (json), `popularity?`.

**sources**
`id`, `name`, `type`, `config` (json), `schedule_minutes`, `enabled`, `cursor`, `next_run_at`, `last_run_at`,
`last_status`, `last_error`, `owner_user_id`, `visibility` (`public|private`), `stats` (json).

Private sources exist so a user can add a Telegram channel only they care about; events from private sources are
scored only for that user and hidden from the public list.

**source_runs**: `id`, `source_id`, `workflow_id`, `started_at`, `finished_at`, `status`, `fetched`, `new_items`,
`events_created`, `events_updated`, `error`.

**raw_items**: `id`, `source_id`, `external_id`, `content_hash`, `kind`, `content` (text) or `r2_key`, `url`,
`published_at`, `fetched_at`, `extraction_status`, unique(`source_id`, `content_hash`).

**event_sources**: `event_id`, `raw_item_id`, `extracted` (json `ExtractedEvent`), `confidence`, `model`,
`prompt_version`.

**user_profiles**: `user_id`, `taste_text`, `prefs` (json: categories on/off, max_price, home_lat/lng, max_km,
languages, weekdays), `spotify` (json: top artists, genres, imported_at), `profile_embedding` (blob),
`updated_at`.

**user_event_state**: `user_id`, `event_id`, `state` (`inbox|interested|maybe|skipped|hidden|went`), `rating?`,
`note?`, `updated_at`.

**user_event_scores**: `user_id`, `event_id`, `score` (0–100), `reasons` (json: `[{kind, text, weight}]`),
`model`, `profile_version`, `computed_at`. Recomputed when the profile version changes or the event is enriched.

**event_embeddings**: `event_id`, `model`, `dims`, `vector` (blob, float32), `text_hash`.

**review_queue**: `id`, `kind` (`low_confidence|possible_duplicate|manual`), `payload` (json), `event_id?`,
`raw_item_id?`, `status`, `resolved_by`, `resolved_at`.

**usage_counters**: `day`, `metric` (`d1_rows_read|d1_rows_written|ai_neurons|claude_input_tokens|...`), `value`.
Updated from `meta` of D1 results and AI Gateway responses, displayed on the admin usage page so the free limits
are visible before they bite.

## Dedup

`dedup_key` = normalized(title) + venue_id + date (YYYY-MM-DD of first occurrence). Normalization lowercases,
strips diacritics and punctuation, drops stop words like "live", "konzert", "tickets". A candidate whose key
matches an existing event merges into it (adds occurrences, fills empty fields, links the source). A candidate with
the same venue and date but a title similarity between 0.6 and 0.9 (trigram or embedding cosine) goes to the review
queue as `possible_duplicate`.

## Search

- Keyword: D1 FTS5 virtual table over `title`, `description`, performer names, venue name.
- Semantic: `event_embeddings` for upcoming events loaded into memory for a query (bounded by date range), cosine
  against the query embedding. At a few thousand upcoming events this is a couple of ms of CPU.

## Indexes that matter for the free-tier row budget

`events(status, first_start_at)`, `occurrences(start_utc)`, `occurrences(event_id)`,
`user_event_scores(user_id, score desc)`, `user_event_state(user_id, state)`, `raw_items(source_id, content_hash)`,
`sources(enabled, next_run_at)`.
