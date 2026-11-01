import { useEffect, useSyncExternalStore } from 'react';

/** One toast at a time, with an optional Undo (design D: ink bar above the nav, 150 ms fade). */

type Toast = { id: number; message: string; undo?: () => void };

let current: Toast | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(message: string, undo?: () => void) {
  clearTimeout(timer);
  current = { id: Date.now(), message, undo };
  emit();
  timer = setTimeout(dismiss, 5000);
}

function dismiss() {
  current = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function Toaster({ aboveNav }: { aboveNav: boolean }) {
  const t = useSyncExternalStore(subscribe, () => current);
  useEffect(() => () => clearTimeout(timer), []);
  if (!t) return null;
  return (
    <div
      key={t.id}
      role="status"
      className="toast-in fixed left-1/2 z-40 flex min-h-12 w-[min(calc(100%-24px),576px)] -translate-x-1/2 items-center justify-between gap-2 bg-ink py-1 pr-1.5 pl-3.5 text-[13.5px] font-semibold text-on-ink"
      style={{
        bottom: aboveNav
          ? 'calc(64px + 12px + env(safe-area-inset-bottom, 0px))'
          : 'calc(12px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <span className="line-clamp-2 min-w-0">{t.message}</span>
      {t.undo && (
        <button
          type="button"
          onClick={() => {
            t.undo?.();
            dismiss();
          }}
          className="h-9 shrink-0 px-3 text-xs font-extrabold tracking-[.08em] text-on-ink uppercase underline-offset-4 hover:underline"
        >
          Undo
        </button>
      )}
    </div>
  );
}
