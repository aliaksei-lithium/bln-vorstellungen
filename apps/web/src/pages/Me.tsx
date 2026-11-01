import { CATEGORY_LABELS, Category, OPT_IN_CATEGORIES, TASTE_MAX, type Prefs } from '@bln/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LogOut, Plus, Smartphone } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { TopBar } from '@/components/AppShell';
import { CategoryDot } from '@/components/CategoryChip';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
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
            <OtherDevice />
          </>
        ) : (
          <Box title="Account">
            <p className="p-3 text-sub">
              Everything on this site is open to everyone. Personal picks, an agenda and a calendar feed are for invited
              people: ask the owner for a login link.
            </p>
          </Box>
        )}
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
