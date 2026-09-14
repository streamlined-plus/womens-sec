/*************************************************************
 * backend/wnbaCore.js   — WomensSEC.com
 *
 * Provider adapter + cache + the scheduled job.
 *
 * This is a PLAIN backend module, not a .web.js file, and that
 * is deliberate: a .web.js file is expected to export only web
 * methods, so shared helpers and the job function live here
 * instead. wnba.web.js imports from this file; jobs.config
 * points at the job function at the bottom.
 *
 * Depends on ONE CMS collection: WnbaCache — already created
 * on this site, with a unique index on cacheKey.
 *************************************************************/

import { fetch } from 'wix-fetch';
import wixData from 'wix-data';

/* ============================================================
   1. CONFIG
   ============================================================ */

export const SITE_API = 'https://site.api.espn.com/apis/site/v2/sports';
const COLLECTION = 'WnbaCache';
const DB = { suppressAuth: true, suppressHooks: true };
const TIMEOUT_MS = 12000;

export const LEAGUES = {
  wnba:  { path: 'basketball/wnba',                      label: 'WNBA'  },
  nwsl:  { path: 'soccer/usa.nwsl',                      label: 'NWSL'  },
  ncaaw: { path: 'basketball/womens-college-basketball', label: 'NCAAW' }
};

// These are the blueprint's ISR revalidate intervals, by volatility.
export const TTL = {
  SCOREBOARD: 30,      // game clock moves
  SCHEDULE: 1800,      // future fixtures rarely change
  STANDINGS: 900,
  TEAMS: 86400,
  ROSTER: 86400,
  SUMMARY: 45
};

export const isLeague = k => Object.prototype.hasOwnProperty.call(LEAGUES, k);

/* ============================================================
   2. CACHE  (the Redis substitute)
   ============================================================ */

export async function cacheRead(key, ttlSeconds, producer) {
  let existing = null;
  try {
    const res = await wixData.query(COLLECTION).eq('cacheKey', key).limit(1).find(DB);
    existing = res.items[0] || null;
  } catch (err) {
    console.warn(`[cache] read failed ${key}: ${err.message}`);
  }

  if (existing) {
    const ageMs = Date.now() - new Date(existing.refreshedAt).getTime();
    if (ageMs < ttlSeconds * 1000) {
      return JSON.parse(existing.payload);
    }
  }

  try {
    const data = await producer();
    await cacheWrite(key, data);
    return data;
  } catch (err) {
    // Stale beats broken on a live game page.
    if (existing) {
      console.warn(`[cache] upstream failed ${key}, serving stale: ${err.message}`);
      return JSON.parse(existing.payload);
    }
    throw err;
  }
}

export async function cacheWrite(key, data) {
  const payload = JSON.stringify(data);
  if (payload.length > 400000) {
    throw new Error(`[cache] ${key} is ${payload.length} bytes — too large`);
  }
  const res = await wixData.query(COLLECTION).eq('cacheKey', key).limit(1).find(DB);
  const record = { cacheKey: key, payload, refreshedAt: new Date(), bytes: payload.length };
  if (res.items[0]) {
    record._id = res.items[0]._id;
    return wixData.update(COLLECTION, record, DB);
  }
  return wixData.insert(COLLECTION, record, DB);
}

/* ============================================================
   3. PROVIDER ADAPTER  (swap this section to change vendors)
   ============================================================ */

