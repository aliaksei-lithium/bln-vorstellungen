import type { AskResponse, AskTurn, EventListItem } from '@bln/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowUp, ExternalLink, Loader2, Plus, RotateCcw, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EventRow } from '@/components/EventRow';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Ask (docs/11): a question in your own words, answered from the programme (and the web when it has nothing). A chat
 * button at the bottom right on every page for signed-in users; it opens as a sheet on phones and a corner panel on
 * larger screens. The conversation lives in this tab only; the server keeps nothing but a count.
 */

type Exchange = { q: string; r: AskResponse };
const KEY = 'bln.ask';
const IDEAS = ['Something loud this weekend', 'What should I book early?', 'Anything in Russian or Belarusian?'];

function load(): Exchange[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as Exchange[];
  } catch {
    return [];
  }
}

/** The chat button and its panel. `aboveNav` lifts both over the bottom navigation. */
export function AskChat({ aboveNav }: { aboveNav: boolean }) {
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Opening an event from an answer leaves the chat; it is one tap away to come back.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  const lift = aboveNav
    ? 'bottom-[calc(80px+env(safe-area-inset-bottom,0px))]'
    : 'bottom-[calc(16px+env(safe-area-inset-bottom,0px))]';
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ask about what’s on"
          className={cn(
            'fixed right-[max(16px,env(safe-area-inset-right,0px))] z-30 flex h-12 items-center gap-1.5 border-2 border-ink bg-ink px-3.5 text-[13px] font-extrabold tracking-[.06em] text-on-ink uppercase shadow-[4px_4px_0_0_var(--color-moss)]',
            lift,
          )}
        >
          <Sparkles className="size-[18px]" aria-hidden />
          Ask
        </button>
      )}
      {open && (
        <>
          <div className="fixed inset-0 z-30 bg-ink/30 md:hidden" aria-hidden onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Ask"
            className={cn(
              'fixed z-40 flex flex-col border-ink bg-surface',
              // Phones: a sheet from the bottom. Larger screens: a panel in the corner, above the nav.
              'inset-x-0 bottom-0 h-[82dvh] border-t-2 pb-[env(safe-area-inset-bottom,0px)]',
              'md:inset-x-auto md:right-4 md:h-[min(640px,calc(100dvh-140px))] md:w-[400px] md:border-2 md:pb-0 md:shadow-[6px_6px_0_0_var(--color-moss)]',
              aboveNav ? 'md:bottom-[calc(80px+env(safe-area-inset-bottom,0px))]' : 'md:bottom-4',
            )}
          >
            <AskPanel onClose={() => setOpen(false)} />
          </div>
        </>
      )}
    </>
  );
}

