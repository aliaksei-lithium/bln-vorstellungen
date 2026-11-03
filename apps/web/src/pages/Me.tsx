import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  Category,
  OPT_IN_CATEGORIES,
  TASTE_MAX,
  berlinToday,
  type Prefs,
  type Profile,
  type SpotifyStatus,
  type YoutubeStatus,
  type UsageDay,
} from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, ExternalLink, History, Loader2, LogOut, RefreshCw, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TopBar } from '@/components/AppShell';
import { CategoryDot } from '@/components/CategoryChip';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { CopyField } from './Agenda';
import { InviteRequest } from '@/components/InviteRequest';
import { useVisitorOptIn, useVisitorSources } from '@/lib/visitorSources';

const head = 'flex h-9 items-center bg-ink px-3 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase';

/**
 * A section of the Me page. `collapsed` ones start closed, with a one-line `summary` in the header, so the page
 * opens on what is used most (taste, categories).
 */
function Box({
  title,
  children,
  collapsed,
  summary,
}: {
  title: string;
  children: ReactNode;
  collapsed?: boolean;
  summary?: ReactNode;
}) {
  if (collapsed === undefined) {
    return (
      <section className="border border-ink bg-surface">
        <div className={head}>{title}</div>
        {children}
      </section>
    );
  }
  return (
    <details className="group border border-ink bg-surface" open={!collapsed}>
      <summary
        className={cn(head, 'cursor-pointer list-none justify-between gap-3 [&::-webkit-details-marker]:hidden')}
      >
        <span className="flex items-center gap-1.5">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
          {title}
        </span>
        {summary && (
          <span className="truncate text-[11px] font-bold tracking-[.04em] text-on-ink/75 normal-case">{summary}</span>
        )}
      </summary>
      {children}
    </details>
  );
}

