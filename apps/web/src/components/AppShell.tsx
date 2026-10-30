import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { CalendarDays, Camera, Inbox, List, User } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Tower } from './Tower';
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

function NavLink({ to, label, Icon, active }: (typeof NAV)[number] & { active: boolean }) {
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
      <Icon className="size-[22px]" strokeWidth={1.75} aria-hidden />
      {label}
    </Link>
  );
}

export function AppShell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [scanOpen, setScanOpen] = useState(false);
  const pushed = path.startsWith('/e/');
  const isActive = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));

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
            <NavLink {...NAV[1]} active={isActive('/inbox')} />
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
            Adding events needs an account. Sign-in and photo reading are the next steps on the roadmap.
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
