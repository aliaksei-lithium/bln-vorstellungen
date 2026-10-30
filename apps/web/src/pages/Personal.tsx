import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TopBar } from '@/components/AppShell';
import { EmptyState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useTheme, type Theme } from '@/lib/theme';

const SIGN_IN_SOON = 'Sign-in with Google or GitHub is the next step on the roadmap.';

export function InboxPage() {
  return (
    <>
      <TopBar right="Inbox" />
      <EmptyState
        title="Your picks land here"
        action={
          <Button asChild>
            <Link to="/">Browse all events</Link>
          </Button>
        }
      >
        Once you sign in, events are ranked against your taste with a one-line reason, and you sort them into
        interested, maybe or skip. {SIGN_IN_SOON}
      </EmptyState>
    </>
  );
}

export function AgendaPage() {
  return (
    <>
      <TopBar right="Agenda" />
      <EmptyState title="Nothing planned yet">
        Events you mark as interested or maybe show up here by day, with a calendar you can subscribe to. {SIGN_IN_SOON}
      </EmptyState>
    </>
  );
}

export function MePage() {
  const { theme, setTheme } = useTheme();
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, retry: false });
  const box = 'border border-ink bg-surface';
  const head = 'flex h-9 items-center bg-ink px-3 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase';
  return (
    <>
      <TopBar right="Me" />
      <div className="grid gap-3">
        <section className={box}>
          <div className={head}>Account</div>
          <p className="p-3 text-sub">
            {SIGN_IN_SOON} Your taste description, categories and calendar settings live here.
          </p>
        </section>
        <section className={box}>
          <div className={head}>Appearance</div>
          <div className="flex p-3" role="group" aria-label="Theme">
            {(['system', 'light', 'dark'] as Theme[]).map((t) => (
              <Button
                key={t}
                aria-pressed={theme === t}
                className="-ml-px flex-1 capitalize"
                onClick={() => setTheme(t)}
              >
                {t}
              </Button>
            ))}
          </div>
        </section>
        <section className={box}>
          <div className={head}>Status</div>
          <p className="p-3 text-sm tabular-nums">
            {health.isPending
              ? 'Checking…'
              : health.data?.ok
                ? `All systems running. Database answered in ${health.data.dbLatencyMs} ms.`
                : 'The database is not answering right now.'}
          </p>
        </section>
      </div>
    </>
  );
}
