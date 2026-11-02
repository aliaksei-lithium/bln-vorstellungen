import type { VenueDetail } from '@bln/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../auth';
import { venueDetail } from '../services/events';

/** A venue's page header (its events come from `/api/events?venue=`). Public, cached like the event list. */
export const venuesApi = new Hono<AppEnv>();

venuesApi.get('/:id', async (c) => {
  const v = await venueDetail(c.env.DB, c.req.param('id'));
  if (!v) throw new HTTPException(404, { message: 'No such venue' });
  c.header('Cache-Control', 'public, max-age=300, s-maxage=600');
  return c.json(v satisfies VenueDetail);
});