export async function getJson(url) {
  const res = await fetch(url, {
    method: 'get',
    timeout: TIMEOUT_MS,
    // NO User-Agent header. Verified against the live endpoint: ESPN's edge
    // returns 403 Access Denied for ANY UA containing "Mozilla" on these API
    // paths (a browser UA hitting a JSON API reads as scraping). Sending no UA
    // returns 200. Do not "fix" this by adding a browser UA — that breaks it.
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`ESPN ${res.status} ${res.statusText} :: ${url}`);
  return res.json();
}

function normCompetitor(c) {
  const t = c.team || {};
  const overall = (c.records || []).find(r => r.type === 'total' || r.name === 'overall');
  return {
    teamId: t.id,
    name: t.displayName,
    shortName: t.shortDisplayName,
    abbr: t.abbreviation,
    logo: t.logo,
    color: t.color ? `#${t.color}` : '#333333',
    score: Number(c.score || 0),
    record: overall ? overall.summary : '',
    homeAway: c.homeAway
  };
}

function normEvent(e) {
  const comp = (e.competitions && e.competitions[0]) || {};
  const status = (comp.status && comp.status.type) || {};
  const list = (comp.competitors || []).map(normCompetitor);
  const bc = (comp.broadcasts && comp.broadcasts[0] && comp.broadcasts[0].names) || [];
  return {
    gameId: e.id,
    startUtc: e.date,
    shortName: e.shortName,
    state: status.state || 'pre',
    statusDetail: status.shortDetail || '',
    period: (comp.status && comp.status.period) || 0,
    clock: (comp.status && comp.status.displayClock) || '',
    venue: (comp.venue && comp.venue.fullName) || '',
    broadcast: bc.join(', '),
    home: list.find(c => c.homeAway === 'home') || list[0] || {},
    away: list.find(c => c.homeAway === 'away') || list[1] || {}
  };
}

export async function apiScoreboard(leagueKey, datesParam) {
  const lg = LEAGUES[leagueKey];
  const qs = datesParam ? `?dates=${datesParam}` : '';
  const data = await getJson(`${SITE_API}/${lg.path}/scoreboard${qs}`);
  const season = (data.leagues && data.leagues[0] && data.leagues[0].season) || {};
  return {
    league: leagueKey,
    leagueLabel: lg.label,
    seasonYear: season.year || null,
    fetchedAt: new Date().toISOString(),
    games: (data.events || []).map(normEvent)
  };
}

/* ============================================================
   4. SCHEDULED JOB  (registered in jobs.config)
   Runs hourly — Wix's shortest allowed interval. Warms the
   slow-moving feeds so no visitor ever pays the upstream wait.
   Runs with NO current member: never call wix-members here.
   ============================================================ */

// Leagues the hourly job keeps fresh. Rows carry a `league` field, so each
// league's page filters its own dataset (the /schedule dataset filters
// league = wnba and never shows NWSL rows).
// NCAAW is deliberately NOT here: ESPN's college endpoint rejects date-range
// queries (404, verified live) and full-D1 volume needs its own sync strategy
// — likely an SEC-only conference filter. Do not add 'ncaaw' without that.
const ACTIVE_LEAGUES = ['wnba', 'nwsl'];
const GAMES_COLLECTION = 'WnbaGames';
const SYNC_DAYS = 30;

/* ESPN publishes undetermined playoff slots as TBD vs TBD with a placeholder
   00:00 tip. Those carry no information and must never reach an indexable
   page — a crawler would read them as real fixtures at midnight. */
function isPlaceholder(g) {
  const a = ((g.away && g.away.abbr) || '').toUpperCase();
  const h = ((g.home && g.home.abbr) || '').toUpperCase();
  return a === 'TBD' || h === 'TBD';
}

function etParts(iso) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'
  }).format(d);
  return { dayEt: day, timeEt: time + ' ET' };
}

/**
 * Mirror the next SYNC_DAYS of fixtures into the WnbaGames collection.
 *
 * This exists for ONE reason: a repeater bound to a dataset is rendered by
 * Wix on the server, so the fixtures are in the HTML that crawlers receive.
 * A repeater populated by page code is client-side JS and indexes far less
 * reliably. The cache collection serves the app; this one serves search.
 */
export async function syncGamesToCollection(league = 'wnba') {
  const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const range = `${ymd(new Date())}-${ymd(new Date(Date.now() + SYNC_DAYS * 86400000))}`;
  const board = await apiScoreboard(league, range);

  const rows = board.games.filter(g => !isPlaceholder(g)).map(g => {
    const { dayEt, timeEt } = etParts(g.startUtc);
    return {
      gameId: `${league}:${g.gameId}`,
      league,
      matchup: `${g.away.shortName || g.away.name} at ${g.home.shortName || g.home.name}`,
      startUtc: new Date(g.startUtc),
      dayEt, timeEt,
      state: g.state,
      statusDetail: g.statusDetail || '',
      homeName: g.home.name || '', homeAbbr: g.home.abbr || '',
      homeLogo: g.home.logo || '', homeScore: g.home.score || 0,
      homeRecord: g.home.record || '',
      awayName: g.away.name || '', awayAbbr: g.away.abbr || '',
      awayLogo: g.away.logo || '', awayScore: g.away.score || 0,
      awayRecord: g.away.record || '',
      venue: g.venue || '', broadcast: g.broadcast || ''
    };
  });

  // Carry each existing row's _id so bulkSave updates instead of duplicating.
  const existing = await wixData.query(GAMES_COLLECTION)
    .eq('league', league).limit(1000).find(DB);
  const idByGame = new Map(existing.items.map(i => [i.gameId, i._id]));

  const toSave = rows.map(r => idByGame.has(r.gameId) ? { ...r, _id: idByGame.get(r.gameId) } : r);
  if (toSave.length) await wixData.bulkSave(GAMES_COLLECTION, toSave, DB);

  // Drop rows for fixtures ESPN no longer lists (postponements, reschedules)
  // that are still in the future. Past games stay as results.
  const liveIds = new Set(rows.map(r => r.gameId));
  const stale = existing.items.filter(
    i => !liveIds.has(i.gameId) && new Date(i.startUtc) > new Date()
  );
  if (stale.length) await wixData.bulkRemove(GAMES_COLLECTION, stale.map(i => i._id), DB);

  return `${league}:games synced ${toSave.length} (removed ${stale.length})`;
}

export async function refreshReferenceData() {
  const log = [];

  for (const league of ACTIVE_LEAGUES) {
    try {
      const board = await apiScoreboard(league);
      await cacheWrite(`${league}:scoreboard:today`, board);
      log.push(`${league}:scoreboard ok (${board.games.length})`);
    } catch (err) {
      log.push(`${league}:scoreboard FAILED ${err.message}`);
    }

    try {
      log.push(await syncGamesToCollection(league));
    } catch (err) {
      log.push(`${league}:games FAILED ${err.message}`);
    }
  }

  console.log('[dataRefresh] ' + log.join(' | '));
  return log;
}
