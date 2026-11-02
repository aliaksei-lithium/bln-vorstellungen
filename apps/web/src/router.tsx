import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { EmptyState } from '@/components/States';
import { BrowsePage, BrowseSearch } from '@/pages/Browse';
import { EventPage } from '@/pages/EventPage';
import { AgendaPage } from '@/pages/Agenda';
import { DiscoverPage } from '@/pages/Discover';
import { ForYouPage } from '@/pages/Inbox';
import { LoginPage } from '@/pages/Login';
import { MePage } from '@/pages/Me';
import { ScanPage } from '@/pages/ScanPage';
import { VenuePage } from '@/pages/VenuePage';

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <EmptyState title="Page not found">Check the address, or go back to Browse.</EmptyState>,
});

const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: BrowsePage,
    validateSearch: (s: Record<string, unknown>) => BrowseSearch.parse(s),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/e/$slug',
    component: function EventRoute() {
      const { slug } = eventRoute.useParams();
      return <EventPage slug={slug} />;
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/for-you', component: ForYouPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/discover', component: DiscoverPage }),
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
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/scan/$id',
    component: function ScanRoute() {
      const { id } = scanRoute.useParams();
      return <ScanPage id={id} />;
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/venue/$id',
    component: function VenueRoute() {
      const { id } = venueRoute.useParams();
      return <VenuePage id={id} />;
    },
  }),
  // The old name, for bookmarks and installed shortcuts.
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/inbox',
    beforeLoad: () => {
      throw redirect({ to: '/for-you', replace: true });
    },
  }),
] as const;
const eventRoute = routes[1];
const loginRoute = routes[6];
const scanRoute = routes[7];
const venueRoute = routes[8];

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