function AskPanel({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<Exchange[]>(load);
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const left = useQuery({ queryKey: ['ask-left'], queryFn: api.askLeft, staleTime: 60_000 });
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(log.slice(-6)));
    } catch {
      // Private mode: the conversation lasts as long as the page.
    }
  }, [log]);
  const toEnd = () =>
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }));
  useEffect(() => {
    toEnd();
    input.current?.focus();
  }, []);
  const send = useMutation({
    mutationFn: (q: string) => {
      const turns: AskTurn[] = [
        ...log.slice(-5).flatMap((x): AskTurn[] => [
          { role: 'user', text: x.q },
          { role: 'assistant', text: x.r.answer.slice(0, 4000) },
        ]),
        { role: 'user', text: q },
      ];
      return api.ask({ turns });
    },
    onSuccess: (r, q) => {
      setLog((l) => [...l, { q, r }]);
      setText('');
      void left.refetch();
      toEnd();
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'That did not work. Try again.'),
  });
  const submit = (q = text) => {
    const v = q.trim();
    if (v.length >= 3 && !send.isPending) {
      send.mutate(v);
      toEnd();
    }
  };
  const remaining = log.at(-1)?.r.left ?? left.data;

  return (
    <>
      <div className="flex h-11 shrink-0 items-center justify-between bg-ink pr-1 pl-3 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase">
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3.5" aria-hidden />
          Ask
        </span>
        <span className="flex items-center">
          {log.length > 0 && (
            <button
              type="button"
              onClick={() => setLog([])}
              className="flex h-9 items-center gap-1 px-2 text-[11px] tracking-[.08em] text-on-ink/80 uppercase"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              New
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-9 items-center justify-center"
          >
            <X className="size-5" aria-hidden />
          </button>
        </span>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {log.length === 0 && !send.isPending && (
          <div className="grid gap-2 p-3">
            <p className="m-0 text-sm text-sub">
              Ask about what’s on in your own words. Answers come from the programme, and from the web when it has
              nothing.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {IDEAS.map((idea) => (
                <button
                  key={idea}
                  type="button"
                  onClick={() => submit(idea)}
                  className="border border-line px-2 py-1 text-[12.5px] font-semibold text-sub hover:border-ink hover:text-ink"
                >
                  {idea}
                </button>
              ))}
            </div>
          </div>
        )}
        {log.map((x, i) => (
          <div key={i} className="grid gap-2.5 border-b border-line p-3">
            <p className="m-0 justify-self-end bg-chip px-2.5 py-1.5 text-[14px] font-semibold">{x.q}</p>
            <Answer r={x.r} />
          </div>
        ))}
        {send.isPending && (
          <div className="grid gap-2 p-3">
            <p className="m-0 justify-self-end bg-chip px-2.5 py-1.5 text-[14px] font-semibold">{send.variables}</p>
            <p className="m-0 flex items-center gap-2 text-sm text-sub" aria-live="polite">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Looking through the programme…
            </p>
          </div>
        )}
      </div>

      <form
        className="grid shrink-0 gap-1.5 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Your question</span>
            <textarea
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              maxLength={1000}
              placeholder={log.length ? 'Ask a follow-up' : 'Ask about what’s on'}
              className="block max-h-32 min-h-11 w-full resize-none border border-ink bg-surface px-3 py-2.5 text-[15px] outline-none placeholder:text-sub focus:outline-2 focus:outline-offset-1 focus:outline-moss"
            />
          </label>
          <Button type="submit" size="icon" className="size-11" disabled={send.isPending || text.trim().length < 3}>
            {send.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}
            <span className="sr-only">Ask</span>
          </Button>
        </div>
        <p className="m-0 text-xs text-sub">
          {remaining
            ? `${remaining.questions} questions and ${remaining.searches} web searches left today.`
            : 'Answers come from the programme; the web only when it has nothing.'}
        </p>
      </form>
    </>
  );
}

/** The answer text with `[[slug]]` as links, then the events it names, then what it found on the web. */
function Answer({ r }: { r: AskResponse }) {
  const bySlug = new Map(r.events.map((e) => [e.slug, e]));
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-1.5 text-[14.5px] leading-[21px]">
        {r.answer
          .split(/\n{2,}/)
          .filter((p) => p.trim())
          .map((p, i) => (
            <p key={i} className="m-0 whitespace-pre-line">
              {withLinks(p, bySlug)}
            </p>
          ))}
      </div>
      {r.events.length > 0 && (
        <div className="border border-line">
          {r.events.map((e) => (
            <EventRow key={e.slug} item={e} showDay />
          ))}
        </div>
      )}
      {r.found.map((f, i) => (
        <Found key={i} f={f} />
      ))}
    </div>
  );
}

function withLinks(p: string, bySlug: Map<string, EventListItem>): ReactNode[] {
  return p.split(/(\[\[[a-z0-9-]+\]\])/g).map((part, i) => {
    const slug = /^\[\[([a-z0-9-]+)\]\]$/.exec(part)?.[1];
    if (!slug) return part;
    const e = bySlug.get(slug);
    return (
      <Link
        key={i}
        to="/e/$slug"
        params={{ slug }}
        className="font-bold text-ink underline decoration-moss underline-offset-2"
      >
        {e?.title ?? slug}
      </Link>
    );
  });
}

function Found({ f }: { f: AskResponse['found'][number] }) {
  const navigate = useNavigate();
  const add = useMutation({
    mutationFn: () => api.scanText([f.title, f.when, f.venue, f.note, f.url].filter(Boolean).join('\n')),
    onSuccess: (s) => navigate({ to: '/scan/$id', params: { id: s.id } }),
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not add it.'),
  });
  return (
    <div className="flex items-start gap-3 border border-dashed border-ink p-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-extrabold tracking-[.1em] text-moss uppercase">Found online</div>
        <div className="font-bold [overflow-wrap:anywhere]">{f.title}</div>
        <div className="text-[12.5px] text-sub">{[f.when, f.venue].filter(Boolean).join(' · ')}</div>
        {f.note && <p className="mt-0.5 mb-0 text-[13px]">{f.note}</p>}
        {f.url && (
          <a
            href={f.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-moss"
          >
            Where it was found <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>
      <Button size="sm" disabled={add.isPending} onClick={() => add.mutate()}>
        {add.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
        Add
      </Button>
    </div>
  );
}
