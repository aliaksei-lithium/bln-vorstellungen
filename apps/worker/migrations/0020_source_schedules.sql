-- Source schedules by how fast each programme changes (docs/09, 2026-11-21). Telegram channels keep their 2 h;
-- everything else runs at most daily. Opera and concert venues publish months ahead: weekly.
-- Weekly (10080): opera, concert venues, dance, a monthly party calendar.
UPDATE `sources` SET `schedule_minutes` = 10080 WHERE `id` IN (
  's_staatsoper',
  '85d86d65-39e7-4334-ba57-e8e8e0e13ebe', -- Badehaus
  'e57b4acc-ad36-4a2d-b234-ec13a31f5b8a', -- Cassiopeia
  '69c10bac-fcf4-4ddf-9b90-41c17284f44d', -- KM28
  '3a38f775-0953-4202-9b98-a4384519f664', -- Madame Claude
  's_panke',
  's_schokoladen',
  '59e53d74-4095-4e08-a6e0-bf71bf96656d', -- field notes (neue Musik)
  's_atrane',
  's_privatclub',
  'f4e443bd-3cc6-44c6-be10-aef2bb7f92d1', -- 8MM Bar
  '3a1e9520-e192-48eb-941d-062424c60eb8', -- SO36
  '826eb420-5ae2-42ea-b867-0dea3248294e', -- Radialsystem
  'f6aae399-c05f-4936-9bb4-d80d482d7be6'  -- Lab.oratory
);--> statement-breakpoint
-- Every 3 days (4320): theatres (monthly Spielpläne, occasional added dates), mixed venues, a bar calendar.
UPDATE `sources` SET `schedule_minutes` = 4320 WHERE `id` IN (
  's_be',
  's_dt',
  'a39a576f-fcd9-4f21-996e-2b8e5678be96', -- HAU Hebbel am Ufer
  's_gorki',
  's_bjv',
  's_silentgreen',
  '34bc7fb2-e513-42c9-ab41-7a156e9e9208'  -- Soulcat
);--> statement-breakpoint
-- Daily (1440): short-notice listings (Luma, The Left, RAZAM calendar), gallery openings, the Siegessäule
-- calendar and the weekly guides' feeds. Unchanged feeds answer 304 and cost three workflow steps.
UPDATE `sources` SET `schedule_minutes` = 1440 WHERE `type` != 'telegram' AND `schedule_minutes` < 1440;
