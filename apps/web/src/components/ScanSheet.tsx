import { Link, useNavigate } from '@tanstack/react-router';
import { Camera, ChevronLeft, ChevronRight, History, ImageUp, Info, Loader2, Type } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { photoDay, shrinkPhoto } from '@/lib/image';

/**
 * "Add an event" (mockup D): take a photo, upload one, or paste text. The input is uploaded and read in the
 * background; the review page shows what was found. Nothing is added before the user confirms there.
 */
export function ScanSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useMe();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'home' | 'text'>('home');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setMode('home');
      setError(null);
    }
  };
  const start = async (send: () => Promise<{ id: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await send();
      close(false);
      setText('');
      void navigate({ to: '/scan/$id', params: { id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const onFile = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') && !/\.hei[cf]$/i.test(file.name)) {
      setError('That file isn’t an image. Choose a photo or a screenshot.');
      return;
    }
    void start(async () => api.scanPhoto(await shrinkPhoto(file), photoDay(file)));
  };

  const option =
    'flex min-h-16 w-full items-center gap-3 border border-ink px-4 text-left text-[15.5px] font-extrabold disabled:opacity-50';
  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" className="mx-auto max-w-[600px] border-x border-ink">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-1">
            {mode === 'text' && (
              <Button variant="ghost" size="icon" aria-label="Back" className="-ml-3" onClick={() => setMode('home')}>
                <ChevronLeft className="size-6" aria-hidden />
              </Button>
            )}
            {mode === 'text' ? 'Paste text' : 'Add an event'}
          </SheetTitle>
          <SheetDescription className="text-[15px] leading-5">
            {mode === 'text'
              ? 'From a newsletter, a message or a website. One event or a whole programme.'
              : 'Any photo works: a poster on the street, a flyer, a magazine page or a screenshot. AI reads the dates, venues and prices.'}
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-2 px-4 pb-6">
          {!user ? (
            <div className="border border-moss bg-moss-soft p-3 text-sm">
              Adding events is for signed-in users. <Link to="/me">Sign in</Link> first.
            </div>
          ) : mode === 'home' ? (
            <>
              <button
                type="button"
                className={`${option} bg-moss text-on-moss`}
                disabled={busy}
                onClick={() => camera.current?.click()}
              >
                <Camera className="size-7" strokeWidth={2} aria-hidden />
                <span className="grid">
                  Take photo<small className="text-xs font-semibold opacity-80">Opens the camera</small>
                </span>
              </button>
              <button
                type="button"
                className={`${option} bg-surface`}
                disabled={busy}
                onClick={() => library.current?.click()}
              >
                <ImageUp className="size-[26px]" strokeWidth={2} aria-hidden />
                <span className="grid">
                  Upload from library
                  <small className="text-xs font-semibold text-sub">JPG, PNG, HEIC or a screenshot</small>
                </span>
              </button>
              <Button size="lg" disabled={busy} onClick={() => setMode('text')}>
                <Type aria-hidden />
                Paste text
              </Button>
              <input
                ref={camera}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => onFile(e.currentTarget)}
              />
              <input ref={library} type="file" accept="image/*" hidden onChange={(e) => onFile(e.currentTarget)} />
              {busy && (
                <p className="m-0 flex items-center gap-2 text-sm text-sub" aria-live="polite">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Uploading…
                </p>
              )}
              <p className="m-0 mt-2 flex gap-2 border border-line p-3 text-sm text-sub">
                <Info className="mt-px size-[18px] shrink-0" aria-hidden />
                You review everything before it is added. Nothing is published automatically.
              </p>
              <Link
                to="/scans"
                onClick={() => close(false)}
                className="flex min-h-12 items-center gap-3 px-1 font-bold text-ink no-underline"
              >
                <History className="size-5" aria-hidden />
                <span className="flex-1">Your scans</span>
                <ChevronRight className="size-5 text-sub" aria-hidden />
              </Link>
            </>
          ) : (
            <form
              className="grid gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim().length < 10) return setError('Paste a bit more text.');
                void start(() => api.scanText(text));
              }}
            >
              <label className="grid gap-1.5 text-xs font-extrabold tracking-[.08em] text-sub uppercase">
                Text with dates
                <textarea
                  value={text}
                  rows={8}
                  maxLength={20000}
                  autoFocus
                  placeholder="Peer Gynt – Schaubühne, Sa 14.11., 20 Uhr, Karten ab 16 €"
                  onChange={(e) => setText(e.target.value)}
                  className="w-full resize-y border border-ink bg-surface p-3 text-[15px] leading-[21px] font-normal tracking-normal text-ink normal-case outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-moss"
                />
              </label>
              <Button type="submit" variant="default" size="lg" disabled={busy}>
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                Read text
              </Button>
            </form>
          )}
          {error && (
            <p role="alert" className="m-0 text-sm font-semibold text-danger">
              {error}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
