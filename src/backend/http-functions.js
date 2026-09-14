/**********************************************************
 * backend/http-functions.js — WomensSEC.com
 * Public HTTP endpoints. Live URLs:
 *   https://www.womenssec.com/_functions/technicals
 * Serves the 2025 WNBA technicals widget as a full HTML page,
 * so the homepage embeds it from our own domain.
 **********************************************************/
import { ok } from 'wix-http-functions';
import { TECHNICALS_HTML } from 'backend/technicalsHtml';

export function get_technicals(request) {
  return ok({
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    },
    body: TECHNICALS_HTML
  });
}
