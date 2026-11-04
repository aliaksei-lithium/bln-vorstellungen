import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
  insufficientScope,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import type { Context } from 'hono';
import type { AppEnv } from '../auth';
import { seenById } from '../services/activity';
import { buildServer, type McpProps } from './server';

/**
 * MCP authorization (docs/09, 2026-11-01): this Worker is both the OAuth authorization server (issuer = the site's
 * origin) and the MCP resource server (`<origin>/mcp`). Signing in is the site's own session; `/authorize` only asks
 * the signed-in user to allow the client. Grants and tokens live in OAUTH_KV.
 */

export const SCOPES = ['mcp:read', 'mcp:write', 'offline_access'] as const;
const SCOPE_TEXT: Record<string, string> = {
  'mcp:read': 'See events, your picks, scores, taste and agenda',
  'mcp:write': 'Mark events and change your taste description',
  offline_access: 'Stay connected without asking again',
};
const DAY_S = 86_400;

type Oauth = { as: OAuthAuthorizationServer<Env>; rs: OAuthResourceServer<Env, McpProps>; origin: string };
let cached: Oauth | null = null;

/** Built once per isolate from PUBLIC_ORIGIN, which every token is bound to. */
export function oauth(env: Env): Oauth {
  const origin = env.PUBLIC_ORIGIN.replace(/\/$/, '');
  if (cached?.origin === origin) return cached;
  const resource = `${origin}/mcp`;
  const as = new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: [resource],
    scopesSupported: [...SCOPES],
    clientIdMetadataDocumentEnabled: true,
    // Dynamic Client Registration, for clients without a metadata document.
    clientRegistrationEndpoint: '/oauth/register',
    // A connection stays alive while it is used at least monthly, and at most a year.
    refreshTokenTTL: 365 * DAY_S,
    refreshTokenIdleTTL: 30 * DAY_S,
  });
  const rs = new OAuthResourceServer<Env, McpProps>({
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      resource_name: 'BLN Vorstellungen',
      bearer_methods_supported: ['header'],
    },
    requiredScopes: ['mcp:read'],
    validateToken: (env) => (res, token) => as.validateToken(res, token, env),
    handler: {
      fetch(request, env, ctx) {
        if (!ctx.auth.scope.includes('mcp:read')) return insufficientScope(ctx.auth, ['mcp:read']);
        const opts = { userId: ctx.props.userId, scopes: ctx.auth.scope, origin };
        // Using the site through Claude counts as a visit (services/activity.ts).
        ctx.waitUntil(seenById(env, ctx.props.userId).catch((err) => console.warn('mcp seen', String(err))));
        return createMcpHandler(() => buildServer(env, ctx, opts), { route: '/mcp' })(request, env, ctx);
      },
    },
  });
  cached = { as, rs, origin };
  return cached;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The consent page and the "sign in first" page share this shell (the site's colours, light and dark). */
const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · BLN Vorstellungen</title>
<style>
  :root { --bg: #eeede8; --card: #fff; --ink: #1b1b25; --on-ink: #fff; --sub: #5e6070; --line: #dcdcd8;
    --moss: #4f6b4e; --warn: #8a4b00; color-scheme: light }
  @media (prefers-color-scheme: dark) { :root { --bg: #14151a; --card: #1d1e25; --ink: #e9e8e2; --on-ink: #14151a;
    --sub: #a4a6b2; --line: #31323b; --moss: #8dae8a; --warn: #e3a458; color-scheme: dark } }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 Figtree, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 420px; margin: 8vh auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  .brand { font-weight: 700; letter-spacing: .02em; margin-bottom: 16px; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 12px; text-wrap: balance; }
  p, li { color: var(--sub); } b { color: var(--ink); }
  ul { padding: 0; list-style: none; margin: 16px 0; display: grid; gap: 8px; }
  label { display: flex; gap: 10px; align-items: flex-start; color: var(--ink); }
  input[type=checkbox] { margin-top: 4px; accent-color: var(--moss); }
  .warn { color: var(--warn); }
  .row { display: flex; gap: 8px; margin-top: 20px; }
  button, a.btn { flex: 1; font: inherit; font-weight: 600; padding: 10px 14px; border-radius: 10px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: var(--ink); text-align: center; text-decoration: none; }
  button.primary, a.primary { background: var(--ink); border-color: var(--ink); color: var(--on-ink); }
</style></head>
<body><main><div class="card"><div class="brand">BLN Vorstellungen</div>${body}</div></main></body></html>`;

const html = (body: string, status = 200, headers?: Headers) => {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(body, { status, headers: h });
};

function consentPage(d: ConsentDescription, handle: string, userName: string): string {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <b>${escape(d.clientDomain)}</b>.`
    : 'This app registered itself; its name is not verified.';
  const scopes = d.scope
    .map(
      (s) =>
        `<li><label><input type="checkbox" name="scope" value="${escape(s)}" checked> ${escape(SCOPE_TEXT[s] ?? s)}</label></li>`,
    )
    .join('');
  return page(
    `Allow ${d.clientName}`,
    `<h1>Allow ${name} to use your account, ${escape(userName)}?</h1>
<p>${origin} Access goes to <b>${escape(d.redirectHost)}</b>.</p>
${d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<ul>${scopes}</ul>
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form>`,
  );
}

const signInFirst = (url: string) =>
  page(
    'Sign in first',
    `<h1>Sign in to connect</h1>
<p>Open your BLN Vorstellungen login link in this browser, then come back here and try again.</p>
<p>No link? Ask the owner for one, or create one on the Me page of a device where you are signed in.</p>
<div class="row"><a class="btn primary" href="${escape(url)}">Try again</a></div>`,
  );

/** GET shows the consent page for the signed-in user; POST records Allow or Deny and redirects to the client. */
export async function authorize(c: Context<AppEnv>): Promise<Response> {
  const req = c.req.raw;
  const api = oauth(c.env).as.getOAuthApi(c.env);
  const user = c.get('user');
  try {
    if (req.method === 'GET') {
      const request = await api.parseAuthRequest(req);
      if (!user) return html(signInFirst(req.url), 401);
      const details = await api.describeConsent(request);
      const consent = await api.beginConsent(request);
      return html(consentPage(details, consent.handle, user.name), 200, consent.headers);
    }
    if (!user) return html(page('Signed out', '<h1>You were signed out</h1><p>Sign in and connect again.</p>'), 401);
    const form = await req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await api.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const scope = form
      .getAll('scope')
      .map(String)
      .filter((s) => (SCOPES as readonly string[]).includes(s));
    if (!scope.includes('mcp:read')) scope.unshift('mcp:read');
    const approved = await api.approveConsent(req, handle, { scope });
    const { redirectTo } = await api.completeAuthorization({
      request: approved.request,
      userId: user.id,
      metadata: { name: user.name },
      scope: approved.request.scope,
      props: { userId: user.id } satisfies McpProps,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
    if (err instanceof AuthorizationError || err instanceof CimdFetchError) {
      const message = err instanceof AuthorizationError ? err.description : 'This app could not be verified.';
      return html(page('Cannot connect', `<h1>Cannot connect</h1><p>${escape(message)}</p>`), 400);
    }
    throw err;
  }
}
