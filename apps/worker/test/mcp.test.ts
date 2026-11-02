import { berlinLocalToUtc } from '@bln/shared';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { refreshAllNextDates } from '../src/pipeline/next-dates';

/** The MCP server end to end: OAuth discovery, consent for a signed-in user, tokens, and real tool calls. */

// Matches PUBLIC_ORIGIN in vitest.config.ts: tokens are bound to `<origin>/mcp`.
const BASE = 'http://localhost';
const REDIRECT = 'https://client.test/callback';
const DAY = 86_400_000;
const local = (days: number, hh = 20) =>
  `${new Date(Date.now() + days * DAY).toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:00`;

const call = (path: string, init: RequestInit = {}) => exports.default.fetch(`${BASE}${path}`, init);
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function signedIn(): Promise<{ cookie: string; userId: string }> {
  const res = await call('/api/admin/users', {
    method: 'POST',
    headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Mia', email: 'mia@example.org' }),
  });
  const { user, loginLink } = (await res.json()) as { user: { id: string }; loginLink: { url: string } };
  const login = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(loginLink.url).pathname.split('/').pop() }),
  });
  return { cookie: cookieOf(login), userId: user.id };
}

/** Registers a client, approves it as the signed-in user and exchanges the code; returns the access token. */
async function connect(session: string, scopes: string[]): Promise<string> {
  const reg = await call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const authorizeUrl = `/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st',
    scope: 'mcp:read mcp:write',
    resource: `${BASE}/mcp`,
  })}`;

  const page = await call(authorizeUrl, { headers: { cookie: session } });
  expect(page.status).toBe(200);
  const htmlText = await page.text();
  expect(htmlText).toContain('Allow Test client to use your account, Mia?');
  const handle = /name="handle" value="([^"]+)"/.exec(htmlText)![1]!;

  const form = new URLSearchParams({ handle, decision: 'approve' });
  for (const s of scopes) form.append('scope', s);
  const approved = await call(authorizeUrl, {
    method: 'POST',
    headers: { cookie: `${session}; ${cookieOf(page)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  expect(approved.status).toBe(302);
  const back = new URL(approved.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st');

  const token = await call('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

let rpcId = 0;
/** One JSON-RPC request to /mcp; reads a JSON or an SSE reply. */
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await call('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      host: 'localhost', // real requests always carry one; the MCP handler checks it
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.text();
  expect(res.status, `${res.headers.get('www-authenticate')} ${body}`).toBe(200);
  const json = res.headers.get('content-type')?.includes('text/event-stream')
    ? body
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5))
        .join('')
    : body;
  return JSON.parse(json) as { result?: Record<string, unknown>; error?: { message: string } };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const result = r.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
}

async function initialize(token: string) {
  const r = await rpc(token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  expect(r.result).toMatchObject({ serverInfo: { name: 'bln-vorstellungen' } });
}

describe('MCP server', () => {
  let session = '';

  beforeAll(async () => {
    const u = await signedIn();
    session = u.cookie;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO venues (id, name, district) VALUES ('v_mcp', 'HAU2', 'Kreuzberg')`),
      ...[
        ['mcp_a', 'mcp-a', 'Tanzabend', 'dance'],
        ['mcp_b', 'mcp-b', 'Kinder Rave', 'club'],
      ].map(([id, slug, title, cat], i) =>
        env.DB.prepare(
          `INSERT INTO events (id, slug, title, lang, category, venue_id, price_min, dedup_key, created_by)
           VALUES (?, ?, ?, 'de', ?, 'v_mcp', 12, ?, 't')`,
        ).bind(id, slug, title, cat, `mcp${i}`),
      ),
      ...[
        ['mcp_a', 2, 20],
        ['mcp_a', 9, 0],
        ['mcp_b', 3, 15],
      ].map(([id, d, hh], i) =>
        env.DB.prepare(`INSERT INTO occurrences (id, event_id, start_local, start_utc) VALUES (?, ?, ?, ?)`).bind(
          `mcp_o${i}`,
          id,
          local(d as number, hh as number),
          berlinLocalToUtc(local(d as number, hh as number)),
        ),
      ),
      env.DB.prepare(
        `UPDATE user_profiles SET taste_text = 'Contemporary dance', profile_version = 1 WHERE user_id = ?`,
      ).bind(u.userId),
      env.DB.prepare(
        `INSERT INTO user_event_scores (user_id, event_id, score, reasons, profile_version, computed_at)
         VALUES (?, 'mcp_a', 88, ?, 1, '2026-01-01T00:00:00Z'), (?, 'mcp_b', 30, '[]', 1, '2026-01-01T00:00:00Z')`,
      ).bind(u.userId, JSON.stringify([{ kind: 'for', text: 'Contemporary dance, which you asked for' }]), u.userId),
    ]);
    await refreshAllNextDates(env.DB);
  });

  it('points unauthenticated clients at its OAuth metadata', async () => {
    const res = await call('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`${BASE}/.well-known/oauth-protected-resource/mcp`);

    const prm = (await (await call('/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const asm = (await (await call('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(asm).toMatchObject({ issuer: BASE, authorization_endpoint: `${BASE}/authorize` });
  });

  it('asks to sign in first when there is no session', async () => {
    const res = await call(`/authorize?client_id=x&response_type=code`);
    expect(res.status).toBe(400); // unknown client: rendered, never redirected
    const reg = await call('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'X', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const page = await call(
      `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: REDIRECT,
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      })}`,
    );
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('Sign in to connect');
  });

  it('serves the signed-in user picks, events, details and agenda, and marks events', async () => {
    const token = await connect(session, ['mcp:read', 'mcp:write']);
    await initialize(token);

    const tools = (await rpc(token, 'tools/list')).result as { tools: { name: string }[] };
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        'add_events_from_text',
        'confirm_events',
        'decline_invite_request',
        'get_event',
        'get_taste',
        'invite_requester',
        'list_events',
        'list_invite_requests',
        'mark_event',
        'my_agenda',
        'my_highlights',
        'my_picks',
        'search_events',
        'set_taste',
      ].sort(),
    );

    const picks = await tool(token, 'my_picks');
    expect(picks.text).toContain(`[Tanzabend](${BASE}/e/mcp-a)`);
    expect(picks.text).toContain('score 88 — Contemporary dance, which you asked for');
    expect(picks.text).not.toContain('Kinder Rave'); // scored 30, below the default minScore

    const list = await tool(token, 'list_events', { category: 'club' });
    expect(list.text).toContain('Kinder Rave');
    expect(list.text).toContain('score 30');

    const detail = await tool(token, 'get_event', { slug: 'mcp-a' });
    expect(detail.text).toContain('**Score for you: 88/100**');
    expect(detail.text).toContain('## Dates (2)');
    // The second date has no time (00:00 from the source): just the day.
    expect(detail.text).toMatch(/^- \w\w \d\d\.\d\d\.$/m);

    const missing = await tool(token, 'get_event', { slug: 'nope' });
    expect(missing.isError).toBe(true);

    const marked = await tool(token, 'mark_event', { slug: 'mcp-a', state: 'interested', date: local(9).slice(0, 10) });
    expect(marked.isError).toBe(false);
    const agenda = await tool(token, 'my_agenda');
    expect(agenda.text).toContain('Tanzabend');
    expect(agenda.text).toContain('interested');
    expect((await tool(token, 'my_picks')).text).not.toContain('Tanzabend'); // marked events leave the picks

    const wrongDate = await tool(token, 'mark_event', { slug: 'mcp-b', state: 'maybe', date: '2020-01-01' });
    expect(wrongDate.isError).toBe(true);
  });

  it('keeps a read-only connection from changing anything', async () => {
    const token = await connect(session, ['mcp:read']);
    await initialize(token);
    const res = await tool(token, 'mark_event', { slug: 'mcp-b', state: 'hidden' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('read-only');
    const add = await tool(token, 'add_events_from_text', { text: 'Konzert am Freitag 20 Uhr im Lido, 15 €.' });
    expect(add.isError).toBe(true);
    expect(add.text).toContain('read-only');
  });

  it('lets only the owner list and answer invite requests', async () => {
    const asked = await call('/api/invite-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Lena Berg', email: 'Lena@Example.org', note: 'Opera and free jazz' }),
    });
    expect(asked.status).toBe(201);
    const token = await connect(session, ['mcp:read', 'mcp:write']);
    await initialize(token);
    // Mia is no owner yet.
    expect((await tool(token, 'list_invite_requests')).text).toContain('Only the site owner');
    await env.DB.prepare(`UPDATE users SET is_owner = 1 WHERE email = 'mia@example.org'`).run();

    const list = await tool(token, 'list_invite_requests');
    expect(list.text).toContain('Lena Berg <lena@example.org>');
    expect(list.text).toContain('Likes (their words): "Opera and free jazz"');
    const id = /id `([^`]+)`/.exec(list.text)![1]!;
    const invited = await tool(token, 'invite_requester', { id });
    expect(invited.isError).toBe(false);
    expect(invited.text).toMatch(/http:\/\/localhost\/login\/\S+/);
    const taste = await env.DB.prepare(
      `SELECT p.taste_text FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.email = 'lena@example.org'`,
    ).first<{ taste_text: string }>();
    expect(taste?.taste_text).toBe('Opera and free jazz'); // their note is a first taste
    expect((await tool(token, 'list_invite_requests')).text).toBe('No requests waiting.');
    expect((await tool(token, 'decline_invite_request', { id })).text).toContain('already invited');
    await env.DB.prepare(`UPDATE users SET is_owner = 0 WHERE email = 'mia@example.org'`).run();
  });
});
