import type { SourceSummary } from '@bln/shared';

/**
 * Sources as people see them: a name, the page behind it, how busy it is. Shared by the Me page, the public list for
 * visitors' source switches (docs/09, 2026-11-02) and event pages.
 */

/**
 * The page behind a source for people (not the feed): an explicit `link`, the Telegram channel, or the configured
 * URL without feed parameters (?ical=1). Only http(s) links come out.
 */
export function sourceLink(type: string, config: string): string | null {
  let c: { link?: string; url?: string; channel?: string };
  try {
    c = JSON.parse(config);
  } catch {
    return null;
  }
  if (c.link) return /^https?:\/\//.test(c.link) ? c.link : null;
  if (type === 'telegram' && c.channel) return `https://t.me/${c.channel}`;
  if (!c.url || !/^https?:\/\//.test(c.url)) return null;
  if (type !== 'ical' && type !== 'rss') return c.url;
  const u = new URL(c.url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Every source, or only public enabled ones; enabled first, busiest first. */
export async function sourcesOverview(
  db: D1Database,
  opts: { publicOnly?: boolean } = {},
  now = new Date(),
): Promise<SourceSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.type, s.config, s.enabled, s.default_off, s.schedule_minutes, s.last_run_at,
              s.last_status, s.next_run_at,
              (SELECT COUNT(DISTINCT es.event_id) FROM raw_items r
                 JOIN event_sources es ON es.raw_item_id = r.id
                 JOIN events e ON e.id = es.event_id
                WHERE r.source_id = s.id AND e.next_start_utc >= ?) AS upcoming
         FROM sources s
        ${opts.publicOnly ? `WHERE s.visibility = 'public' AND s.enabled = 1` : ''}
        ORDER BY s.enabled DESC, upcoming DESC, s.name`,
    )
    .bind(now.toISOString())
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    link: sourceLink(String(r.type), String(r.config)),
    type: String(r.type),
    enabled: Boolean(r.enabled),
    everyMinutes: Number(r.schedule_minutes),
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastStatus: (r.last_status as string | null) ?? null,
    nextRunAt: (r.next_run_at as string | null) ?? null,
    upcoming: Number(r.upcoming ?? 0),
    defaultOff: Boolean(r.default_off),
  }));
}

/** The public sources that list an event, for its page. */
export async function eventSources(
  db: D1Database,
  eventId: string,
): Promise<{ id: string; name: string; link: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.id, s.name, s.type, s.config FROM event_sources es
         JOIN raw_items r ON r.id = es.raw_item_id
         JOIN sources s ON s.id = r.source_id
        WHERE es.event_id = ? AND s.visibility = 'public'
        ORDER BY s.name`,
    )
    .bind(eventId)
    .all<{ id: string; name: string; type: string; config: string }>();
  return results.map((s) => ({ id: s.id, name: s.name, link: sourceLink(s.type, s.config) }));
}
