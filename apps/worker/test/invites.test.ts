import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { REQUESTS_PER_DAY, listInviteRequests } from '../src/services/invites';

/** "Ask for an invite": the public form, its limits, and the owner's admin routes. */

const post = (body: unknown) =>
  exports.default.fetch('https://x/api/invite-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const admin = (path: string, method = 'GET') =>
  exports.default.fetch(`https://x/api/admin${path}`, {
    method,
    headers: { authorization: 'Bearer test-admin-token' },
  });

describe('invite requests', () => {
  it('stores one pending request per email, ignores bots, and checks input', async () => {
    expect((await post({ name: 'Ola', email: 'ola@example.org' })).status).toBe(201);
    expect((await post({ name: 'Ola K.', email: 'OLA@example.org', note: 'Techno' })).status).toBe(201);
    expect((await post({ name: 'Bot', email: 'bot@example.org', website: 'http://spam' })).status).toBe(201);
    expect((await post({ name: '', email: 'x@example.org' })).status).toBe(400);
    expect((await post({ name: 'X', email: 'not-an-email' })).status).toBe(400);
    const mine = (await listInviteRequests(env.DB)).filter((r) => r.email === 'ola@example.org');
    expect(mine).toEqual([expect.objectContaining({ name: 'Ola K.', note: 'Techno', status: 'pending' })]);
    expect((await listInviteRequests(env.DB)).some((r) => r.email === 'bot@example.org')).toBe(false);
  });

  it('lets the owner invite (account and login link) or decline', async () => {
    await post({ name: 'Ines', email: 'ines@example.org' });
    await post({ name: 'Nope', email: 'nope@example.org' });
    const { requests } = (await (await admin('/invites')).json()) as { requests: { id: string; email: string }[] };
    const ines = requests.find((r) => r.email === 'ines@example.org')!;
    const nope = requests.find((r) => r.email === 'nope@example.org')!;
    const res = await admin(`/invites/${ines.id}/accept`, 'POST');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { request: { status: string }; loginLink: { url: string } };
    expect(body.request.status).toBe('invited');
    expect(body.loginLink.url).toMatch(/^https:\/\/x\/login\//);
    expect(await env.DB.prepare(`SELECT 1 AS ok FROM users WHERE email = 'ines@example.org'`).first()).toEqual({
      ok: 1,
    });
    expect((await admin(`/invites/${nope.id}/decline`, 'POST')).status).toBe(200);
    expect((await admin(`/invites/${nope.id}/accept`, 'POST')).status).toBe(409);
    // Without the owner's token, nothing.
    expect((await exports.default.fetch('https://x/api/admin/invites')).status).toBe(401);
  });

  it('stops after the daily limit', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM invite_requests WHERE created_at >= ?`)
      .bind(today)
      .first<{ n: number }>())!;
    for (let i = n; i < REQUESTS_PER_DAY; i++) await post({ name: `P${i}`, email: `p${i}@example.org` });
    expect((await post({ name: 'Late', email: 'late@example.org' })).status).toBe(429);
  });
});
