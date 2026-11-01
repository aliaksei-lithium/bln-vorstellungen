import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { EmptyState } from '@/components/States';
import { BrowsePage } from '@/pages/Browse';
import { EventPage } from '@/pages/EventPage';
import { AgendaPage } from '@/pages/Agenda';
import { InboxPage } from '@/pages/Inbox';
import { LoginPage } from '@/pages/Login';
import { MePage } from '@/pages/Me';

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <EmptyState title="Page not found">Check the address, or go back to Browse.</EmptyState>,
});

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: BrowsePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/e/$slug',
    component: function EventRoute() {
      const { slug } = eventRoute.useParams();
      return <EventPage slug={slug} />;
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/inbox', component: InboxPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/agenda', component: AgendaPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/me', component: MePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/login/$token',
    component: function LoginRoute() {
      const { token } = loginRoute.useParams();
      return <LoginPage token={token} />;
    },
  }),
] as const;
const eventRoute = routes[1];
const loginRoute = routes[5];

export const router = createRouter({
  routeTree: rootRoute.addChildren([...routes]),
  scrollRestoration: true,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
