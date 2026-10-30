import { SourceView } from '@bln/shared';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = 'test-admin-token', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (rest.body) headers.set('content-type', 'application/json');
  return exports.default.fetch(`https://x/api/admin${path}`, { ...rest, headers });
};

describe('admin api', () => {
  it('rejects missing or wrong tokens and is never cached', async () => {
    expect((await call('/sources', { token: null })).status).toBe(401);
    expect((await call('/sources', { token: 'nope' })).status).toBe(401);
    const ok = await call('/sources');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('lists the built-in adapters', async () => {
    const body = (await (await call('/adapters')).json()) as { adapters: { type: string }[] };
    expect(body.adapters.map((a) => a.type)).toEqual(['ical', 'jsonld', 'rss']);
  });

  it('validates the adapter config on create', async () => {
    const bad = await call('/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'Broken', type: 'ical', config: { url: 'not a url' } }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/^config\.url/);
    const unknown = await call('/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', type: 'carrier-pigeon', config: {} }),
    });
    expect(((await unknown.json()) as { error: string }).error).toMatch(/Unknown source type/);
  });

  it('creates, updates and deletes a source', async () => {
    const created = await call('/sources', {
      method: 'POST',
      body: JSON.stringify({ name: 'The Left Berlin', type: 'ical', config: { url: 'https://example.org/?ical=1' } }),
    });
    expect(created.status).toBe(201);
    const s = SourceView.parse(await created.json());
    expect(s).toMatchObject({ scheduleMinutes: 360, enabled: true, nextRunAt: null, config: { maxItems: 200 } });

    const patched = SourceView.parse(
      await (
        await call(`/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ scheduleMinutes: 120 }) })
      ).json(),
    );
    expect(patched).toMatchObject({ scheduleMinutes: 120, enabled: true, name: 'The Left Berlin' });

    const runs = (await (await call(`/sources/${s.id}/runs`)).json()) as { runs: unknown[] };
    expect(runs.runs).toEqual([]);

    expect((await call(`/sources/${s.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/sources/${s.id}/runs`)).status).toBe(404);
  });
});
