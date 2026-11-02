import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { CalendarDays, Camera, Compass, List, Telescope, User } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ScanSheet } from './ScanSheet';
import { Tower } from './Tower';
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
  { to: '/discover', label: 'Discover', Icon: Telescope },
  { to: '/for-you', label: 'For you', Icon: Compass },
  { to: '/agenda', label: 'Agenda', Icon: CalendarDays },
  { to: '/me', label: 'Me', Icon: User },
] as const;

function NavLink({ to, label, Icon, active, badge }: (typeof NAV)[number] & { active: boolean; badge?: number }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-[3px] text-[10.5px] font-bold tracking-[.02em] uppercase no-underline min-[420px]:text-[11px] min-[420px]:tracking-[.03em]',
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
  const pushed = path.startsWith('/e/') || path.startsWith('/scan/');
  // Discover reads like a magazine page: wider on large screens, for its two columns.
  const wide = path.startsWith('/discover');
  const isActive = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));

  return (
    <>
      <Tower />
      <div
        className={cn(
          'gutter relative z-[1] mx-auto max-w-[600px]',
          wide && 'md:max-w-[1080px]',
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
            <NavLink {...NAV[1]} active={isActive('/discover')} />
            <NavLink {...NAV[2]} active={isActive('/for-you')} />
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              aria-label="Scan or upload a photo"
              className="my-1.5 flex w-16 shrink-0 flex-col min-[420px]:w-[78px] items-center justify-center gap-[3px] border-2 border-moss text-[11px] font-extrabold tracking-[.03em] text-moss uppercase"
            >
              <Camera className="size-6" strokeWidth={2} aria-hidden />
              Scan
            </button>
            <NavLink {...NAV[3]} active={isActive('/agenda')} />
            <NavLink {...NAV[4]} active={isActive('/me')} />
          </div>
        </nav>
      )}
      <Toaster aboveNav={!pushed} />
      <ScanSheet open={scanOpen} onOpenChange={setScanOpen} />
    </>
  );
}
