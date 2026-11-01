import { AgendaResponse, InboxResponse, MeResponse, MyEvent, MyStates, berlinLocalToUtc } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { quantize } from '../src/ai/embed';
import { MODELS } from '../src/ai/models';
import { baseFromCosine, parseScores, scoreByRules, scoreWithLlm } from '../src/ai/score';
import { rebuildIndex } from '../src/ai/vector-index';
import { refreshAllNextDates } from '../src/pipeline/next-dates';

const BASE = 'https://bln.test';
const DAY = 86_400_000;
const local = (days: number, hh = 20) =>
  `${new Date(Date.now() + days * DAY).toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:00`;

const admin = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(`${BASE}/api/admin${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json', ...init.headers },
  });

async function createUser(name: string, email: string, owner = false) {
  const res = await admin('/users', { method: 'POST', body: JSON.stringify({ name, email, owner }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { user: { id: string }; loginLink: { url: string } };
}

/** Logs in through the link and returns the session cookie. */
async function login(url: string): Promise<string> {
  const token = new URL(url).pathname.split('/').pop()!;
  const res = await exports.default.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const as =
  (cookie: string) =>
  (path: string, init: RequestInit = {}) =>
    exports.default.fetch(`${BASE}${path}`, {
      ...init,
      headers: { cookie, origin: BASE, 'content-type': 'application/json', ...init.headers },
    });

describe('optional passwords', () => {
  const pw = (path: string, body: unknown, cookie?: string) =>
    exports.default.fetch(`${BASE}${path}`, {
      method: path.startsWith('/api/me') ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it('lets a signed-in user set a password, then sign in with email and password', async () => {
    const { loginLink } = await createUser('Pat', 'Pat@Example.org');
    const cookie = await login(loginLink.url);
    expect(await (await as(cookie)('/api/me/password')).json()).toEqual({ set: false });
    expect((await pw('/api/me/password', { password: 'short' }, cookie)).status).toBe(400);
    expect((await pw('/api/me/password', { password: 'long enough secret' }, cookie)).status).toBe(200);
    expect(await (await as(cookie)('/api/me/password')).json()).toEqual({ set: true });

    const ok = await pw('/api/auth/password', { email: ' pat@example.org ', password: 'long enough secret' });
    expect(ok.status).toBe(200);
    expect(MeResponse.parse(await ok.json()).user).toMatchObject({ name: 'Pat' });
    expect(ok.headers.get('set-cookie')).toMatch(/^bln_session=/);

    // Changing needs the current password.
    expect((await pw('/api/me/password', { password: 'another long one' }, cookie)).status).toBe(403);
    expect(
      (await pw('/api/me/password', { password: 'another long one', current: 'long enough secret' }, cookie)).status,
    ).toBe(200);
    expect((await pw('/api/auth/password', { email: 'pat@example.org', password: 'long enough secret' })).status).toBe(
      401,
    );
  });

  it('answers unknown emails like wrong passwords and locks after five wrong tries', async () => {
    const unknown = await pw('/api/auth/password', { email: 'nobody@example.org', password: 'whatever it is' });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'Email or password is wrong.' });

    const { loginLink } = await createUser('Lu', 'lu@example.org');
    await pw('/api/me/password', { password: 'right password here' }, await login(loginLink.url));
    for (let i = 0; i < 5; i++) {
      expect((await pw('/api/auth/password', { email: 'lu@example.org', password: `wrong ${i}` })).status).toBe(401);
    }
    const locked = await pw('/api/auth/password', { email: 'lu@example.org', password: 'right password here' });
    expect(locked.status).toBe(429);
  });
});

describe('sign-in with pre-defined users', () => {
  it('logs in once per link, keeps the session, and signs out', async () => {
    const { loginLink } = await createUser('Ada', 'ada@example.org');
    expect(loginLink.url).toMatch(/^https:\/\/bln\.test\/login\//);
    const cookie = await login(loginLink.url);
    expect(cookie).toMatch(/^bln_session=/);

    const me = MeResponse.parse(await (await as(cookie)('/api/me')).json());
    expect(me.user).toMatchObject({ name: 'Ada', email: 'ada@example.org', isOwner: false });

    const token = new URL(loginLink.url).pathname.split('/').pop();
    const again = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(401);

    await as(cookie)('/api/auth/logout', { method: 'POST' });
    expect(MeResponse.parse(await (await as(cookie)('/api/me')).json()).user).toBeNull();
  });

  it('is anonymous without a cookie and refuses personal routes', async () => {
    expect(MeResponse.parse(await (await exports.default.fetch(`${BASE}/api/me`)).json()).user).toBeNull();
    expect((await exports.default.fetch(`${BASE}/api/me/inbox`)).status).toBe(401);
  });

  it('refuses cross-site writes and lets only owners into the admin API', async () => {
    const owner = await login((await createUser('Owner', 'owner@example.org', true)).loginLink.url);
    const guest = await login((await createUser('Guest', 'guest@example.org')).loginLink.url);
    const evil = await as(guest)('/api/me/login-link', { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect((await as(guest)('/api/admin/users')).status).toBe(401);
    const list = await as(owner)('/api/admin/users');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { users: unknown[] }).users.length).toBeGreaterThanOrEqual(3);
  });
});

describe('inbox, triage and agenda', () => {
  let cookie = '';
  let userId = '';

  beforeAll(async () => {
    const u = await createUser('Bea', 'bea@example.org');
    userId = u.user.id;
    cookie = await login(u.loginLink.url);
    const stmts = [
      env.DB.prepare(`INSERT INTO venues (id, name) VALUES ('v_me', 'Radialsystem')`),
      ...['a', 'b', 'c'].map((k, i) =>
        env.DB.prepare(
          `INSERT INTO events (id, slug, title, lang, category, venue_id, dedup_key, created_by)
           VALUES (?, ?, ?, 'de', 'dance', 'v_me', ?, 't')`,
        ).bind(`me_${k}`, `me-${k}`, `Stück ${k.toUpperCase()}`, `me${k}${i}`),
      ),
      ...[
        ['me_a', 2],
        ['me_a', 9],
        ['me_b', 3],
        ['me_c', 30],
      ].map(([id, d], i) =>
        env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`).bind(
          `me_o${i}`,
          id,
          local(d as number),
          berlinLocalToUtc(local(d as number)),
        ),
      ),
      ...[
        ['me_a', 91],
        ['me_b', 64],
        ['me_c', 40],
      ].map(([id, score]) =>
        env.DB.prepare(
          `INSERT INTO user_event_scores (user_id, event_id, score, reasons, profile_version, computed_at)
           VALUES (?, ?, ?, ?, 1, '2026-01-01T00:00:00Z')`,
        ).bind(userId, id, score, JSON.stringify([{ kind: 'for', text: 'Contemporary dance' }])),
      ),
    ];
    await env.DB.batch(stmts);
    await refreshAllNextDates(env.DB);
  });

  const inbox = async (range = 'all') =>
    InboxResponse.parse(await (await as(cookie)(`/api/me/inbox?range=${range}`)).json());
  const mark = (slug: string, state: string | null, occurrenceId?: string) =>
    as(cookie)(`/api/me/events/${slug}/state`, { method: 'PUT', body: JSON.stringify({ state, occurrenceId }) });

  it('ranks scored events best first, with reasons, and limits the week view', async () => {
    const all = await inbox();
    expect(all.items.map((i) => i.slug)).toEqual(['me-a', 'me-b', 'me-c']);
    expect(all.items[0]).toMatchObject({
      score: 91,
      moreDates: 1,
      reasons: [{ kind: 'for', text: 'Contemporary dance' }],
    });
    expect(all).toMatchObject({ total: 3, done: 0 });
    expect((await inbox('week')).items.map((i) => i.slug)).toEqual(['me-a', 'me-b']);
  });

  it('removes triaged events, never brings hidden ones back, and undoes', async () => {
    expect((await mark('me-a', 'interested', 'me_o1')).status).toBe(200);
    expect((await mark('me-c', 'hidden')).status).toBe(200);
    const after = await inbox();
    expect(after.items.map((i) => i.slug)).toEqual(['me-b']);
    expect(after).toMatchObject({ total: 3, done: 2 });

    const mine = MyEvent.parse(await (await as(cookie)('/api/me/events/me-a')).json());
    expect(mine).toMatchObject({ score: 91, state: 'interested', occurrenceId: 'me_o1' });

    await mark('me-b', 'maybe');
    await mark('me-b', null);
    expect((await inbox()).items.map((i) => i.slug)).toEqual(['me-b']);
    expect((await mark('me-b', 'maybe', 'me_o0')).status).toBe(400);

    // List rows read every mark at once.
    const states = MyStates.parse(await (await as(cookie)('/api/me/states')).json());
    expect(states.states).toEqual({ 'me-a': 'interested', 'me-c': 'hidden' });
  });

  it('lists interested dates in the agenda and exports them as iCalendar', async () => {
    await mark('me-b', 'maybe');
    const agenda = AgendaResponse.parse(await (await as(cookie)('/api/me/agenda')).json());
    expect(agenda.items.map((i) => [i.slug, i.state, i.occurrenceId])).toEqual([
      ['me-b', 'maybe', 'me_o2'],
      ['me-a', 'interested', 'me_o1'],
    ]);

    const link = (await (await as(cookie)('/api/me/calendar-link', { method: 'POST' })).json()) as { url: string };
    const ics = await (await exports.default.fetch(link.url)).text();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain(`DTSTART;TZID=Europe/Berlin:${local(9).replace(/[-:]/g, '')}00`);
    expect(ics).toContain('SUMMARY:(maybe) Stück B');
    expect(ics).toContain('LOCATION:Radialsystem\\, Berlin');
    expect(ics.split('BEGIN:VEVENT')).toHaveLength(3);
    const next = (await (await as(cookie)('/api/me/calendar-link', { method: 'POST' })).json()) as { url: string };
    expect((await exports.default.fetch(link.url)).status).toBe(404);
    expect((await exports.default.fetch(next.url)).status).toBe(200);
  });
});

