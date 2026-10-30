import { EventDetail, EventsResponse, HealthResponse, type EventsQuery } from '@bln/shared';
import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, schema: ZodType<T>): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return schema.parse(body);
}

export const api = {
  health: () => getJson('/api/health', HealthResponse),
  events: (q: EventsQuery) => {
    const params = new URLSearchParams(
      Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
    );
    return getJson(`/api/events?${params}`, EventsResponse);
  },
  event: (slug: string) => getJson(`/api/events/${encodeURIComponent(slug)}`, EventDetail),
};
