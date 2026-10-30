-- Starter sources and their venues (docs/08 phase 1). Safe to re-run: existing rows are kept as they are.
--   local:  pnpm --filter @bln/worker db:seed-sources:local
--   remote: pnpm --filter @bln/worker db:seed-sources:remote
-- Each source was checked on 2026-10-31 to publish iCal or schema.org JSON-LD. More can be added via the admin API.

INSERT OR IGNORE INTO venues (id, name, aliases, address, district, url) VALUES
  ('v_gorki', 'Maxim Gorki Theater', '["Gorki", "Gorki Theater"]', 'Am Festungsgraben 2, 10117 Berlin', 'Mitte', 'https://www.gorki.de'),
  ('v_atrane', 'A-Trane', '["A-Trane Jazzclub"]', 'Bleibtreustraße 1, 10623 Berlin', 'Charlottenburg', 'https://www.a-trane.de'),
  ('v_privatclub', 'Privatclub', '["Privatclub Berlin"]', 'Skalitzer Straße 85-86, 10997 Berlin', 'Kreuzberg', 'https://www.privatclub-berlin.de'),
  ('v_bjv', 'Bar jeder Vernunft', '[]', 'Schaperstraße 24, 10719 Berlin', 'Wilmersdorf', 'https://www.bar-jeder-vernunft.de'),
  ('v_polish_losers', 'Club der polnischen Versager', '["Club of Polish Losers"]', 'Ackerstraße 168, 10115 Berlin', 'Mitte', NULL);

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
   '{"url":"https://www.bar-jeder-vernunft.de/","venue":{"name":"Bar jeder Vernunft"},"category":"theatre","lang":"de","maxItems":200}', 720);
