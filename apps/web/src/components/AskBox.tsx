import type { AskResponse, AskTurn, EventListItem } from '@bln/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowUp, ExternalLink, Loader2, Plus, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EventRow } from '@/components/EventRow';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * Ask (docs/11): a question in your own words, answered from the programme (and the web when it has nothing). The
 * conversation lives in this tab only; the server keeps nothing but a count.
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

export function AskBox() {
  const [log, setLog] = useState<Exchange[]>(load);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const left = useQuery({ queryKey: ['ask-left'], queryFn: api.askLeft, staleTime: 60_000 });
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(log.slice(-6)));
    } catch {
      // Private mode: the conversation lasts as long as the page.
    }
  }, [log]);
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
      requestAnimationFrame(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'That did not work. Try again.'),
  });
  const submit = (q = text) => {
    const v = q.trim();
    if (v.length >= 3 && !send.isPending) send.mutate(v);
  };
  const remaining = log.at(-1)?.r.left ?? left.data;

  return (
    <section className="border border-ink bg-surface" aria-label="Ask">
      <div className="flex h-9 items-center justify-between bg-ink px-3 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase">
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3.5" aria-hidden />
          Ask
        </span>
        {log.length > 0 && (
          <button
            type="button"
            onClick={() => setLog([])}
            className="flex items-center gap-1 text-[11px] tracking-[.08em] text-on-ink/80 uppercase"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            New question
          </button>
        )}
      </div>

      {log.map((x, i) => (
        <div key={i} className="grid gap-2.5 border-b border-line p-3">
          <p className="m-0 justify-self-end rounded-none bg-chip px-2.5 py-1.5 text-[14px] font-semibold">{x.q}</p>
          <Answer r={x.r} />
        </div>
      ))}

      <form
        className="grid gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {log.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {IDEAS.map((idea) => (
              <button
                key={idea}
                type="button"
                disabled={send.isPending}
                onClick={() => {
                  setText(idea);
                  submit(idea);
                }}
                className="border border-line px-2 py-1 text-[12.5px] font-semibold text-sub hover:border-ink hover:text-ink"
              >
                {idea}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Your question</span>
            <textarea
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
              className="block max-h-40 min-h-11 w-full resize-y border border-ink bg-surface px-3 py-2.5 text-[15px] outline-none placeholder:text-sub focus:outline-2 focus:outline-offset-1 focus:outline-moss"
            />
          </label>
          <Button type="submit" size="icon" className="size-11" disabled={send.isPending || text.trim().length < 3}>
            {send.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}
            <span className="sr-only">Ask</span>
          </Button>
        </div>
        <p className="m-0 text-xs text-sub" aria-live="polite">
          {send.isPending
            ? 'Looking through the programme… a web search can take a few more seconds.'
            : remaining
              ? `${remaining.questions} questions and ${remaining.searches} web searches left today.`
              : 'Answers come from the programme; the web only when it has nothing.'}
        </p>
        <div ref={end} />
      </form>
    </section>
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