describe('scoring', () => {
  const vec = (xs: number[]) => {
    const v = new Array<number>(MODELS.embed.dims).fill(0);
    xs.forEach((x, i) => (v[i] = x));
    return quantize(v);
  };

  it('maps cosine onto 0..60', () => {
    expect([0.1, 0.3, 0.45, 0.6, 0.9].map(baseFromCosine)).toEqual([0, 0, 30, 60, 60]);
  });

  it('filters by prefs, ranks by taste, then lets the LLM score the best candidates', async () => {
    const u = await createUser('Cem', 'cem@example.org');
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE user_profiles SET taste_text = 'contemporary dance', prefs = ?, profile_embedding = ?, profile_version = 3
          WHERE user_id = ?`,
      ).bind(JSON.stringify({ categoriesOff: ['club'], maxPrice: 30 }), vec([1, 0]).buffer, u.user.id),
      ...[
        ['sc_dance', 'dance', null, [1, 0.2]],
        ['sc_club', 'club', null, [1, 0.2]],
        ['sc_pricey', 'opera', 120, [1, 0.2]],
        ['sc_far', 'talk', null, [0, 1]],
        ['sc_kink', 'kink', null, [1, 0.2]],
      ].flatMap(([id, cat, price, xs], i) => [
        env.DB.prepare(
          `INSERT INTO events (id, slug, title, lang, category, price_min, dedup_key, created_by) VALUES (?, ?, ?, 'en', ?, ?, ?, 't')`,
        ).bind(id, id, `Event ${id}`, cat, price, `sc${i}`),
        env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`).bind(
          `${id}_o`,
          id,
          local(4),
          berlinLocalToUtc(local(4)),
        ),
        env.DB.prepare(
          `INSERT INTO event_embeddings (event_id, model, dims, vector, text_hash) VALUES (?, ?, ?, ?, 'x')`,
        ).bind(id, `${MODELS.embed.id}#int8`, MODELS.embed.dims, vec(xs as number[]).buffer),
      ]),
    ]);
    await refreshAllNextDates(env.DB);
    await rebuildIndex(env, new Date(), true);

    const r = await scoreByRules(env, u.user.id);
    expect(r.candidates).toEqual(['sc_dance']);
    const rows = await env.DB.prepare(
      `SELECT event_id, score, reasons, profile_version FROM user_event_scores WHERE user_id = ? AND event_id LIKE 'sc_%' ORDER BY event_id`,
    )
      .bind(u.user.id)
      .all<{ event_id: string; score: number; reasons: string; profile_version: number }>();
    expect(rows.results.map((x) => [x.event_id, x.score])).toEqual([
      ['sc_club', 0],
      ['sc_dance', 60],
      ['sc_far', 0],
      ['sc_kink', 0],
      ['sc_pricey', 0],
    ]);
    expect(JSON.parse(rows.results[0]!.reasons)[0].text).toBe('You turned off Club');
    expect(JSON.parse(rows.results[3]!.reasons)[0].text).toBe('Sex-positive & kink is off until you turn it on');
    expect(rows.results.every((x) => x.profile_version === 3)).toBe(true);
    expect((await scoreByRules(env, u.user.id)).scored).toBe(0);

    const ai = {
      ...env,
      AI: {
        run: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  scores: [{ n: 1, score: 88, reasons: [{ kind: 'for', text: 'Dance, as asked' }] }],
                }),
              },
            },
          ],
          usage: { neurons: 2 },
        }),
      },
    } as unknown as Env;
    await scoreWithLlm({ ...ai, SCORE_MODEL: 'workers-ai' } as unknown as Env, u.user.id, ['sc_dance']);
    const dance = await env.DB.prepare(
      `SELECT score, model, prompt_version FROM user_event_scores WHERE user_id = ? AND event_id = 'sc_dance'`,
    )
      .bind(u.user.id)
      .first();
    expect(dance).toEqual({ score: 88, model: MODELS.extract.id, prompt_version: 'score@2' });

    // A score from an older scoring prompt is stale: the next run picks the event up again.
    expect((await scoreByRules(env, u.user.id)).scored).toBe(0);
    await env.DB.prepare(
      `UPDATE user_event_scores SET prompt_version = 'score@1' WHERE user_id = ? AND event_id = 'sc_dance'`,
    )
      .bind(u.user.id)
      .run();
    const again = await scoreByRules(env, u.user.id);
    expect(again.scored).toBe(1);
    expect(again.candidates).toEqual(['sc_dance']);
  });

  it('rejects replies that skip most events', () => {
    expect(parseScores({ scores: [{ n: 1, score: 50, reasons: [] }] }, 4)).toBeNull();
    expect(
      parseScores(
        {
          scores: [
            { n: 1, score: 50, reasons: [] },
            { n: 9, score: 1, reasons: [] },
          ],
        },
        2,
      ),
    ).toHaveLength(1);
  });

  it('keeps opt-in categories out of public lists and scores them only for users who switched them on', async () => {
    // Runs after the test above, which created sc_kink with an embedding.
    const all = (await (await exports.default.fetch(`${BASE}/api/events`)).json()) as { items: { slug: string }[] };
    expect(all.items.map((e) => e.slug)).not.toContain('sc_kink');
    const asked = (await (await exports.default.fetch(`${BASE}/api/events?category=kink`)).json()) as {
      items: { slug: string }[];
    };
    expect(asked.items.map((e) => e.slug)).toEqual(['sc_kink']);
    const similar = (await (await exports.default.fetch(`${BASE}/api/events/sc_dance/similar`)).json()) as {
      items: { slug: string }[];
    };
    expect(similar.items.map((e) => e.slug)).not.toContain('sc_kink');

    const u = await createUser('Dee', 'dee@example.org');
    await env.DB.prepare(
      `UPDATE user_profiles SET taste_text = 'play parties', prefs = ?, profile_embedding = ?, profile_version = 2
        WHERE user_id = ?`,
    )
      .bind(JSON.stringify({ categoriesOn: ['kink'] }), vec([1, 0]).buffer, u.user.id)
      .run();
    const r = await scoreByRules(env, u.user.id);
    expect(r.candidates).toContain('sc_kink');
  });
});

