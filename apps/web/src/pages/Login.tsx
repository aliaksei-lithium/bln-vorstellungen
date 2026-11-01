import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/AppShell';
import { EmptyState } from '@/components/States';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';

/**
 * /login/:token — signs in with a one-time link. The token is sent with a POST from the page, so link previews in
 * chat apps (which only GET the URL and run no scripts) cannot use it up.
 */
export function LoginPage({ token }: { token: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    api
      .login(token)
      .then((r) => {
        qc.setQueryData(['me'], r);
        void qc.invalidateQueries();
        void navigate({ to: '/inbox', replace: true });
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not sign in. Try again.'));
  }, [token, qc, navigate]);

  return (
    <>
      <TopBar right="Sign in" />
      {error ? (
        <EmptyState
          title="This link does not work"
          action={
            <Button asChild>
              <Link to="/">Browse events</Link>
            </Button>
          }
        >
          {error} Login links work once and expire after 7 days. Ask the owner for a new one, or create one from Me on a
          device where you are signed in.
        </EmptyState>
      ) : (
        <EmptyState title="Signing you in…">One moment.</EmptyState>
      )}
    </>
  );
}
