/*************************************************************
 * backend/wnba.web.js   — WomensSEC.com
 *
 * The ONLY surface page code may call. Exports web methods and
 * nothing else; all shared logic lives in backend/wnbaCore.js.
 *
 * Permissions.Anyone throughout: this is public, factual sports
 * data. The browser still never reaches ESPN directly — that
 * would burn rate limit once per visitor instead of once per
 * TTL, and would leak credentials once you move to a paid feed.
 *************************************************************/

import { Permissions, webMethod } from 'wix-web-module';
import wixData from 'wix-data';
import { cacheRead, apiScoreboard, apiScoreboardWindow, getJson, LEAGUES, TTL, SITE_API, isLeague } from 'backend/wnbaCore';

/* ============================================================
   4. PUBLIC WEB METHODS
   Public, factual sports data — Permissions.Anyone is correct.
   ============================================================ */

/** Today's games (or one specific YYYYMMDD). */
export const getScoreboard = webMethod(Permissions.Anyone, async (league = 'wnba', date) => {
  if (!isLeague(league)) throw new Error(`Unsupported league: ${league}`);
  const key = `${league}:scoreboard:${date || 'today'}`;
  return cacheRead(key, TTL.SCOREBOARD, () => apiScoreboard(league, date));
});

/**
 * Forward-looking schedule, grouped by calendar day.
 * @param {string} league
 * @param {number} days  how far ahead to look (1–60, default 14)
 */
export const getSchedule = webMethod(Permissions.Anyone, async (league = 'wnba', days = 14) => {
  if (!isLeague(league)) throw new Error(`Unsupported league: ${league}`);

  const span = Math.min(Math.max(parseInt(days, 10) || 14, 1), 60);
  const today = new Date().toISOString().slice(0, 10);

  // apiScoreboardWindow handles both fetch strategies: one range request for
  // WNBA/NWSL, a per-day loop for the college endpoint (which rejects ranges).
  return cacheRead(`${league}:schedule:${today}:${span}d`, TTL.SCHEDULE, async () => {
    const board = await apiScoreboardWindow(league, span);

    // Group into days so the UI can render date headers directly.
    const byDay = new Map();
    board.games
      .slice()
      .sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc))
      .forEach(g => {
        // Bucket by EASTERN date — a 10pm ET tip is "tonight", not tomorrow.
        const et = new Date(new Date(g.startUtc).toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const dayKey = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey).push(g);
      });

    return {
      league: board.league,
      leagueLabel: board.leagueLabel,
      seasonYear: board.seasonYear,
      fetchedAt: board.fetchedAt,
      rangeDays: span,
      totalGames: board.games.length,
      days: Array.from(byDay.entries()).map(([date, games]) => ({ date, games }))
    };
  });
});

/** Standings grouped by conference. */
export const getStandings = webMethod(Permissions.Anyone, async (league = 'wnba', year) => {
  if (!isLeague(league)) throw new Error(`Unsupported league: ${league}`);
  const season = year || new Date().getFullYear();

  return cacheRead(`${league}:standings:${season}`, TTL.STANDINGS, async () => {
    const lg = LEAGUES[league];
    const data = await getJson(`${SITE_API}/${lg.path}/standings?season=${season}`);
    const pick = (stats, name) => {
      const s = (stats || []).find(x => x.name === name);
      return s ? (s.displayValue ?? s.value) : '';
    };
    return {
      league, season,
      fetchedAt: new Date().toISOString(),
      groups: (data.children || []).map(g => ({
        groupName: g.name || g.abbreviation || '',
        entries: ((g.standings && g.standings.entries) || []).map(e => ({
          teamId: e.team && e.team.id,
          name: e.team && e.team.displayName,
          abbr: e.team && e.team.abbreviation,
          logo: (e.team && e.team.logos && e.team.logos[0] && e.team.logos[0].href) || '',
          wins: pick(e.stats, 'wins'),
          losses: pick(e.stats, 'losses'),
          pct: pick(e.stats, 'winPercent'),
          gamesBehind: pick(e.stats, 'gamesBehind'),
          streak: pick(e.stats, 'streak')
        }))
      }))
    };
  });
});

