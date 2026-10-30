-- Local development data only (`pnpm --filter @bln/worker db:seed:local`). Never run against --remote.
-- Dates are relative to today; UTC assumes winter time (CET, UTC+1), close enough for UI work.
DELETE FROM events_fts; DELETE FROM occurrences; DELETE FROM events; DELETE FROM venues;

INSERT INTO venues (id, name, address, district, url) VALUES
  ('v_dt', 'Deutsches Theater', 'Schumannstraße 13a', 'Mitte', 'https://www.deutschestheater.de'),
  ('v_do', 'Deutsche Oper', 'Bismarckstraße 35', 'Charlottenburg', 'https://deutscheoperberlin.de'),
  ('v_sb', 'Schaubühne', 'Kurfürstendamm 153', 'Charlottenburg', 'https://www.schaubuehne.de'),
  ('v_ph', 'Philharmonie', 'Herbert-von-Karajan-Straße 1', 'Tiergarten', 'https://www.berliner-philharmoniker.de'),
  ('v_qm', 'Quasimodo', 'Kantstraße 12a', 'Charlottenburg', NULL),
  ('v_bg', 'Berlinische Galerie', 'Alte Jakobstraße 124', 'Kreuzberg', 'https://berlinischegalerie.de'),
  ('v_lh', 'Literaturhaus Berlin', 'Fasanenstraße 23', 'Charlottenburg', NULL);

INSERT INTO events (id, slug, title, lang, category, venue_id, price_min, price_max, is_free, dedup_key, created_by, description) VALUES
  ('e1', 'hamlet', 'Hamlet', 'de', 'theatre', 'v_dt', 18, 64, 0, 'dev1', 'seed', 'Shakespeare as a spare three-hour staging with a strong ensemble. English surtitles on Thursdays.'),
  ('e2', 'die-zauberflote', 'Die Zauberflöte', 'de', 'opera', 'v_do', 25, 120, 0, 'dev2', 'seed', NULL),
  ('e3', 'peer-gynt', 'Peer Gynt', 'de', 'theatre', 'v_sb', 16, 48, 0, 'dev3', 'seed', 'Ibsen as a road movie on a rotating set.'),
  ('e4', 'mahler-symphony-no-5', 'Mahler: Symphony No. 5', 'en', 'concert', 'v_ph', 22, 98, 0, 'dev4', 'seed', NULL),
  ('e5', 'late-jazz-session', 'Late Jazz Session', 'en', 'concert', 'v_qm', 12, NULL, 0, 'dev5', 'seed', NULL),
  ('e6', 'fotografie-der-20er-jahre', 'Fotografie der 20er Jahre', 'de', 'exhibition', 'v_bg', 10, NULL, 0, 'dev6', 'seed', NULL),
  ('e7', 'lesung-neue-berliner-stimmen', 'Lesung: Neue Berliner Stimmen', 'de', 'talk', 'v_lh', NULL, NULL, 1, 'dev7', 'seed', NULL);

WITH d(event_id, plus_days, t) AS (VALUES
  ('e1', 0, '19:30'), ('e1', 3, '19:30'), ('e1', 6, '19:30'), ('e1', 9, '18:00'), ('e1', 12, '19:30'), ('e1', 15, '19:30'),
  ('e2', 0, '19:30'), ('e2', 5, '19:30'), ('e2', 10, '18:00'),
  ('e3', 1, '20:00'), ('e3', 2, '20:00'), ('e3', 8, '19:30'),
  ('e4', 0, '20:00'),
  ('e5', 0, '21:00'),
  ('e6', 1, '10:00'), ('e6', 2, '10:00'), ('e6', 3, '10:00'),
  ('e7', 1, '19:00')
)
INSERT INTO occurrences (id, event_id, start_local, start_utc)
SELECT event_id || '_' || plus_days || '_' || t, event_id,
       date('now', '+' || plus_days || ' day') || 'T' || t,
       strftime('%Y-%m-%dT%H:%M:%fZ', date('now', '+' || plus_days || ' day') || ' ' || t, '-1 hour')
FROM d;

INSERT INTO events_fts (event_id, title, description, venue)
SELECT e.id, e.title, e.description, v.name FROM events e LEFT JOIN venues v ON v.id = e.venue_id;

-- Denormalized next date per event (normally kept by resolve and the cron sweep).
UPDATE events SET
  next_start_utc = (SELECT MIN(o.start_utc) FROM occurrences o WHERE o.event_id = events.id AND o.start_utc >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  next_start_local = (SELECT o.start_local FROM occurrences o WHERE o.event_id = events.id AND o.start_utc >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY o.start_utc LIMIT 1),
  upcoming_count = (SELECT COUNT(*) FROM occurrences o WHERE o.event_id = events.id AND o.start_utc >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
