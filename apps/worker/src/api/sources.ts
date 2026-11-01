import type { SourcesOverview } from '@bln/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { sourcesOverview } from '../services/sources';

/** Public sources, for visitors' source switches: which exist and which start off (docs/09, 2026-11-02). */
export const sourcesApi = new Hono<AppEnv>();

sourcesApi.get('/', async (c) => {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=600');
  return c.json({ sources: await sourcesOverview(c.env.DB, { publicOnly: true }) } satisfies SourcesOverview);
});
