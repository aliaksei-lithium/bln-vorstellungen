import { CATEGORY_LABELS, type Category } from '@bln/shared';
import { cn } from '@/lib/utils';

export const categoryColor = (c: Category) => `var(--cat-${c}, var(--cat-other))`;

export function CategoryDot({ category, className }: { category: Category; className?: string }) {
  return (
    <span className={cn('inline-block size-1.5 shrink-0', className)} style={{ background: categoryColor(category) }} />
  );
}

/** Small uppercase chip; category colour only as a dot, per the brief. */
export function CategoryChip({ category, className }: { category: Category; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-[5px] rounded-[2px] bg-chip px-1.5 text-[10.5px] leading-none font-bold tracking-[.05em] whitespace-nowrap text-ink uppercase',
        className,
      )}
    >
      <CategoryDot category={category} />
      {CATEGORY_LABELS[category]}
    </span>
  );
}
