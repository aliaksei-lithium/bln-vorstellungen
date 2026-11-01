import { CATEGORY_LABELS, Category, OPT_IN_CATEGORIES, TASTE_MAX, type Prefs, type UsageDay } from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LogOut, Plus, Smartphone } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { TopBar } from '@/components/AppShell';
import { CategoryDot } from '@/components/CategoryChip';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { CopyField } from './Agenda';

const head = 'flex h-9 items-center bg-ink px-3 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase';

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-ink bg-surface">
      <div className={head}>{title}</div>
      {children}
    </section>
  );
}

const EXAMPLES: Record<string, string> = {
  'Classic plays': 'Classic plays in German.',
  'Chamber music': 'Chamber music in small halls.',
  'Contemporary dance': 'Contemporary dance.',
  'Jazz clubs': 'Jazz in small clubs.',
  'Free exhibitions': 'Free exhibitions.',
  'No techno': 'Not interested in techno parties.',
};

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
            <TasteForm />
            <PasswordBox />
            <OtherDevice />
          </>
        ) : (
          <SignIn />
        )}
        {user?.isOwner && <AiUsage />}
        <Appearance />
        <Status />
        {user && <SignOut />}
      </div>
    </>
  );
}

function TasteForm() {
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['profile'], queryFn: api.profile });
  const [taste, setTaste] = useState('');
  const [prefs, setPrefs] = useState<Prefs>({ categoriesOff: [], maxPrice: null, categoriesOn: [] });
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
  const flip = (list: Category[], c: Category) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]);
  // Opt-in categories are off until switched on; every other one is on until switched off.
  const isOn = (c: Category) =>
    OPT_IN_CATEGORIES.includes(c) ? prefs.categoriesOn.includes(c) : !prefs.categoriesOff.includes(c);
  const toggleCat = (c: Category) =>
    edit(() =>
      setPrefs((p) =>
        OPT_IN_CATEGORIES.includes(c)
          ? { ...p, categoriesOn: flip(p.categoriesOn, c) }
          : { ...p, categoriesOff: flip(p.categoriesOff, c) },
      ),
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
          <div className="text-xs font-extrabold tracking-[.1em] text-sub uppercase">Add an example</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(EXAMPLES).map(([label, text]) => (
              <Button
                key={label}
                size="sm"
                onClick={() => edit(() => setTaste((t) => `${t.trim()} ${text}`.trim().slice(0, TASTE_MAX)))}
              >
                <Plus aria-hidden />
                {label}
              </Button>
            ))}
          </div>
          <p className="m-0 text-xs text-sub">
            Plain words work best; the AI reads this as written. Saving re-ranks every upcoming event, which takes a
            minute.
          </p>
        </div>
      </Box>

      <Box title="Categories">
        {[...Category.options.filter((c) => !OPT_IN_CATEGORIES.includes(c)), ...OPT_IN_CATEGORIES].map((c) => {
          const on = isOn(c);
          return (
            <div
              key={c}
              className="flex min-h-12 items-center justify-between border-b border-line px-3 last:border-b-0"
            >
              <span className="flex items-center gap-2.5">
                <CategoryDot category={c} className="size-2.5" />
                <span>
                  {CATEGORY_LABELS[c]}
                  {OPT_IN_CATEGORIES.includes(c) && (
                    <span className="block text-xs text-sub">Hidden unless you turn it on. 18+.</span>
                  )}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={CATEGORY_LABELS[c]}
                onClick={() => toggleCat(c)}
                className={cn(
                  'h-8 w-16 border border-ink text-xs font-extrabold tracking-[.08em] uppercase',
                  on ? 'bg-moss text-on-moss' : 'bg-surface text-sub',
                )}
              >
                {on ? 'On' : 'Off'}
              </button>
            </div>
          );
        })}
      </Box>

      <Box title="Price">
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
    <Box title="Password">
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
    <Box title="Other devices">
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
      <Box title="AI usage">
        <p className="m-0 p-3 text-sub">{q.isError ? 'Could not load usage.' : 'Loading…'}</p>
      </Box>
    );
  }
  const { days, claudeDailyUsd: cap, neuronBudget, models } = q.data;
  const today = days.at(-1)!;
  const rows: [string, UsageDay[]][] = [
    ['Today', [today]],
    ['7 days', days.slice(-7)],
    ['30 days', days],
  ];
  const th = 'px-2 py-1.5 text-right text-[11px] font-extrabold tracking-[.08em] text-sub uppercase first:text-left';
  const td = 'px-2 py-1.5 text-right whitespace-nowrap tabular-nums first:text-left first:font-bold';
  return (
    <Box title="AI usage">
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
