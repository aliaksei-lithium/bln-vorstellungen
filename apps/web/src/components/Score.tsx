import type { Reason } from '@bln/shared';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 0-100 match score: filled Moss from 80, outlined from 60, muted below. */
export function ScoreBox({ score, big = false }: { score: number; big?: boolean }) {
  return (
    <span
      aria-label={`Score ${score} of 100`}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border font-extrabold tabular-nums',
        big ? 'size-14 text-2xl' : 'size-10 text-[17px]',
        score >= 80
          ? 'border-moss bg-moss text-on-moss'
          : score >= 60
            ? 'border-2 border-moss bg-surface text-ink'
            : 'border-sub bg-surface text-sub',
      )}
    >
      {score}
    </span>
  );
}

/** "Why this": the score next to its strongest reasons. */
export function WhyThis({ score, reasons }: { score: number; reasons: Reason[] }) {
  const shown = reasons.slice(0, 2);
  return (
    <div className="flex items-center gap-3">
      <ScoreBox score={score} big />
      <div className="min-w-0">
        <small className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-extrabold tracking-[.1em] text-sub uppercase">
          <Sparkles className="size-3.5" strokeWidth={2} aria-hidden />
          Why this
        </small>
        {shown.length ? (
          shown.map((r, i) => (
            <p
              key={i}
              className={cn(
                'm-0',
                i === 0 ? 'text-[14.5px] leading-5 font-semibold' : 'mt-0.5 text-[13px] leading-[18px] text-sub',
                r.kind === 'against' && 'text-sub',
              )}
            >
              {r.kind === 'against' ? '– ' : ''}
              {r.text}
            </p>
          ))
        ) : (
          <p className="m-0 text-[14.5px] leading-5 font-semibold text-sub">Ranked by how close it is to your taste.</p>
        )}
      </div>
    </div>
  );
}