export function MePage() {
  const { user, isPending } = useMe();
  return (
    <>
      <TopBar right="Me" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {isPending ? null : user ? (
          <>
            <div className="flex items-center gap-3.5 border border-ink bg-surface p-3.5">
              <div className="flex size-12 shrink-0 items-center justify-center bg-moss text-xl font-extrabold text-on-moss">
                {user.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[19px] font-extrabold">{user.name}</div>
                <div className="truncate text-sm text-sub">
                  {user.email} · {user.isOwner ? 'Owner' : 'Signed in'}
                </div>
              </div>
            </div>
            <Link
              to="/scans"
              className="flex min-h-12 items-center gap-3 border border-ink bg-surface px-3.5 font-extrabold text-ink no-underline"
            >
              <History className="size-5" aria-hidden />
              <span className="flex-1">Your scans</span>
              <ChevronRight className="size-5 text-sub" aria-hidden />
            </Link>
            <TasteForm />
            <SpotifyBox />
            <YoutubeBox />
            <RebuildBox />
            <SourcesBox />
            <PasswordBox />
            <OtherDevice />
          </>
        ) : (
          <>
            <SignIn />
            <InviteRequest />
            <VisitorCategories />
            <SourcesBox visitor />
          </>
        )}
        {user?.isOwner && <InvitesBox />}
        {user?.isOwner && <AiUsage />}
        <Appearance />
        <p className="m-0 text-center text-xs text-sub">
          {/* Static pages (public/*.html), readable without JavaScript for Google's consent-screen review. */}
          <a href="/privacy" className="text-sub underline underline-offset-2">
            Privacy
          </a>{' '}
          ·{' '}
          <a href="/terms" className="text-sub underline underline-offset-2">
            Terms
          </a>
        </p>
        <Status />
        {user && <SignOut />}
      </div>
    </>
  );
}

type Level = 'often' | 'less' | 'rarely' | 'off';
const LEVELS: Level[] = ['often', 'less', 'rarely', 'off'];

function TasteForm() {
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile });
  const [taste, setTaste] = useState('');
  const [prefs, setPrefs] = useState<Prefs>({
    categoriesOff: [],
    maxPrice: null,
    categoriesOn: [],
    frequency: {},
    sourcesOff: [],
    browseDefault: '',
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (profile.data && !dirty) {
      setTaste(profile.data.tasteText);
      setPrefs(profile.data.prefs);
    }
  }, [profile.data, dirty]);

  const save = useMutation({
    mutationFn: () => api.saveProfile({ tasteText: taste, prefs }),
    onSuccess: (p) => {
      qc.setQueryData(['profile'], p);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  const edit = (fn: () => void) => {
    fn();
    setDirty(true);
  };
  // Off is categoriesOff (categoriesOn for opt-in ones); less and rarely live in frequency; often is neither.
  const levelOf = (c: Category): Level => {
    const off = OPT_IN_CATEGORIES.includes(c) ? !prefs.categoriesOn.includes(c) : prefs.categoriesOff.includes(c);
    return off ? 'off' : (prefs.frequency[c] ?? 'often');
  };
  const setLevel = (c: Category, level: Level) =>
    edit(() =>
      setPrefs((p) => {
        const without = <T,>(list: T[]) => list.filter((x) => x !== c);
        const frequency = { ...p.frequency };
        delete frequency[c];
        if (level === 'less' || level === 'rarely') frequency[c] = level;
        return {
          ...p,
          frequency,
          categoriesOff:
            !OPT_IN_CATEGORIES.includes(c) && level === 'off'
              ? [...without(p.categoriesOff), c]
              : without(p.categoriesOff),
          categoriesOn:
            OPT_IN_CATEGORIES.includes(c) && level !== 'off'
              ? [...without(p.categoriesOn), c]
              : without(p.categoriesOn),
        };
      }),
    );

  return (
    <>
      <Box title="Your taste">
        <div className="grid gap-2.5 p-3">
          <label>
            <span className="sr-only">Describe what you like</span>
            <textarea
              value={taste}
              maxLength={TASTE_MAX}
              rows={5}
              placeholder="For example: contemporary dance and small theatre, chamber music, jazz in small clubs. Not into big pop concerts or techno."
              onChange={(e) => edit(() => setTaste(e.target.value))}
              className="w-full resize-y border border-ink bg-surface p-3 text-[15px] leading-[21px] outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-moss"
            />
          </label>
          <div className="-mt-1 text-right text-xs text-sub tabular-nums">
            {taste.length} / {TASTE_MAX}
          </div>
          <p className="m-0 text-xs text-sub">
            Plain words work best; the AI reads this as written. Saving re-ranks every upcoming event, which takes a
            minute.
          </p>
        </div>
      </Box>

      <Box title="Categories">
        <p className="m-0 border-b border-line px-3 py-2.5 text-sm text-sub">
          <b className="text-ink">Less</b> and <b className="text-ink">Rarely</b> keep a category in your picks only for
          strong matches, and Inbox never lets one category take more than a third of the places.{' '}
          <b className="text-ink">Off</b> also leaves it out of Browse, unless you pick it in the filter.
        </p>
        {[...Category.options.filter((c) => !OPT_IN_CATEGORIES.includes(c)), ...OPT_IN_CATEGORIES].map((c) => {
          const level = levelOf(c);
          return (
            <div key={c} className="grid gap-2 border-b border-line px-3 py-2.5 last:border-b-0">
              <span className="flex items-center gap-2.5">
                <CategoryDot category={c} className="size-2.5" />
                <span>{CATEGORY_LABELS[c]}</span>
                {CATEGORY_HINTS[c] && <span className="text-xs text-sub">{CATEGORY_HINTS[c]}</span>}
              </span>
              <div className="grid grid-cols-4" role="radiogroup" aria-label={`${CATEGORY_LABELS[c]}: how often`}>
                {LEVELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={level === l}
                    onClick={() => setLevel(c, l)}
                    className={cn(
                      '-ml-px h-8 border border-ink text-[11px] font-extrabold tracking-[.06em] uppercase first:ml-0',
                      level === l
                        ? l === 'off'
                          ? 'bg-ink text-on-ink'
                          : 'bg-moss text-on-moss'
                        : 'bg-surface text-sub',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </Box>

      <Box title="Price" collapsed summary={prefs.maxPrice == null ? 'Any price' : `Up to ${prefs.maxPrice} €`}>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <label className="flex items-center gap-2">
            <span>At most</span>
            <input
              type="number"
              min={0}
              max={1000}
              inputMode="numeric"
              value={prefs.maxPrice ?? ''}
              placeholder="any"
              onChange={(e) =>
                edit(() =>
                  setPrefs((p) => ({
                    ...p,
                    maxPrice: e.target.value === '' ? null : Math.max(0, Number(e.target.value)),
                  })),
                )
              }
              className="h-10 w-24 border border-ink bg-surface px-2 tabular-nums"
            />
            <span>€</span>
          </label>
          {prefs.maxPrice !== null && (
            <Button size="sm" variant="ghost" onClick={() => edit(() => setPrefs((p) => ({ ...p, maxPrice: null })))}>
              No limit
            </Button>
          )}
          <p className="m-0 w-full text-xs text-sub">
            Leave it empty for no limit. Price then plays no part in the ranking; free events are not preferred.
          </p>
        </div>
      </Box>

      <div
        className={cn(
          'flex items-center gap-3',
          // Only pinned above the tab bar while there is something to save.
          dirty && 'sticky bottom-[calc(76px+env(safe-area-inset-bottom,0px))] z-[2]',
        )}
      >
        <Button
          size="lg"
          variant="default"
          className="flex-1"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save and re-rank' : 'Saved'}
        </Button>
      </div>
      {save.isError && <p className="m-0 text-sm text-danger">{save.error.message}</p>}
    </>
  );
}

const fieldLabel = 'grid gap-1 text-xs font-extrabold tracking-[.08em] text-sub uppercase';
const fieldInput =
  'h-11 w-full border border-ink bg-surface px-3 text-[15px] font-semibold tracking-normal text-ink normal-case outline-none focus-visible:outline-2 focus-visible:outline-moss';

const SPOTIFY_RESULT: Record<string, string> = {
  connected: 'Spotify connected. Your picks are being re-ranked with your artists.',
  denied: 'Spotify was not connected: the permission was declined.',
  'not-allowed': 'Spotify refused: this account is not on the app’s list yet. Ask the owner to add your Spotify email.',
  failed: 'Spotify could not be connected. Try again in a minute.',
};

/** Connect Spotify: top and followed artists boost concerts by them and back the "My Spotify artists" filter. */
function SpotifyBox() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['spotify'], queryFn: api.spotify });
  const done = (s: SpotifyStatus) => {
    qc.setQueryData(['spotify'], s);
    void qc.invalidateQueries({ queryKey: ['inbox'] });
  };
  const sync = useMutation({ mutationFn: api.spotifySync, onSuccess: (s) => (done(s), toast('Artists updated')) });
  const drop = useMutation({
    mutationFn: api.spotifyDisconnect,
    onSuccess: (s) => (done(s), toast('Spotify disconnected')),
  });
  // The callback lands here with ?spotify=connected|denied|not-allowed|failed.
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('spotify');
    if (!result) return;
    toast(SPOTIFY_RESULT[result] ?? SPOTIFY_RESULT.failed!);
    window.history.replaceState(null, '', window.location.pathname);
    void qc.invalidateQueries({ queryKey: ['spotify'] });
  }, [qc]);
  const s = status.data;
  return (
    <Box
      title="Spotify"
      collapsed
      summary={s ? (s.connected ? `Connected · ${s.artists.length} artists` : 'Not connected') : undefined}
    >
      <div id="spotify" className="grid gap-3 p-3">
        {!s ? (
          <p className="m-0 text-sm text-sub">Loading…</p>
        ) : !s.connected ? (
          <>
            <p className="m-0 text-sm text-sub">
              Connect your Spotify account: concerts by artists you listen to and follow go to the top of your picks,
              their genres join your taste in the ranking, and Browse can show just those artists.
            </p>
            <Button asChild variant="default" className="justify-self-start">
              <a href="/spotify/connect">Connect Spotify</a>
            </Button>
          </>
        ) : (
          <>
            <p className="m-0 text-sm">
              <b>{s.artists.length}</b> artists from your Spotify
              {s.syncedAt && <span className="text-sub"> · updated {s.syncedAt.slice(0, 10)}</span>}
            </p>
            {s.artists.length > 0 && (
              <p className="m-0 text-sm text-sub">
                {s.artists.slice(0, 12).join(', ')}
                {s.artists.length > 12 && ` and ${s.artists.length - 12} more`}
              </p>
            )}
            {s.genres.length > 0 && (
              <p className="m-0 text-sm">
                <span className="text-xs font-extrabold tracking-[.08em] text-sub uppercase">Added to your taste</span>
                <br />
                {s.genres.join(' · ')}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
                Update artists
              </Button>
              <Button size="sm" variant="ghost" disabled={drop.isPending} onClick={() => drop.mutate()}>
                Disconnect
              </Button>
            </div>
          </>
        )}
        {(sync.isError || drop.isError) && (
          <p role="alert" className="m-0 text-sm font-semibold text-danger">
            {(sync.error ?? drop.error)?.message}
          </p>
        )}
      </div>
    </Box>
  );
}

const YOUTUBE_RESULT: Record<string, string> = {
  connected: 'YouTube Music connected. Your picks are being re-ranked with your artists.',
  denied: 'YouTube Music was not connected: the permission was declined.',
  failed: 'YouTube Music could not be connected. Try again in a minute.',
};

/** Connect YouTube Music: artists from liked songs and subscribed music channels, used like Spotify's. */
function YoutubeBox() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['youtube'], queryFn: api.youtube });
  const done = (s: YoutubeStatus) => {
    qc.setQueryData(['youtube'], s);
    void qc.invalidateQueries({ queryKey: ['inbox'] });
  };
  const sync = useMutation({ mutationFn: api.youtubeSync, onSuccess: (s) => (done(s), toast('Artists updated')) });
  const drop = useMutation({
    mutationFn: api.youtubeDisconnect,
    onSuccess: (s) => (done(s), toast('YouTube Music disconnected')),
  });
  // The callback lands here with ?youtube=connected|denied|failed.
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('youtube');
    if (!result) return;
    toast(YOUTUBE_RESULT[result] ?? YOUTUBE_RESULT.failed!);
    window.history.replaceState(null, '', window.location.pathname);
    void qc.invalidateQueries({ queryKey: ['youtube'] });
  }, [qc]);
  const s = status.data;
  return (
    <Box
      title="YouTube Music"
      collapsed
      summary={s ? (s.connected ? `Connected · ${s.artists.length} artists` : 'Not connected') : undefined}
    >
      <div id="youtube" className="grid gap-3 p-3">
        {!s ? (
          <p className="m-0 text-sm text-sub">Loading…</p>
        ) : !s.connected ? (
          <>
            <p className="m-0 text-sm text-sub">
              Connect your Google account: the artists of songs you liked on YouTube Music and the music channels you
              subscribe to count like Spotify artists. Read-only; nothing is posted or changed.
            </p>
            {s.available ? (
              <Button asChild variant="default" className="justify-self-start">
                <a href="/youtube/connect">Connect YouTube Music</a>
              </Button>
            ) : (
              <p className="m-0 text-sm font-semibold">Not set up on this site yet.</p>
            )}
          </>
        ) : (
          <>
            <p className="m-0 text-sm">
              <b>{s.artists.length}</b> artists from YouTube Music
              {s.syncedAt && <span className="text-sub"> · updated {s.syncedAt.slice(0, 10)}</span>}
            </p>
            {s.artists.length > 0 && (
              <p className="m-0 text-sm text-sub">
                {s.artists.slice(0, 12).join(', ')}
                {s.artists.length > 12 && ` and ${s.artists.length - 12} more`}
              </p>
            )}
            {s.artists.length === 0 && (
              <p className="m-0 text-sm text-sub">
                No artists yet: like a few songs on YouTube Music (or subscribe to artists), then update.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
                Update artists
              </Button>
              <Button size="sm" variant="ghost" disabled={drop.isPending} onClick={() => drop.mutate()}>
                Disconnect
              </Button>
            </div>
          </>
        )}
        {(sync.isError || drop.isError) && (
          <p role="alert" className="m-0 text-sm font-semibold text-danger">
            {(sync.error ?? drop.error)?.message}
          </p>
        )}
      </div>
    </Box>
  );
}

/**
 * Rebuild Discover and For you now, with the latest taste and artists: the day's first one when there is none yet,
 * then a few a day. Connecting a music service starts one by itself, once the new scores are in.
 */
function RebuildBox() {
  const qc = useQueryClient();
  const review = useQuery({
    queryKey: ['review'],
    queryFn: api.review,
    refetchInterval: (q) => (q.state.data?.status === 'preparing' ? 4000 : false),
  });
  const rebuild = useMutation({
    mutationFn: api.prepareReview,
    onSuccess: (r) => {
      qc.setQueryData(['review'], r);
      if (r.status !== 'preparing') toast('Nothing to rebuild right now. Try again later.');
    },
  });
  // When a rebuild finishes, Discover shows the new edition on its next visit.
  const status = review.data?.status;
  const was = useRef(status);
  useEffect(() => {
    if (was.current === 'preparing' && status === 'ready') {
      void qc.invalidateQueries({ queryKey: ['discover'] });
      toast('Discover and For you are rebuilt');
    }
    was.current = status;
  }, [status, qc]);
  const r = review.data;
  const today = !!r?.day && r.day === berlinToday();
  const preparing = r?.status === 'preparing';
  const left = r?.rebuildsLeft ?? 0;
  const can = !!r && !preparing && (!today || left > 0);
  return (
    <Box
      title="Discover and For you"
      collapsed
      summary={r ? (preparing ? 'Rebuilding…' : today ? `${left} rebuilds left today` : 'Not built today') : undefined}
    >
      <div id="rebuild" className="grid gap-3 p-3">
        <p className="m-0 text-sm text-sub">
          Both pages are written each morning. Rebuild them now to use your latest taste and artists. Connecting Spotify
          or YouTube Music rebuilds them by itself once your events are re-ranked.
        </p>
        {!r ? (
          <p className="m-0 text-sm text-sub">Loading…</p>
        ) : preparing ? (
          <p className="m-0 inline-flex items-center gap-2 text-sm font-semibold">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Rebuilding. This takes a minute or two.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={!can || rebuild.isPending} onClick={() => rebuild.mutate()}>
              {rebuild.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              Rebuild now
            </Button>
            <span className="text-sm text-sub">
              {!today
                ? 'Today’s edition is not built yet.'
                : left > 0
                  ? `${left} left today`
                  : 'No rebuilds left today'}
            </span>
          </div>
        )}
        {rebuild.isError && (
          <p role="alert" className="m-0 text-sm font-semibold text-danger">
            {rebuild.error.message}
          </p>
        )}
      </div>
    </Box>
  );
}

/** Signed out: email and password, for people who set one; everyone else starts from a login link. */
function SignIn() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const signIn = useMutation({
    mutationFn: () => api.passwordLogin(email, password),
    onSuccess: (r) => {
      qc.setQueryData(['me'], r);
      void qc.invalidateQueries();
    },
  });
  return (
    <Box title="Sign in">
      <form
        className="grid gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          signIn.mutate();
        }}
      >
        <p className="m-0 text-sm text-sub">
          Everything on this site is open to everyone. Personal picks, an agenda and a calendar feed are for invited
          people.
        </p>
        <label className={fieldLabel}>
          Email
          <input
            className={fieldInput}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className={fieldLabel}>
          Password
          <input
            className={fieldInput}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {signIn.isError && (
          <p role="alert" className="m-0 text-sm font-semibold text-danger">
            {signIn.error.message}
          </p>
        )}
        <Button type="submit" variant="default" disabled={signIn.isPending}>
          Sign in
        </Button>
        <p className="m-0 text-xs text-sub">
          No password yet? Open the login link the owner sent you, then set one on this page.
        </p>
      </form>
    </Box>
  );
}

/** Signed in: set a password once, or change it with the current one. */
function PasswordBox() {
  const qc = useQueryClient();
  const { user } = useMe();
  const status = useQuery({ queryKey: ['password'], queryFn: api.passwordStatus });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const save = useMutation({
    mutationFn: () => api.setPassword({ password: next, ...(status.data?.set ? { current } : {}) }),
    onSuccess: (s) => {
      qc.setQueryData(['password'], s);
      setCurrent('');
      setNext('');
      toast('Password saved');
    },
  });
  const isSet = !!status.data?.set;
  return (
    <Box title="Password" collapsed summary={status.data ? (isSet ? 'Set' : 'Not set') : undefined}>
      <form
        className="grid gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="m-0 text-sm text-sub">
          {isSet
            ? 'You can sign in with your email and password on any device.'
            : 'Set a password to sign in on other devices with your email, without a new login link each time.'}
        </p>
        {/* Lets password managers file the password under the right account. */}
        <input type="hidden" autoComplete="username" value={user?.email ?? ''} readOnly />
        {isSet && (
          <label className={fieldLabel}>
            Current password
            <input
              className={fieldInput}
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
        )}
        <label className={fieldLabel}>
          {isSet ? 'New password' : 'Password'}
          <input
            className={fieldInput}
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <p className="-mt-1.5 m-0 text-xs text-sub">At least 10 characters. A few words in a row work well.</p>
        {save.isError && (
          <p role="alert" className="m-0 text-sm font-semibold text-danger">
            {save.error.message}
          </p>
        )}
        <Button type="submit" className="justify-self-start" disabled={save.isPending || !status.data}>
          {isSet ? 'Change password' : 'Set password'}
        </Button>
      </form>
    </Box>
  );
}

function OtherDevice() {
  const link = useMutation({ mutationFn: api.loginLink });
  return (
    <Box title="Other devices" collapsed summary="Login links">
      <div className="grid gap-2.5 p-3">
        <p className="m-0 text-sm text-sub">
          Open a one-time link on your phone or another computer to sign in there. It works once and expires after 7
          days.
        </p>
        {!link.data && (
          <Button className="justify-self-start" disabled={link.isPending} onClick={() => link.mutate()}>
            <Smartphone aria-hidden />
            Create login link
          </Button>
        )}
      </div>
      {link.data && <CopyField value={link.data.url} />}
    </Box>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1
    ? 'just now'
    : min < 60
      ? `${min} min ago`
      : min < 48 * 60
        ? `${Math.round(min / 60)} h ago`
        : `${Math.round(min / 1440)} days ago`;
};
const every = (min: number) =>
  min % 1440 === 0 ? `daily` : min % 60 === 0 ? `every ${min / 60} h` : `every ${min} min`;
const SOURCE_KIND: Record<string, string> = {
  ical: 'Calendar feed',
  rss: 'News feed',
  jsonld: 'Website (structured)',
  html: 'Website, read by AI',
  telegram: 'Telegram channel',
};

/**
 * Where events come from and when each source is checked. Switching one off takes its events out of this user's
 * Browse, inbox and picks (unless another source lists them too); the agenda and event pages keep them. Visitors get
 * the same switches, kept in their browser, with a few venues off to start with.
 */
function SourcesBox({ visitor = false }: { visitor?: boolean }) {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['sources'], queryFn: api.sources, staleTime: 60_000, enabled: !visitor });
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile, enabled: !visitor });
  const local = useVisitorSources(visitor);
  const q = visitor ? local.sources : mine;
  const off = visitor ? local.off : (profile.data?.prefs.sourcesOff ?? []);
  const save = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.setSource(id, on),
    onSuccess: ({ sourcesOff }) => {
      qc.setQueryData<Profile>(['profile'], (p) => (p ? { ...p, prefs: { ...p.prefs, sourcesOff } } : p));
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  const flip = visitor
    ? { isPending: false, mutate: ({ id, on }: { id: string; on: boolean }) => local.set(id, on) }
    : save;
  const sources = q.data?.sources ?? [];
  const yours = sources.filter((s) => s.enabled && !off.includes(s.id)).length;
  return (
    <Box
      title="Sources"
      collapsed
      summary={q.data ? `${yours} on${off.length ? ` · ${off.length} off for you` : ''}` : undefined}
    >
      {!q.data ? (
        <p className="m-0 p-3 text-sm text-sub">{q.isError ? 'Could not load sources.' : 'Loading…'}</p>
      ) : (
        <>
          <p className="m-0 border-b border-line px-3 py-2.5 text-sm text-sub">
            {visitor
              ? 'Switch a source off to leave its events out of Browse. Saved in this browser; a few venues start off.'
              : 'Switch a source off to leave its events out of your Browse and Inbox. Your Agenda keeps what you planned.'}
          </p>
          <ul className="m-0 list-none p-0">
            {sources.map((s) => {
              const on = !off.includes(s.id);
              return (
                <li
                  key={s.id}
                  className={cn(
                    'flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0',
                    (!s.enabled || !on) && 'opacity-60',
                  )}
                >
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    {s.link ? (
                      <a
                        href={s.link}
                        target="_blank"
                        rel="noreferrer"
                        className="font-bold text-ink underline-offset-4 [overflow-wrap:anywhere] hover:underline"
                      >
                        {s.name}
                        <ExternalLink
                          className="ml-1 inline size-3.5 align-[-1px] text-sub"
                          aria-label="(opens the site)"
                        />
                      </a>
                    ) : (
                      <span className="font-bold [overflow-wrap:anywhere]">{s.name}</span>
                    )}
                    <span className="text-xs text-sub">
                      <b className="text-ink tabular-nums">{s.upcoming}</b> upcoming · {SOURCE_KIND[s.type] ?? s.type} ·{' '}
                      {s.enabled ? every(s.everyMinutes) : 'paused'} · checked {ago(s.lastRunAt)}
                      {s.lastStatus === 'error' && <span className="font-bold text-danger"> · last run failed</span>}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={s.name}
                    disabled={flip.isPending}
                    onClick={() => flip.mutate({ id: s.id, on: !on })}
                    className={cn(
                      'h-8 w-14 shrink-0 border border-ink text-xs font-extrabold tracking-[.08em] uppercase',
                      on ? 'bg-moss text-on-moss' : 'bg-surface text-sub',
                    )}
                  >
                    {on ? 'On' : 'Off'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Box>
  );
}

/** Opt-in categories for visitors, kept in this browser; off until switched on (docs/09, 2026-11-02). */
function VisitorCategories() {
  const optIn = useVisitorOptIn();
  return (
    <Box title="Categories" collapsed summary={optIn.on.length ? `${optIn.on.length} opt-in on` : undefined}>
      <ul className="m-0 list-none p-0">
        {OPT_IN_CATEGORIES.map((c) => {
          const on = optIn.on.includes(c);
          return (
            <li key={c} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex items-center gap-2 font-bold">
                  <CategoryDot category={c} />
                  {CATEGORY_LABELS[c]}
                </span>
                <span className="text-xs text-sub">
                  {CATEGORY_HINTS[c]} Off by default. Switched on, it shows up as a filter in Browse.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={CATEGORY_LABELS[c]}
                onClick={() => optIn.set(c, !on)}
                className={cn(
                  'h-8 w-14 shrink-0 border border-ink text-xs font-extrabold tracking-[.08em] uppercase',
                  on ? 'bg-moss text-on-moss' : 'bg-surface text-sub',
                )}
              >
                {on ? 'On' : 'Off'}
              </button>
            </li>
          );
        })}
      </ul>
    </Box>
  );
}

/**
 * Owner only: who asked for an invite. Inviting creates the account (their note becomes a first taste) and a
 * one-time login link to send them; nothing is emailed from the site.
 */
function InvitesBox() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invite-requests'], queryFn: api.inviteRequests });
  const [links, setLinks] = useState<Record<string, string>>({});
  const accept = useMutation({
    mutationFn: api.acceptInvite,
    onSuccess: (r) => setLinks((l) => ({ ...l, [r.request.id]: r.loginLink.url })),
  });
  const decline = useMutation({
    mutationFn: api.declineInvite,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invite-requests'] }),
  });
  const pending = q.data?.requests ?? [];
  return (
    <Box
      title="Invite requests"
      collapsed={pending.length === 0}
      summary={`${pending.filter((r) => !links[r.id]).length} waiting`}
    >
      {pending.length === 0 ? (
        <p className="m-0 p-3 text-sm text-sub">{q.isPending ? 'Loading…' : 'No requests waiting.'}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {pending.map((r) => (
            <li key={r.id} className="grid gap-2 border-b border-line px-3 py-3 last:border-b-0">
              <div>
                <div className="font-bold [overflow-wrap:anywhere]">{r.name}</div>
                <div className="text-sm text-sub [overflow-wrap:anywhere]">
                  {r.email} · {new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </div>
                {r.note && <p className="mt-1 mb-0 text-sm [overflow-wrap:anywhere]">“{r.note}”</p>}
              </div>
              {links[r.id] ? (
                <div className="grid gap-1.5">
                  <span className="text-xs text-sub">Invited. Send them this one-time login link:</span>
                  <CopyField value={links[r.id]!} />
                  <a
                    className="text-sm font-extrabold text-moss"
                    href={`mailto:${r.email}?subject=${encodeURIComponent('Your invite to BLN Vorstellungen')}&body=${encodeURIComponent(`Hi ${r.name.split(' ')[0]},\n\nhere is your personal login link (one-time, valid for a week):\n${links[r.id]}\n`)}`}
                  >
                    Write the email
                  </a>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" variant="default" disabled={accept.isPending} onClick={() => accept.mutate(r.id)}>
                    Invite
                  </Button>
                  <Button size="sm" disabled={decline.isPending} onClick={() => decline.mutate(r.id)}>
                    Decline
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();
  return (
    <Box title="Appearance">
      <div className="flex p-3" role="group" aria-label="Theme">
        {(['system', 'light', 'dark'] as Theme[]).map((t) => (
          <Button key={t} aria-pressed={theme === t} className="-ml-px flex-1 capitalize" onClick={() => setTheme(t)}>
            {t}
          </Button>
        ))}
      </div>
    </Box>
  );
}

function Status() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, retry: false });
  return (
    <Box title="Status">
      <p className="p-3 text-sm tabular-nums">
        {health.isPending
          ? 'Checking…'
          : health.data?.ok
            ? `All systems running. Database answered in ${health.data.dbLatencyMs} ms.`
            : 'The database is not answering right now.'}
      </p>
    </Box>
  );
}

function SignOut() {
  const qc = useQueryClient();
  const out = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.setQueryData(['me'], { user: null });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
  return (
    <div className="flex flex-col gap-2">
      <Button size="lg" disabled={out.isPending} onClick={() => out.mutate()}>
        <LogOut aria-hidden />
        Sign out
      </Button>
      <Link to="/" className="text-center text-sm text-sub">
        Back to all events
      </Link>
    </div>
  );
}

const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const sum = (days: UsageDay[], k: keyof Omit<UsageDay, 'day'>) => days.reduce((a, d) => a + d[k], 0);

function Meter({
  label,
  value,
  of,
  children,
}: {
  label: string;
  value: number;
  of: number | null;
  children: ReactNode;
}) {
  const pct = of ? Math.min(100, (value / of) * 100) : 0;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-bold">{label}</span>
        <span className="text-sm text-sub tabular-nums">{children}</span>
      </div>
      {of !== null && (
        <div className="h-2 bg-chip" role="meter" aria-label={label} aria-valuenow={value} aria-valuemax={of}>
          <div className={cn('h-full', pct >= 90 ? 'bg-danger' : 'bg-moss')} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Owner only: what the AI cost today and recently, against the daily caps. Whole site, UTC days. */
function AiUsage() {
  const q = useQuery({ queryKey: ['usage'], queryFn: () => api.usage(30), staleTime: 60_000 });
  if (!q.data) {
    return (
      <Box title="AI usage" collapsed>
        <p className="m-0 p-3 text-sub">{q.isError ? 'Could not load usage.' : 'Loading…'}</p>
      </Box>
    );
  }
  const { days, claudeDailyUsd: cap, neuronBudget, models } = q.data;
  const today = days.at(-1)!;
  const summary = `${usd(today.claudeUsd)} today`;
  const rows: [string, UsageDay[]][] = [
    ['Today', [today]],
    ['7 days', days.slice(-7)],
    ['30 days', days],
  ];
  const th = 'px-2 py-1.5 text-right text-[11px] font-extrabold tracking-[.08em] text-sub uppercase first:text-left';
  const td = 'px-2 py-1.5 text-right whitespace-nowrap tabular-nums first:text-left first:font-bold';
  return (
    <Box title="AI usage" collapsed summary={summary}>
      <div className="grid gap-4 p-3">
        <Meter label="Claude today" value={today.claudeUsd} of={cap}>
          {usd(today.claudeUsd)} {cap === null ? '· no cap' : `of ${usd(cap)}`}
        </Meter>
        <Meter label="Workers AI today" value={today.neurons} of={neuronBudget}>
          {today.neurons.toLocaleString('en')} of {neuronBudget.toLocaleString('en')} neurons
        </Meter>
      </div>
      <div className="overflow-x-auto border-t border-line">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className={th}>Claude</th>
              <th className={th}>Spent</th>
              <th className={th}>Tokens in</th>
              <th className={th}>Tokens out</th>
              <th className={th}>Calls</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, ds]) => (
              <tr key={label} className="border-b border-line last:border-b-0">
                <td className={td}>{label}</td>
                <td className={td}>{usd(sum(ds, 'claudeUsd'))}</td>
                <td className={td}>{compact.format(sum(ds, 'tokensIn'))}</td>
                <td className={td}>{compact.format(sum(ds, 'tokensOut'))}</td>
                <td className={td}>{sum(ds, 'claudeCalls')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 border-t border-line p-3 text-xs text-sub">
        Whole site, days in UTC. Reading pages and photos uses {models.extract}; ranking uses {models.score}. Tokens are
        counted from 1 Nov 2026, so earlier days show spend without tokens.
      </p>
    </Box>
  );
}
