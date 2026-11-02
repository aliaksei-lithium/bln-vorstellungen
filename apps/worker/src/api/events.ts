import { EventsQuery, type EventsList, type EventsResponse } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../auth';
import { eventDetail, listEvents, searchByMeaning, similarEvents } from '../services/events';
import { occurrenceIcs } from './ics';
import { musicLike } from '../spotify';

/**
 * Public, read-only event API over services/events. Responses carry `Cache-Control` with `s-maxage`, which Workers
 * Caching honours (wrangler.jsonc `cache.enabled`).
 */
export const eventsApi = new Hono<AppEnv>();

/**
 * Workers Caching keeps public responses 2 min at the edge, browsers 1 min, so a fresh import shows up within a
 * couple of minutes. Tagged so a later purge (`ctx.cache.purge({ tags: ['events'] })`) can drop them at once.
 */
const CACHE_CONTROL = 'public, max-age=60, s-maxage=120';
const CACHE_TAG = 'events';

eventsApi.get('/', async (c) => {
  const q = EventsQuery.safeParse(c.req.query());
  if (!q.success) throw new HTTPException(400, { message: q.error.issues[0]?.message ?? 'Invalid query' });
  // "My Spotify artists" depends on who asks: never cached publicly.
  const user = c.get('user');
  const mine = !!q.data.via?.some((v) => v === 'spotify' || v === 'spotifylike');
  const like = user && q.data.via?.includes('spotifylike') ? await musicLike(c.env, user.id) : undefined;
  const { rowsRead, ...body } = await listEvents(c.env.DB, q.data, q.data.limit, undefined, user?.id, like);
  c.header('Cache-Control', mine ? 'private, no-store' : CACHE_CONTROL);
  if (!mine) c.header('Cache-Tag', CACHE_TAG);
  c.header('X-D1-Rows-Read', String(rowsRead));
  return c.json(body satisfies EventsResponse);
});

const SearchQuery = z.object({ q: z.string().trim().min(2).max(200) });

eventsApi.get('/search', async (c) => {
  const q = SearchQuery.safeParse(c.req.query());
  if (!q.success) throw new HTTPException(400, { message: 'Query must be 2–200 characters.' });
  const items = await searchByMeaning(c.env, q.data.q);
  c.header('Cache-Control', 'public, max-age=300, s-maxage=600');
  return c.json({ items } satisfies EventsList);
});

eventsApi.get('/:slug/similar', async (c) => {
  const items = await similarEvents(c.env, c.req.param('slug'));
  c.header('Cache-Control', 'public, max-age=300, s-maxage=1800');
  return c.json({ items } satisfies EventsList);
});

/** One date as an .ics file for "Add to calendar"; public, so visitors can use it without an account. */
eventsApi.get('/:slug/ics', async (c) => {
  const detail = await eventDetail(c.env.DB, c.req.param('slug'));
  const o = detail?.occurrences.find((x) => x.id === c.req.query('date'));
  if (!detail || !o) throw new HTTPException(404, { message: 'Date not found' });
  const origin = new URL(c.req.url).origin;
  const ics = occurrenceIcs({
    uid: o.id,
    title: detail.title,
    category: detail.category,
    startLocal: o.startLocal,
    endLocal: o.endLocal ?? null,
    location: detail.venue ? [detail.venue.name, detail.venue.address ?? 'Berlin'].join(', ') : null,
    url: `${origin}/e/${detail.slug}`,
  });
  return c.body(ics, 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="${detail.slug.slice(0, 80)}.ics"`,
    'Cache-Control': CACHE_CONTROL,
    'Cache-Tag': CACHE_TAG,
  });
});

eventsApi.get('/:slug', async (c) => {
  const detail = await eventDetail(c.env.DB, c.req.param('slug'));
  if (!detail) throw new HTTPException(404, { message: 'Event not found' });
  c.header('Cache-Control', CACHE_CONTROL);
  c.header('Cache-Tag', CACHE_TAG);
  return c.json(detail);
});
