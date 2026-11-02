import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { TopBar } from '@/components/AppShell';

/**
 * Privacy policy and terms (docs/09, 2026-11-03): public pages on the site's own domain, which Google's OAuth consent
 * screen links to. Plain and specific to what this site actually stores and sends; update them with any change.
 */

const CONTACT = 'aliaksei.zhynhiarouski@gmail.com';
const UPDATED = '3 November 2026';

function Page({ title, short, children }: { title: string; short: string; children: ReactNode }) {
  return (
    <>
      <TopBar right={short}>
        <h1 className="m-0 pb-3 text-[26px] leading-tight font-extrabold tracking-tight">{title}</h1>
      </TopBar>
      <article className="grid max-w-[68ch] gap-4 border border-ink bg-surface p-4 text-[15px] leading-[23px] [&_h2]:m-0 [&_h2]:mt-2 [&_h2]:text-[17px] [&_h2]:font-extrabold [&_li]:mt-1 [&_p]:m-0 [&_ul]:m-0 [&_ul]:list-disc [&_ul]:pl-5">
        <p className="text-sm text-sub">Last updated {UPDATED}</p>
        {children}
        <p className="text-sm text-sub">
          Questions: <span className="font-semibold text-ink select-all">{CONTACT}</span>.{' '}
          <Link to="/privacy" className="text-moss">
            Privacy
          </Link>{' '}
          ·{' '}
          <Link to="/terms" className="text-moss">
            Terms
          </Link>
        </p>
      </article>
    </>
  );
}

export function PrivacyPage() {
  return (
    <Page title="Privacy policy" short="Privacy">
      <p>
        BLN Vorstellungen is a personal, non-commercial project by Aliaksei Zhynhiarouski in Berlin. It lists cultural
        events from venues’ public programmes and ranks them for people who sign in. This page says what it keeps about
        you and why.
      </p>

      <h2>Visitors</h2>
      <p>
        Without signing in you can use the site without giving anything. Your choices (sources, categories, theme) stay
        in your browser’s local storage. The hosting provider, Cloudflare, keeps short-lived request logs for security.
        If you ask for an invite, we keep your name, email and note until the request is answered.
      </p>

      <h2>Signed-in users</h2>
      <ul>
        <li>Your name and email, to sign you in, and one session cookie.</li>
        <li>
          What you tell the site: your taste description, settings, the events you mark, and the photos or text you scan
          to add events.
        </li>
        <li>
          Scores and reasons computed for you, daily highlights and Discover editions. Questions you ask in Ask are not
          stored, only how many you asked today.
        </li>
      </ul>

      <h2>Spotify and YouTube Music</h2>
      <p>Connecting either is optional and can be undone on the Me page at any time.</p>
      <ul>
        <li>
          Spotify: we read your top and followed artists, and, when you ask for it, create a private playlist in your
          account.
        </li>
        <li>
          YouTube (read-only access): we read the channel names of videos you liked in the Music category and of the
          channels you subscribe to, with their topic categories, to find artists you listen to. We never post, change
          or delete anything in your account.
        </li>
        <li>
          We store only the artist names (with genres) and the access token needed to update them. They are used for one
          thing: ranking events for you and showing concerts by those artists. Disconnecting deletes both.
        </li>
      </ul>
      <p>
        BLN Vorstellungen’s use and transfer of information received from Google APIs adheres to the{' '}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-moss"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Data from Google or Spotify is never sold, never used for advertising,
        never shared with anyone else except as described below, and never used to train AI models.
      </p>

      <h2>Services that process data</h2>
      <ul>
        <li>Cloudflare hosts the site and its database, files and AI models (Workers AI).</li>
        <li>
          Anthropic (Claude), through Cloudflare’s AI Gateway, reads event texts, your taste and artist names to score
          events, write highlights and answer Ask questions, and searches the web for Ask and highlights. Anthropic does
          not train on this data.
        </li>
        <li>Spotify and Google, only when you connect them, as described above.</li>
      </ul>

      <h2>Keeping and deleting</h2>
      <p>
        Your data stays while you have an account. Disconnecting Spotify or YouTube Music deletes what came from them.
        Write to the address below to have your account and everything in it deleted, or to get a copy of it.
      </p>
    </Page>
  );
}

export function TermsPage() {
  return (
    <Page title="Terms of service" short="Terms">
      <p>
        BLN Vorstellungen is a free, personal project. By using it you agree to these terms. Accounts are by invitation.
      </p>
      <h2>The listings</h2>
      <p>
        Events are read automatically from venues’ and organisers’ public programmes, partly with AI, and may be
        incomplete, out of date or wrong. Check dates, prices and tickets with the venue before you go. Titles, texts
        and images belong to their venues and organisers; each event links to its sources.
      </p>
      <h2>Using the site</h2>
      <p>
        Use it for your own planning. Do not try to break it, overload it, scrape it at scale or get into other people’s
        accounts. Accounts that do may be closed.
      </p>
      <h2>No warranty</h2>
      <p>
        The site is provided as it is, without any warranty, and may change or stop at any time. As far as the law
        allows, there is no liability for decisions made based on it.
      </p>
      <h2>Changes</h2>
      <p>These terms may change; the date at the top says when they last did.</p>
    </Page>
  );
}