describe('how often a category comes up', () => {
  it('keeps less and rarely categories to strong matches and mixes the order', async () => {
    const u = await createUser('Fia', 'fia@example.org');
    const cookie = await login(u.loginLink.url);
    const rows = [
      ['fq_t1', 'theatre', 92],
      ['fq_t2', 'theatre', 88],
      ['fq_t3', 'theatre', 70],
      ['fq_c1', 'concert', 64],
      ['fq_e1', 'exhibition', 55],
    ] as const;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE user_profiles SET taste_text = 'x', prefs = ?, profile_version = 1 WHERE user_id = ?`,
      ).bind(JSON.stringify({ frequency: { theatre: 'rarely', exhibition: 'less' } }), u.user.id),
      ...rows.flatMap(([id, cat, score], i) => [
        env.DB.prepare(
          `INSERT INTO events (id, slug, title, lang, category, dedup_key, created_by) VALUES (?, ?, ?, 'en', ?, ?, 't')`,
        ).bind(id, id, id, cat, `fq${i}`),
        env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`).bind(
          `${id}_o`,
          id,
          local(3 + i),
          berlinLocalToUtc(local(3 + i)),
        ),
        env.DB.prepare(
          `INSERT INTO user_event_scores (user_id, event_id, score, reasons, profile_version, computed_at)
           VALUES (?, ?, ?, '[]', 1, '2026-01-01T00:00:00Z')`,
        ).bind(u.user.id, id, score),
      ]),
    ]);
    await refreshAllNextDates(env.DB);
    const inbox = InboxResponse.parse(await (await as(cookie)('/api/me/inbox')).json());
    // Rarely: theatre only from 75 (t3 at 70 stays out); less: exhibition only from 60 (e1 at 55 stays out).
    // Mixing only swaps similar scores: the concert at 64 is too far below the theatre at 88 to move up.
    expect(inbox.items.map((i) => i.slug)).toEqual(['fq_t1', 'fq_t2', 'fq_c1']);
    expect(inbox.total).toBe(3);
  });
});
