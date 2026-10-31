-- Starter sources and their venues (docs/08 phase 1). Safe to re-run: existing rows are kept as they are.
--   local:  pnpm --filter @bln/worker db:seed-sources:local
--   remote: pnpm --filter @bln/worker db:seed-sources:remote
-- Each source was checked on 2026-10-31: iCal or schema.org JSON-LD, or (html) a programme page the extractor reads
-- well (try one with POST /api/admin/extract first). More can be added via the admin API.

INSERT OR IGNORE INTO venues (id, name, aliases, address, district, url) VALUES
  ('v_gorki', 'Maxim Gorki Theater', '["Gorki", "Gorki Theater"]', 'Am Festungsgraben 2, 10117 Berlin', 'Mitte', 'https://www.gorki.de'),
  ('v_atrane', 'A-Trane', '["A-Trane Jazzclub"]', 'Bleibtreustraße 1, 10623 Berlin', 'Charlottenburg', 'https://www.a-trane.de'),
  ('v_privatclub', 'Privatclub', '["Privatclub Berlin"]', 'Skalitzer Straße 85-86, 10997 Berlin', 'Kreuzberg', 'https://www.privatclub-berlin.de'),
  ('v_bjv', 'Bar jeder Vernunft', '[]', 'Schaperstraße 24, 10719 Berlin', 'Wilmersdorf', 'https://www.bar-jeder-vernunft.de'),
  ('v_polish_losers', 'Club der polnischen Versager', '["Club of Polish Losers"]', 'Ackerstraße 168, 10115 Berlin', 'Mitte', NULL),
  ('v_be', 'Berliner Ensemble', '["BE"]', 'Bertolt-Brecht-Platz 1, 10117 Berlin', 'Mitte', 'https://www.berliner-ensemble.de'),
  ('v_dt', 'Deutsches Theater', '["Deutsches Theater Berlin", "DT"]', 'Schumannstraße 13a, 10117 Berlin', 'Mitte', 'https://www.deutschestheater.de'),
  ('v_staatsoper', 'Staatsoper Unter den Linden', '["Staatsoper Berlin", "Staatsoper"]', 'Unter den Linden 7, 10117 Berlin', 'Mitte', 'https://www.staatsoper-berlin.de');

INSERT OR IGNORE INTO sources (id, name, type, config, schedule_minutes) VALUES
  ('s_theleftberlin', 'The Left Berlin', 'ical',
   '{"url":"https://theleftberlin.com/events/?ical=1","category":"talk","lang":"en","maxItems":200}', 360),
  ('s_luma_berlin', 'Luma: What''s happening in Berlin', 'ical',
   '{"url":"https://api.lu.ma/ics/get?entity=discover&id=discplace-gCfX0s3E9Hgo3rG","maxItems":200}', 360),
  ('s_gorki', 'Maxim Gorki Theater', 'jsonld',
   '{"url":"https://www.gorki.de/de/spielplan","venue":{"name":"Maxim Gorki Theater"},"category":"theatre","lang":"de","maxItems":200}', 720),
  ('s_atrane', 'A-Trane', 'jsonld',
   '{"url":"https://www.a-trane.de/","venue":{"name":"A-Trane"},"category":"concert","maxItems":200}', 720),
  ('s_privatclub', 'Privatclub', 'jsonld',
   '{"url":"https://www.privatclub-berlin.de/","venue":{"name":"Privatclub"},"category":"concert","lang":"de","maxItems":200}', 720),
  ('s_bjv', 'Bar jeder Vernunft', 'jsonld',
   '{"url":"https://www.bar-jeder-vernunft.de/","venue":{"name":"Bar jeder Vernunft"},"category":"theatre","lang":"de","maxItems":200}', 720),
  -- html sources go through LLM extraction (Workers AI); daily, and bounded by the neuron budget.
  ('s_be', 'Berliner Ensemble', 'html',
   '{"url":"https://www.berliner-ensemble.de/spielplan","venue":{"name":"Berliner Ensemble","address":"Bertolt-Brecht-Platz 1, 10117 Berlin"},"category":"theatre","lang":"de","chunkChars":10000,"maxChunks":5}', 1440),
  ('s_dt', 'Deutsches Theater', 'html',
   '{"url":"https://www.deutschestheater.de/programm/spielplan/","venue":{"name":"Deutsches Theater","address":"Schumannstraße 13a, 10117 Berlin"},"category":"theatre","lang":"de","chunkChars":10000,"maxChunks":5}', 1440),
  ('s_staatsoper', 'Staatsoper Unter den Linden', 'html',
   '{"url":"https://www.staatsoper-berlin.de/de/spielplan/","venue":{"name":"Staatsoper Unter den Linden","address":"Unter den Linden 7, 10117 Berlin"},"category":"opera","lang":"de","chunkChars":10000,"maxChunks":5}', 1440);
