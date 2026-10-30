import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { EmptyState } from '@/components/States';
import { BrowsePage } from '@/pages/Browse';
import { EventPage } from '@/pages/EventPage';
import { AgendaPage, InboxPage, MePage } from '@/pages/Personal';

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
] as const;
const eventRoute = routes[1];

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
