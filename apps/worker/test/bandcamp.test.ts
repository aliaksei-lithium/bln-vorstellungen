import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  bandcampStatus,
  bandcampUsername,
  connect,
  disconnect,
  fanId,
  fetchArtists,
  syncArtists,
} from '../src/bandcamp';

/** Bandcamp: artists from a public fan page, through a faked bandcamp.com. */

// Genres would cost a model call; Workers AI is not reachable in tests, so they stay empty.
const overrides: Record<string, string> = { SCORE_MODEL: 'workers-ai' };
const bc = new Proxy(env, {
  get: (target, key) => (typeof key === 'string' && key in overrides ? overrides[key] : Reflect.get(target, key)),
}) as Env;

const FAN_PAGE =
  '<html><div id="pagedata" data-blob="{&quot;fan_data&quot;:{&quot;name&quot;:&quot;Fan&quot;,&quot;fan_id&quot;:4242,' +
  '&quot;username&quot;:&quot;goodfan&quot;},&quot;followers&quot;:[{&quot;fan_id&quot;:1}]}"></div></html>';

/** bandcamp.com, answered from fixtures; `seen` collects the requests. */
function fake(seen: { url: string; body?: Record<string, unknown> }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ url, body });
    if (url === 'https://bandcamp.com/goodfan') return new Response(FAN_PAGE);
    if (url === 'https://bandcamp.com/blocked') {
      return new Response(
        '<html><head><title>Client Challenge</title><link href="/_fs-ch-1T1/assets/x.css"></head></html>',
      );
    }
    if (url === 'https://bandcamp.com/nofan') return new Response('<html>a label page</html>');
    if (url.endsWith('/collection_items')) {
      if (body?.older_than_token === 'next') {
        return Response.json({ items: [{ band_name: 'Slowdive' }], more_available: false });
      }
      return Response.json({
        items: [
          { band_name: 'Moving As A Giant' },
          { band_name: 'Slowdive' },
          { band_name: 'Various Artists' },
          { band_name: 'METZ' },
        ],
        more_available: true,
        last_token: 'next',
      });
    }
    if (url.endsWith('/wishlist_items')) {
      return Response.json({ items: [{ band_name: 'slowdive' }, { band_name: 'Sofoquina' }], more_available: false });
    }
    if (url.endsWith('/following_bands')) return new Response('nope', { status: 500 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('bandcamp', () => {
  it('reads the fan name from what people type', () => {
    expect(bandcampUsername('goodfan')).toBe('goodfan');
    expect(bandcampUsername(' @goodfan ')).toBe('goodfan');
    expect(bandcampUsername('https://bandcamp.com/goodfan/wishlist')).toBe('goodfan');
    expect(bandcampUsername('bandcamp.com/good_fan-2')).toBe('good_fan-2');
    expect(bandcampUsername('https://slowdive.bandcamp.com/')).toBeNull();
    expect(bandcampUsername('slowdive.bandcamp.com')).toBeNull();
    expect(bandcampUsername('https://example.org/goodfan')).toBeNull();
    expect(bandcampUsername('two words')).toBeNull();
  });

  it('finds the fan id on the fan page, not a follower’s', async () => {
    expect(await fanId('goodfan', fake())).toBe(4242);
    await expect(fanId('nofan', fake())).rejects.toMatchObject({ status: 404 });
    await expect(fanId('missing', fake())).rejects.toMatchObject({ status: 404 });
    // A bot check is not a wrong name.
    await expect(fanId('blocked', fake())).rejects.toMatchObject({ status: 503 });
  });

  it('ranks bought artists by purchases, then wishlist, skipping compilations and a failing list', async () => {
    const seen: { url: string; body?: Record<string, unknown> }[] = [];
    const artists = await fetchArtists(4242, fake(seen), new Date('2026-11-04T12:00:00Z'));
    expect(artists.map((a) => a.name)).toEqual(['Slowdive', 'Moving As A Giant', 'METZ', 'Sofoquina']);
    expect(seen.find((s) => s.url.endsWith('/collection_items'))?.body).toEqual({
      fan_id: 4242,
      older_than_token: '1793793600::a::',
      count: 100,
    });
  });

  it('connects with a fan page link, stores artists apart from Spotify, syncs and disconnects', async () => {
    await env.DB.prepare(`INSERT INTO users (id, name, email) VALUES ('u_bc', 'BC', 'bc@example.org')`).run();
    expect(await connect(bc, 'u_bc', 'https://bandcamp.com/goodfan', fake())).toBe(4);
    expect(await bandcampStatus(env.DB, 'u_bc')).toMatchObject({
      connected: true,
      username: 'goodfan',
      artists: ['Slowdive', 'Moving As A Giant', 'METZ', 'Sofoquina'],
    });
    const { n } = (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_artists WHERE user_id = 'u_bc' AND source = 'bandcamp'`,
    ).first<{ n: number }>())!;
    expect(n).toBe(4);
    expect(await syncArtists(bc, 'u_bc', fake())).toBe(4);
    await expect(connect(bc, 'u_bc', 'slowdive.bandcamp.com', fake())).rejects.toMatchObject({ status: 400 });
    await disconnect(env.DB, 'u_bc');
    expect(await bandcampStatus(env.DB, 'u_bc')).toMatchObject({ connected: false, username: null, artists: [] });
    await expect(syncArtists(bc, 'u_bc', fake())).rejects.toMatchObject({ status: 409 });
  });
});
