import {
  AgendaResponse,
  MyStates,
  PasswordStatus,
  SpotifyStatus,
  SourcesOverview,
  UsageOverview,
  Scan,
  ScanCreated,
  InboxReview,
  DiscoverEdition,
  InviteAccepted,
  InviteRequests,
  type InviteRequestCreate,
  ScanInsight,
  ScanPlaylistResult,
  type ScanConfirm,
  CalendarLink,
  EventDetail,
  VenueDetail,
  EventsList,
  EventsResponse,
  HealthResponse,
  InboxResponse,
  LoginLink,
  MeResponse,
  MyEvent,
  Profile,
  type EventsQuery,
  type ProfileUpdate,
  type StateUpdate,
} from '@bln/shared';
import { z, type ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, schema: ZodType<T>, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    credentials: 'same-origin',
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return schema.parse(body);
}

const getJson = <T>(path: string, schema: ZodType<T>) => request(path, schema);
const enc = encodeURIComponent;

export const api = {
  health: () => getJson('/api/health', HealthResponse),
  events: (q: EventsQuery) => {
    // Lists (category, district, via) go as comma values: ?category=concert,theatre.
    const params = new URLSearchParams(
      Object.entries(q).flatMap(([k, v]): [string, string][] =>
        Array.isArray(v) ? (v.length ? [[k, v.join(',')]] : []) : typeof v === 'string' && v ? [[k, v]] : [],
      ),
    );
    return getJson(`/api/events?${params}`, EventsResponse);
  },
  event: (slug: string) => getJson(`/api/events/${enc(slug)}`, EventDetail),
  venue: (id: string) => getJson(`/api/venues/${enc(id)}`, VenueDetail),
  similar: (slug: string) => getJson(`/api/events/${enc(slug)}/similar`, EventsList),
  searchByMeaning: (q: string) => getJson(`/api/events/search?${new URLSearchParams({ q })}`, EventsList),

  me: () => getJson('/api/me', MeResponse),
  login: (token: string) => request('/api/auth/login', MeResponse, { method: 'POST', body: { token } }),
  logout: () => request('/api/auth/logout', MeResponse, { method: 'POST', body: {} }),
  passwordLogin: (email: string, password: string) =>
    request('/api/auth/password', MeResponse, { method: 'POST', body: { email, password } }),
  passwordStatus: () => getJson('/api/me/password', PasswordStatus),
  spotify: () => getJson('/api/me/spotify', SpotifyStatus),
  sources: () => getJson('/api/me/sources', SourcesOverview),
  publicSources: () => getJson('/api/sources', SourcesOverview),
  setBrowseDefault: (search: string) =>
    request('/api/me/browse-default', z.object({ search: z.string() }), { method: 'PUT', body: { search } }),
  setSource: (id: string, on: boolean) =>
    request(`/api/me/sources/${enc(id)}`, z.object({ sourcesOff: z.array(z.string()) }), {
      method: 'PUT',
      body: { on },
    }),
  spotifySync: () => request('/api/me/spotify/sync', SpotifyStatus, { method: 'POST', body: {} }),
  spotifyDisconnect: () => request('/api/me/spotify', SpotifyStatus, { method: 'DELETE' }),
  setPassword: (body: { password: string; current?: string }) =>
    request('/api/me/password', PasswordStatus, { method: 'PUT', body }),
  loginLink: () => request('/api/me/login-link', LoginLink, { method: 'POST', body: {} }),
  profile: () => getJson('/api/me/profile', Profile),
  saveProfile: (p: ProfileUpdate) => request('/api/me/profile', Profile, { method: 'PUT', body: p }),
  inbox: (range: 'week' | 'all') => getJson(`/api/me/inbox?range=${range}`, InboxResponse),
  myEvent: (slug: string) => getJson(`/api/me/events/${enc(slug)}`, MyEvent),
  setState: (slug: string, u: StateUpdate) =>
    request(`/api/me/events/${enc(slug)}/state`, z.unknown(), { method: 'PUT', body: u }),
  agenda: () => getJson('/api/me/agenda', AgendaResponse),
  states: () => getJson('/api/me/states', MyStates),
  usage: (days = 30) => getJson(`/api/admin/usage/days?days=${days}`, UsageOverview),
  scan: (id: string) => getJson(`/api/me/scans/${enc(id)}`, Scan),
  scanText: (text: string) => request('/api/me/scans', ScanCreated, { method: 'POST', body: { text } }),
  scanPhoto: async (photo: Blob, takenAt?: string) => {
    const form = new FormData();
    form.append('image', photo, 'photo.jpg');
    if (takenAt) form.append('takenAt', takenAt);
    const res = await fetch('/api/me/scans', { method: 'POST', body: form, credentials: 'same-origin' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? 'Upload failed');
    return ScanCreated.parse(body);
  },
  confirmScan: (id: string, body: ScanConfirm) =>
    request(`/api/me/scans/${enc(id)}/confirm`, Scan.shape.result.unwrap(), { method: 'POST', body }),
  scanMore: (id: string, index: number) =>
    request(`/api/me/scans/${enc(id)}/more/${index}`, ScanInsight, { method: 'POST', body: {} }),
  scanPlaylist: (id: string, indexes: number[]) =>
    request(`/api/me/scans/${enc(id)}/playlist`, ScanPlaylistResult, { method: 'POST', body: { indexes } }),
  review: () => getJson('/api/me/review', InboxReview),
  prepareReview: () => request('/api/me/review', InboxReview, { method: 'POST', body: {} }),
  highlights: () => getJson('/api/highlights', InboxReview),
  discover: () => getJson('/api/me/discover', DiscoverEdition),
  publicDiscover: () => getJson('/api/discover', DiscoverEdition),
  requestInvite: (body: InviteRequestCreate) =>
    request('/api/invite-requests', z.object({ ok: z.boolean() }), { method: 'POST', body }),
  inviteRequests: () => getJson('/api/admin/invites', InviteRequests),
  acceptInvite: (id: string) =>
    request(`/api/admin/invites/${enc(id)}/accept`, InviteAccepted, { method: 'POST', body: {} }),
  declineInvite: (id: string) =>
    request(`/api/admin/invites/${enc(id)}/decline`, InviteAccepted.shape.request, { method: 'POST', body: {} }),
  calendarLink: () => request('/api/me/calendar-link', CalendarLink, { method: 'POST', body: {} }),
};
