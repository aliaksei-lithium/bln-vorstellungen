import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { CalendarDays, Camera, Inbox, List, User } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Tower } from './Tower';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { Toaster } from '@/lib/toast';
import { cn } from '@/lib/utils';

function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return scrolled;
}

/** Sticky top bar: transparent at rest so the spire shows, solid once content scrolls under it. */
export function TopBar({ right, children }: { right?: ReactNode; children?: ReactNode }) {
  const scrolled = useScrolled();
  return (
    <div
      className={cn(
        'sticky top-[env(safe-area-inset-top,0px)] z-10 -mx-1 px-1 transition-colors duration-150',
        scrolled && 'bg-background',
      )}
    >
      <div className="flex h-14 items-center justify-between">
        <Link
          to="/"
          className="flex items-center gap-2 text-base font-extrabold tracking-[.06em] text-ink uppercase no-underline"
        >
          <i className="block size-3.5 bg-moss" />
          BLN Vorstellungen
        </Link>
        <div className="eyebrow tabular-nums">{right}</div>
      </div>
      {children}
    </div>
  );
}

const NAV = [
  { to: '/', label: 'Browse', Icon: List },
  { to: '/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/agenda', label: 'Agenda', Icon: CalendarDays },
  { to: '/me', label: 'Me', Icon: User },
] as const;

function NavLink({ to, label, Icon, active, badge }: (typeof NAV)[number] & { active: boolean; badge?: number }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex flex-1 flex-col items-center justify-center gap-[3px] text-[11px] font-bold tracking-[.03em] uppercase no-underline',
        active
          ? 'text-moss before:absolute before:inset-x-[22%] before:-top-px before:h-[3px] before:bg-moss'
          : 'text-sub',
      )}
    >
      <span className="relative">
        <Icon className="size-[22px]" strokeWidth={1.75} aria-hidden />
        {badge ? (
          <span className="absolute -top-1.5 left-4 min-w-[18px] bg-moss px-1 text-center text-[10.5px] leading-[18px] font-extrabold text-on-moss tabular-nums">
            {badge > 99 ? '99+' : badge}
            <span className="sr-only"> to sort</span>
          </span>
        ) : null}
      </span>
      {label}
    </Link>
  );
}

export function AppShell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [scanOpen, setScanOpen] = useState(false);
  const pushed = path.startsWith('/e/');
  const isActive = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  const { user } = useMe();
  const inbox = useQuery({ queryKey: ['inbox', 'all'], queryFn: () => api.inbox('all'), enabled: !!user });
  const toSort = inbox.data ? inbox.data.total - inbox.data.done : 0;

  return (
    <>
      <Tower />
      <div
        className={cn(
          'gutter relative z-[1] mx-auto max-w-[600px]',
          pushed
            ? 'pb-[calc(24px+env(safe-area-inset-bottom,0px))]'
            : 'pb-[calc(88px+env(safe-area-inset-bottom,0px))]',
        )}
      >
        <Outlet />
      </div>
      {!pushed && (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-20 border-t border-ink bg-surface-a pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-md"
        >
          <div className="mx-auto flex h-16 max-w-[600px] px-[env(safe-area-inset-left,0px)]">
            <NavLink {...NAV[0]} active={isActive('/')} />
            <NavLink {...NAV[1]} active={isActive('/inbox')} badge={toSort} />
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              aria-label="Scan or upload a photo"
              className="flex w-[78px] flex-col items-center justify-center gap-[3px] bg-moss text-[11px] font-extrabold tracking-[.03em] text-on-moss uppercase"
            >
              <Camera className="size-6" strokeWidth={2} aria-hidden />
              Scan
            </button>
            <NavLink {...NAV[2]} active={isActive('/agenda')} />
            <NavLink {...NAV[3]} active={isActive('/me')} />
          </div>
        </nav>
      )}
      <Toaster aboveNav={!pushed} />
      <Sheet open={scanOpen} onOpenChange={setScanOpen}>
        <SheetContent side="bottom" className="mx-auto max-w-[600px] border-x border-ink">
          <SheetHeader>
            <SheetTitle>Add an event</SheetTitle>
            <SheetDescription className="text-[15px] leading-5">
              Photograph a poster, upload a screenshot or paste text, and AI reads the date, venue and price. You review
              everything before it is added.
            </SheetDescription>
          </SheetHeader>
          <div className="mx-4 mb-6 border border-moss bg-moss-soft p-3 text-sm">
            Reading photos is the next step on the roadmap. Until then, events come from the venues' own programmes.
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
