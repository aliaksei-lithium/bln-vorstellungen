import type { ReactNode } from 'react';
import { Button } from './ui/button';

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2.5 border border-ink bg-surface px-4 py-7 text-center">
      <h2 className="text-xl font-extrabold">{title}</h2>
      {children && <p className="max-w-[34ch] text-sub">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState title="Couldn’t load events" action={<Button onClick={onRetry}>Try again</Button>}>
      {message}
    </EmptyState>
  );
}

/** Skeleton for the day-grouped list: same frame and row height as the real thing. */
export function ListSkeleton() {
  return (
    <div className="border border-ink bg-surface-a" aria-busy="true" aria-label="Loading events">
      <div className="h-8 bg-ink" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-16 items-center gap-3 border-b border-line px-3 last:border-b-0">
          <div className="hatch size-12 animate-pulse motion-reduce:animate-none" />
          <div className="grid flex-1 gap-2">
            <div className="h-3.5 w-2/3 bg-chip" />
            <div className="h-3 w-1/3 bg-chip" />
          </div>
        </div>
      ))}
    </div>
  );
}
