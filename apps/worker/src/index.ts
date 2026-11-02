import type { HealthResponse } from '@bln/shared';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { adminApi } from './api/admin';
import { authApi, calendarApi, meApi } from './api/me';
import { loadUser, sameOrigin, type AppEnv } from './auth';
import { eventsApi } from './api/events';
import { scansApi } from './api/scans';
import { sourcesApi } from './api/sources';
import { venuesApi } from './api/venues';
import { discoverApi, highlightsApi, inviteRequestsApi } from './api/public';
import { spotifyApi, spotifyPages } from './api/spotify';
import { youtubeApi, youtubePages } from './api/youtube';
import { authorize, oauth } from './mcp/oauth';
import { embedMissing } from './ai/embed';
import { dispatchScoring, rescoreAfterPromptChange } from './ai/score';
import { markIndexStale, rebuildIndex } from './ai/vector-index';
import { sweepPassedDates } from './pipeline/next-dates';
import { dispatchDueSources } from './pipeline/scheduler';
import { dropPastImages, fetchImages } from './services/images';
import { dispatchDailyReviews } from './services/review';
import { writeTaglines } from './services/taglines';

export { ScoreEventsWorkflow } from './pipeline/score-run';
export { SourceRunWorkflow } from './pipeline/source-run';
export { DailyReviewWorkflow, EnrichEventWorkflow, ExtractItemWorkflow, PhotoIngestWorkflow } from './workflows';

const app = new Hono<AppEnv>();

// Workers Caching stores any GET without an explicit policy (heuristically, for hours). Only routes that opt in
// with their own Cache-Control are cacheable; everything else under /api is no-store.
app.use('/api/*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
});

// Event images from R2 (services/images.ts). Keys change with the image, so they are immutable; registered before
// the session middleware, since an image needs no user.
app.get('/api/img/events/*', async (c) => {
  const obj = await c.env.MEDIA.get(c.req.path.slice('/api/img/'.length));
  if (!obj) throw new HTTPException(404, { message: 'Not found' });
  return c.body(obj.body, 200, {
    'Content-Type': obj.httpMetadata?.contentType ?? 'image/webp',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: obj.httpEtag,
  });
});

app.use('/api/*', sameOrigin);
// Reads the session cookie (one indexed lookup) only when there is one; anonymous requests skip D1 entirely.
app.use('/api/*', loadUser);

app.get('/api/health', async (c) => {
  const t0 = Date.now();
  let db: HealthResponse['db'] = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    db = 'error';
  }
  const body: HealthResponse = { ok: db === 'ok', db, dbLatencyMs: Date.now() - t0, time: new Date().toISOString() };
  return c.json(body, db === 'ok' ? 200 : 503);
});

app.route('/api/events', eventsApi);
app.route('/api/sources', sourcesApi);
app.route('/api/venues', venuesApi);
app.route('/api/highlights', highlightsApi);
app.route('/api/discover', discoverApi);
app.route('/api/invite-requests', inviteRequestsApi);
app.route('/api/admin', adminApi);
app.route('/api/auth', authApi);
app.route('/api/me/scans', scansApi);
app.route('/api/me/spotify', spotifyApi);
app.route('/api/me/youtube', youtubeApi);
app.route('/api/me', meApi);
app.route('/api/cal', calendarApi);

// MCP (docs/06) and its OAuth endpoints. /authorize is the consent page for the signed-in user; discovery,
// registration and tokens are the library's; /mcp checks the bearer token and runs the stateless MCP server.
app.on(['GET', 'POST'], '/authorize', loadUser, authorize);
// Spotify's consent screen comes back here with the signed-in user's session.
app.use('/spotify/*', loadUser);
app.route('/spotify', spotifyPages);
// Google's consent screen for YouTube Music comes back here, the same way.
app.use('/youtube/*', loadUser);
app.route('/youtube', youtubePages);
// Hono types the runtime's ExecutionContext without its `props`; the object is the same.
const to = (pick: (o: ReturnType<typeof oauth>) => typeof o.as | typeof o.rs) => (c: Context<AppEnv>) =>
  pick(oauth(c.env)).fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext<unknown>);
app.all(
  '/.well-known/oauth-protected-resource',
  to((o) => o.rs),
);
app.all(
  '/.well-known/oauth-protected-resource/*',
  to((o) => o.rs),
);
app.all(
  '/.well-known/*',
  to((o) => o.as),
);
app.all(
  '/oauth/*',
  to((o) => o.as),
);
app.all(
  '/mcp',
  to((o) => o.rs),
);
app.all(
  '/mcp/*',
  to((o) => o.rs),
);

app.all('/api/*', () => {
  throw new HTTPException(404, { message: 'Not found' });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error('unhandled', err);
  return c.json({ error: 'Something went wrong on our side. Try again in a minute.' }, 500);
});

export default {
  fetch: app.fetch,
  /**
   * Every 15 min: move events past their next date on, start a SourceRun workflow per due source, embed new
   * events, refresh the vector index and score the new events for every user.
   */
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime);
    const swept = await sweepPassedDates(env.DB, now);
    const started = await dispatchDueSources(env, now);
    // AI housekeeping is best effort: a failure here must not stop the sources from running.
    let embedded = 0;
    let indexed: number | null = null;
    try {
      embedded = await embedMissing(env, now);
      if (embedded) await markIndexStale(env.CACHE);
      indexed = await rebuildIndex(env, now);
      // New events are in the index now: score them for everyone (each run skips what is already scored).
      if (embedded) await dispatchScoring(env, undefined, now);
      else await rescoreAfterPromptChange(env, now);
    } catch (err) {
      console.error('embeddings', String(err));
    }
    // Once a day after 05:00 Berlin: the Inbox review for everyone with a taste.
    let reviews = 0;
    try {
      reviews = await dispatchDailyReviews(env, now);
    } catch (err) {
      console.error('reviews', String(err));
    }
    // A line per new event, for the lists; best effort like the rest of the AI housekeeping.
    let taglines = 0;
    try {
      taglines = await writeTaglines(env, now);
    } catch (err) {
      console.error('taglines', String(err));
    }
    // Images last: they only make the pages nicer.
    let images = 0;
    let dropped = 0;
    try {
      dropped = await dropPastImages(env, now);
      images = await fetchImages(env, now);
    } catch (err) {
      console.error('images', String(err));
    }
    console.log('cron', {
      cron: controller.cron,
      swept,
      started: started.length,
      embedded,
      indexed,
      reviews,
      images,
      dropped,
      taglines,
    });
  },
} satisfies ExportedHandler<Env>;
