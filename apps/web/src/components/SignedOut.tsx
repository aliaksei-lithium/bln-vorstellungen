import { Link } from '@tanstack/react-router';
import { InviteRequest } from '@/components/InviteRequest';
import { EmptyState } from '@/components/States';
import { Button } from '@/components/ui/button';

/** Invite-only: what anonymous visitors see on personal tabs. */
export function SignedOut({ title }: { title: string }) {
  return (
    <div className="grid gap-3">
      <EmptyState
        title={title}
        action={
          <Button asChild>
            <Link to="/">Browse all events</Link>
          </Button>
        }
      >
        Personal picks and an agenda are for invited people. The site stays open to everyone.
      </EmptyState>
      <InviteRequest />
    </div>
  );
}
