import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A list row that swipes (mockup D): right past RIGHT_PX runs the right action; left past OPEN_PX opens the action
 * buttons behind it. One row is open at a time; tapping an open row closes it. Vertical drags scroll the page.
 */

export type SwipeAction = { label: string; icon: ReactNode; className: string; run: () => void };

const RIGHT_PX = 96;
const OPEN_PX = 88;
const BUTTON_W = 88;
const OPEN_EVENT = 'swiperow:open';

export function SwipeRow({
  id,
  enabled,
  right,
  actions = [],
  children,
}: {
  id: string;
  enabled: boolean;
  right?: SwipeAction;
  actions?: SwipeAction[];
  children: ReactNode;
}) {
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ sx: number; sy: number; base: number; active: boolean; pointer: number } | null>(null);
  const suppressClick = useRef(false);
  const width = actions.length * BUTTON_W;
  const open = x === -width && width > 0;

  // Another row opening closes this one.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setX(0);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [id]);

  if (!enabled) return <div className="border-b border-line last:border-b-0">{children}</div>;

  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.active) return;
    setDragging(false);
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 50);
    if (x >= RIGHT_PX && right) {
      setX(0);
      setTimeout(right.run, 150);
    } else if (x <= -OPEN_PX && width) {
      setX(-width);
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    } else setX(0);
  };

  return (
    <div className="relative overflow-hidden border-b border-line last:border-b-0">
      {x > 0 && right && (
        <div className={cn('absolute inset-y-0 left-0 flex w-1/2', right.className)} aria-hidden>
          <div className="flex w-24 flex-col items-center justify-center gap-1 text-xs font-extrabold tracking-[.04em] uppercase">
            {right.icon}
            {right.label}
          </div>
        </div>
      )}
      {x < 0 && (
        <div className="absolute inset-y-0 right-0 flex" style={{ width }}>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              tabIndex={open ? 0 : -1}
              onClick={() => {
                setX(0);
                a.run();
              }}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-1 text-xs font-extrabold tracking-[.04em] uppercase',
                a.className,
              )}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
      )}
      <div
        className={cn('swipe-row relative', dragging && 'dragging', x !== 0 && 'bg-surface')}
        style={x ? { transform: `translateX(${x}px)` } : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { sx: e.clientX, sy: e.clientY, base: x, active: false, pointer: e.pointerId };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.pointer !== e.pointerId) return;
          const mx = e.clientX - d.sx;
          const my = e.clientY - d.sy;
          if (!d.active) {
            if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) {
              drag.current = null; // a scroll, not a swipe
              return;
            }
            if (Math.abs(mx) < 8) return;
            d.active = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }
          setX(Math.max(-width - 20, Math.min(right ? 140 : 0, d.base + mx)));
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onClickCapture={(e) => {
          // A drag is not a tap; a tap on an open row only closes it.
          if (suppressClick.current || x !== 0) {
            e.preventDefault();
            e.stopPropagation();
            if (!suppressClick.current) setX(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
