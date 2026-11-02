import { useMutation } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/**
 * "Ask for an invite" (docs/09, 2026-11-02): visitors leave a name, an email and, if they like, what they enjoy; the
 * owner reviews requests and sends a personal login link. The note becomes their first taste.
 */
export function InviteRequest() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [website, setWebsite] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api.requestInvite({ name, email, ...(note.trim() ? { note } : {}), ...(website ? { website } : {}) }),
  });
  const field = 'grid gap-1 text-xs font-extrabold tracking-[.08em] text-sub uppercase';
  const input =
    'w-full border border-ink bg-surface px-3 text-[15px] font-semibold tracking-normal text-ink normal-case outline-none focus-visible:outline-2 focus-visible:outline-moss';
  return (
    <section id="invite" className="border border-ink bg-surface">
      <div className="bg-ink px-3 py-2 text-xs font-extrabold tracking-[.1em] text-on-ink uppercase">
        Ask for an invite
      </div>
      {send.isSuccess ? (
        <p className="m-0 flex items-start gap-2 p-3 text-sm">
          <Check className="mt-0.5 size-4 shrink-0 text-moss" strokeWidth={3} aria-hidden />
          Thanks, {name.split(' ')[0]}. Your request is in; a personal login link comes to {email} once it is reviewed.
        </p>
      ) : (
        <form
          className="grid gap-3 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <p className="m-0 text-sm text-sub">
            Members get picks ranked for their taste, daily highlights made for them, an agenda and a calendar feed.
          </p>
          <label className={field}>
            Name
            <input
              className={`${input} h-11`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              autoComplete="name"
            />
          </label>
          <label className={field}>
            Email
            <input
              className={`${input} h-11`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={200}
              autoComplete="email"
            />
          </label>
          <label className={field}>
            What do you like going to? (optional)
            <textarea
              className={`${input} min-h-20 py-2 leading-5`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Post-punk gigs, contemporary dance, no musicals…"
            />
          </label>
          {/* Honeypot: hidden from people, filled by bots. */}
          <input
            className="hidden"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            name="website"
          />
          <Button type="submit" variant="default" disabled={send.isPending} className="justify-self-start">
            {send.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Send request
          </Button>
          {send.isError && (
            <p role="alert" className="m-0 text-sm font-semibold text-danger">
              {send.error.message}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
