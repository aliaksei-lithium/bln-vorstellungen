import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** The old workers.dev address redirects to PUBLIC_ORIGIN (http://localhost in vitest.config.ts). */
const OLD = 'https://bln-vorstellungen.aliaksei-zhynhiarouski.workers.dev';

describe('old address', () => {
  it('redirects GETs permanently, path and query kept', async () => {
    const res = await exports.default.fetch(`${OLD}/api/events?from=2026-11-21`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('http://localhost/api/events?from=2026-11-21');
    // Workers Caching keys by path, not host: a cached redirect would be served on the new domain too.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps the method for POSTs', async () => {
    const res = await exports.default.fetch(`${OLD}/mcp`, { method: 'POST', body: '{}', redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('http://localhost/mcp');
  });

  it('leaves the current address alone', async () => {
    const res = await exports.default.fetch('http://localhost/api/health');
    expect(res.status).toBe(200);
  });
});
