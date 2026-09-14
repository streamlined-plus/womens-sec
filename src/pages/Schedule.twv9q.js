/*************************************************************
 * PAGE CODE — /schedule
 *
 * Adds SportsEvent structured data (JSON-LD) so Google and
 * answer engines can read the fixtures as events, not just text.
 * This is what earns rich results and what AI search quotes.
 *
 * DELIBERATELY DECOUPLED FROM YOUR LAYOUT.
 * It queries the WnbaGames collection directly instead of
 * reading your dataset, so it does not care what you named the
 * dataset or repeater, and it will not break if you restyle or
 * rebuild the page.
 *
 * It also never touches the repeater. The repeater must stay
 * connected to its dataset IN THE EDITOR — that connection is
 * what makes Wix server-render the fixtures into the HTML.
 * Setting repeater .data from code would switch the page back
 * to client-side rendering and destroy the indexability this
 * whole approach exists for.
 *************************************************************/

import wixData from 'wix-data';
import { seo } from '@wix/site-seo';
// Legacy fallback if the import above errors on this site:
//   import wixSeo from 'wix-seo-frontend';
//   ...then call wixSeo.setStructuredData(...) instead of seo.setStructuredData(...)

const SITE = 'https://www.womenssec.com';
const PAGE_URL = `${SITE}/schedule`;
const MAX_EVENTS = 50;   // plenty for rich results; keeps the payload small

$w.onReady(async () => {
  try {
    // Upcoming and recent fixtures, soonest first.
    const cutoff = new Date(Date.now() - 2 * 86400000); // include the last 2 days

    const res = await wixData.query('WnbaGames')
      .eq('league', 'wnba')
      .ge('startUtc', cutoff)
      .ascending('startUtc')
      .limit(MAX_EVENTS)
      .find();

    const games = res.items || [];
    if (!games.length) return;

    await seo.setStructuredData(buildStructuredData(games));
  } catch (err) {
    // SEO extras must never break the visible page.
    console.error('[schedule seo]', err);
  }
});

/** One schema.org SportsEvent per fixture. */
function buildStructuredData(games) {
  return games.map(g => {
    const node = {
      '@context': 'https://schema.org',
      '@type': 'SportsEvent',
      name: `${g.awayName} at ${g.homeName}`,
      startDate: new Date(g.startUtc).toISOString(),
      // schema.org has no "finished" status — EventScheduled is correct for
      // both upcoming and completed fixtures.
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      url: PAGE_URL,
      sport: 'Basketball',
      competitor: [
        { '@type': 'SportsTeam', name: g.awayName, logo: g.awayLogo || undefined },
        { '@type': 'SportsTeam', name: g.homeName, logo: g.homeLogo || undefined }
      ]
    };

    if (g.venue) {
      node.location = {
        '@type': 'Place',
        name: g.venue,
        address: { '@type': 'PostalAddress', addressCountry: 'US' }
      };
    }

    if (g.broadcast) {
      node.broadcastOfEvent = { '@type': 'BroadcastEvent', name: g.broadcast };
    }

    return node;
  });
}
