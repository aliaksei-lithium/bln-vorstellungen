import { ActivityOverview } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { purgeActivity, recordAsk } from '../src/services/analytics';

const BASE = 'https://bln.test';
const admin = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${BASE}/api/admin${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json', ...init.headers },
  });

async function signedIn(name: string, email: string) {
  const res = await admin('/users', { method: 'POST', body: JSON.stringify({ name, email }) });
  const made = (await res.json()) as { user: { id: string }; loginLink: { url: string } };
  const login = await exports.default.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ token: new URL(made.loginLink.url).pathname.split('/').pop() }),
  });
  return { id: made.user.id, cookie: login.headers.get('set-cookie')!.split(';')[0]! };
}

const track = (body: unknown, cookie?: string) =>
  exports.default.fetch(`${BASE}/api/me/track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe('usage counts', () => {
  it('adds up batches per user and shows them to the owner', async () => {
    const ada = await signedIn('Ada', 'ada-analytics@example.org');
    const bob = await signedIn('Bob', 'bob-analytics@example.org');
    const first = await track(
      {
        items: [
          { kind: 'open', page: 'browse', count: 1 },
          { kind: 'view', page: 'browse', count: 2 },
          { kind: 'view', page: 'event', count: 3 },
          { kind: 'click', page: 'event', count: 4 },
        ],
      },
      ada.cookie,
    );
    expect(first.status).toBe(204);
    await track({ items: [{ kind: 'view', page: 'event', count: 1 }] }, ada.cookie);
    await recordAsk(env.DB, ada.id);

    const res = await admin('/activity?days=7');
    expect(res.status).toBe(200);
    const { days, users } = ActivityOverview.parse(await res.json());
    expect(days).toBe(7);
    expect(users.find((u) => u.id === ada.id)).toMatchObject({
      activeDays: 1,
      opens: 1,
      views: 6,
      clicks: 4,
      asks: 1,
      pages: { browse: 2, event: 4 },
    });
    expect(users.find((u) => u.id === bob.id)).toMatchObject({ activeDays: 0, views: 0, pages: {} });
    // Most active first.
    expect(users.findIndex((u) => u.id === ada.id)).toBeLessThan(users.findIndex((u) => u.id === bob.id));
  });

  it('ignores anonymous visitors and refuses anything but known counters', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_activity').first<{ n: number }>();
    expect((await track({ items: [{ kind: 'view', page: 'browse', count: 1 }] })).status).toBe(204);
    const { cookie } = await signedIn('Cy', 'cy-analytics@example.org');
    expect((await track({ items: [{ kind: 'view', page: '/e/some-event', count: 1 }] }, cookie)).status).toBe(400);
    expect((await track({ items: [{ kind: 'search', page: 'browse', count: 1 }] }, cookie)).status).toBe(400);
    expect((await track({ items: [] }, cookie)).status).toBe(400);
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_activity').first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('is owner only, and old counters are dropped', async () => {
    const { id, cookie } = await signedIn('Di', 'di-analytics@example.org');
    const res = await exports.default.fetch(`${BASE}/api/admin/activity`, { headers: { cookie } });
    expect(res.status).toBe(401);
    await env.DB.prepare(`INSERT INTO user_activity (user_id, day, kind, name, count) VALUES (?, ?, 'view', 'me', 5)`)
      .bind(id, '2020-01-01')
      .run();
    expect(await purgeActivity(env.DB)).toBe(1);
  });
});