/** Every team in a league. */
export const getTeams = webMethod(Permissions.Anyone, async (league = 'wnba') => {
  if (!isLeague(league)) throw new Error(`Unsupported league: ${league}`);
  return cacheRead(`${league}:teams`, TTL.TEAMS, async () => {
    const lg = LEAGUES[league];
    const data = await getJson(`${SITE_API}/${lg.path}/teams`);
    const rows = (data.sports && data.sports[0] && data.sports[0].leagues
                  && data.sports[0].leagues[0] && data.sports[0].leagues[0].teams) || [];
    return {
      league,
      fetchedAt: new Date().toISOString(),
      teams: rows.map(r => {
        const t = r.team || {};
        return {
          teamId: t.id,
          name: t.displayName,
          abbr: t.abbreviation,
          color: t.color ? `#${t.color}` : '#333333',
          logo: (t.logos && t.logos[0] && t.logos[0].href) || t.logo || '',
          venue: (t.venue && t.venue.fullName) || '',
          slug: (t.displayName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        };
      })
    };
  });
});

/** Active roster for one team. */
export const getRoster = webMethod(Permissions.Anyone, async (league, teamId) => {
  if (!isLeague(league)) throw new Error(`Unsupported league: ${league}`);
  if (!teamId) throw new Error('teamId is required');

  return cacheRead(`${league}:roster:${teamId}`, TTL.ROSTER, async () => {
    const lg = LEAGUES[league];
    const data = await getJson(`${SITE_API}/${lg.path}/teams/${teamId}/roster`);
    const ath = data.athletes || [];
    const flat = (ath[0] && Array.isArray(ath[0].items))
      ? ath.reduce((acc, g) => acc.concat(g.items || []), [])
      : ath;
    return {
      league, teamId: String(teamId),
      fetchedAt: new Date().toISOString(),
      players: flat.map(a => ({
        playerId: a.id,
        name: a.fullName || a.displayName,
        jersey: a.jersey || '',
        position: (a.position && a.position.abbreviation) || '',
        college: (a.college && a.college.name) || '',
        headshot: (a.headshot && a.headshot.href) || ''
      }))
    };
  });
});

/** Box score, leaders, and shot coordinates for one game. */
export const getGameSummary = webMethod(Permissions.Anyone, async (league, gameId) => {
  if (!isLeague(league)) throw new Error(`Unsupported league: ${league}`);
  if (!gameId) throw new Error('gameId is required');

  return cacheRead(`${league}:summary:${gameId}`, TTL.SUMMARY, async () => {
    const lg = LEAGUES[league];
    const data = await getJson(`${SITE_API}/${lg.path}/summary?event=${gameId}`);
    return {
      league, gameId: String(gameId),
      fetchedAt: new Date().toISOString(),
      boxscore: data.boxscore || null,
      leaders: data.leaders || [],
      shots: (data.plays || [])
        .filter(p => p.shootingPlay && p.coordinate)
        .map(p => ({
          playerId: (p.participants && p.participants[0] && p.participants[0].athlete
                     && p.participants[0].athlete.id) || null,
          teamId: p.team && p.team.id,
          made: p.scoringPlay === true,
          pointsValue: p.scoreValue || 0,
          period: p.period && p.period.number,
          text: p.text,
          x: p.coordinate.x,
          y: p.coordinate.y
        }))
    };
  });
});

/**
 * Per-player season + career averages, from the WnbaPlayerStats collection
 * (kept fresh by the hourly job). Sorted by scoring by default.
 * @param {string} league
 * @param {string} [teamId]  omit for all synced teams
 */
export const getPlayerStats = webMethod(Permissions.Anyone, async (league = 'wnba', teamId) => {
  if (!isLeague(league)) throw new Error(`Unsupported league: ${league}`);
  let q = wixData.query('WnbaPlayerStats').eq('league', league).descending('pts').limit(100);
  if (teamId) q = q.eq('teamId', String(teamId));
  const res = await q.find();
  return { league, teamId: teamId ? String(teamId) : null, count: res.items.length, players: res.items };
});

/** Leagues this site serves. Drives nav and filters. */
export const getLeagues = webMethod(Permissions.Anyone, async () =>
  Object.keys(LEAGUES).map(k => ({ key: k, label: LEAGUES[k].label }))
);
