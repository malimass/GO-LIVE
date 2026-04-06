import { Router } from 'express';
import crypto from 'crypto';
import type { Config } from '../../config/index.js';
import { getFacebookDestinations, upsertFacebook } from '../../db/index.js';
import { reloadDestinations } from '../../config/index.js';
import { logger } from '../../logging/logger.js';

const FB_GRAPH_VERSION = 'v25.0';
const FB_GRAPH_URL = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;

interface FbTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface FbPage {
  id: string;
  name: string;
  access_token: string;
}

interface FbPagesResponse {
  data: FbPage[];
  paging?: { next?: string };
}

export function createFacebookOAuthRouter(config: Config): Router {
  const router = Router();

  // GET /api/facebook-oauth/start — redirect user to Facebook OAuth
  router.get('/start', (req, res) => {
    if (!config.fbAppId || !config.fbAppSecret) {
      res.status(400).json({ error: 'FB_APP_ID e FB_APP_SECRET non configurati nel .env' });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    req.session.fbOAuthState = state;

    const redirectUri = config.fbOAuthRedirectUri ||
      `${req.protocol}://${req.get('host')}/api/facebook-oauth/callback`;

    const params = new URLSearchParams({
      client_id: config.fbAppId,
      redirect_uri: redirectUri,
      scope: 'pages_manage_posts,pages_read_engagement',
      state,
      response_type: 'code',
    });

    const url = `https://www.facebook.com/${FB_GRAPH_VERSION}/dialog/oauth?${params}`;
    res.json({ url });
  });

  // GET /api/facebook-oauth/callback — Facebook redirects here after auth
  router.get('/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query as Record<string, string>;

      if (error) {
        logger.warn(`[FB OAuth] User denied: ${error}`);
        res.redirect('/?fb_oauth=denied');
        return;
      }

      if (!state || state !== req.session.fbOAuthState) {
        logger.warn('[FB OAuth] Invalid state parameter');
        res.redirect('/?fb_oauth=error&msg=invalid_state');
        return;
      }

      delete req.session.fbOAuthState;

      const redirectUri = config.fbOAuthRedirectUri ||
        `${req.protocol}://${req.get('host')}/api/facebook-oauth/callback`;

      // Step 1: Exchange code for short-lived user token
      const tokenParams = new URLSearchParams({
        client_id: config.fbAppId,
        redirect_uri: redirectUri,
        client_secret: config.fbAppSecret,
        code,
      });

      const tokenResp = await fetch(`${FB_GRAPH_URL}/oauth/access_token?${tokenParams}`);
      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        logger.error(`[FB OAuth] Token exchange failed: ${err}`);
        res.redirect('/?fb_oauth=error&msg=token_exchange_failed');
        return;
      }

      const tokenData = await tokenResp.json() as FbTokenResponse;

      // Step 2: Exchange for long-lived user token
      const longParams = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: config.fbAppId,
        client_secret: config.fbAppSecret,
        fb_exchange_token: tokenData.access_token,
      });

      const longResp = await fetch(`${FB_GRAPH_URL}/oauth/access_token?${longParams}`);
      let longLivedToken = tokenData.access_token;

      if (longResp.ok) {
        const longData = await longResp.json() as FbTokenResponse;
        longLivedToken = longData.access_token;
        logger.info('[FB OAuth] Got long-lived user token');
      } else {
        logger.warn('[FB OAuth] Could not get long-lived token, using short-lived');
      }

      // Step 3: Fetch all pages the user manages
      const pages: FbPage[] = [];
      let pagesUrl: string | null = `${FB_GRAPH_URL}/me/accounts?access_token=${encodeURIComponent(longLivedToken)}&fields=id,name,access_token&limit=100`;

      while (pagesUrl) {
        const pagesResp = await fetch(pagesUrl);
        if (!pagesResp.ok) {
          const err = await pagesResp.text();
          logger.error(`[FB OAuth] Fetch pages failed: ${err}`);
          break;
        }
        const pagesData = await pagesResp.json() as FbPagesResponse;
        pages.push(...pagesData.data);
        pagesUrl = pagesData.paging?.next || null;
      }

      logger.info(`[FB OAuth] Found ${pages.length} pages`);

      // Store pages in session for the frontend to display
      req.session.fbOAuthPages = pages.map((p) => ({
        id: p.id,
        name: p.name,
        access_token: p.access_token,
      }));

      res.redirect('/?fb_oauth=success');
    } catch (err) {
      logger.error(`[FB OAuth] Callback error: ${err instanceof Error ? err.message : String(err)}`);
      res.redirect('/?fb_oauth=error&msg=server_error');
    }
  });

  // GET /api/facebook-oauth/pages — return pages found during OAuth
  router.get('/pages', (req, res) => {
    const pages = req.session.fbOAuthPages || [];
    res.json({ pages });
  });

  // POST /api/facebook-oauth/save-pages — save selected pages as FB destinations
  router.post('/save-pages', (req, res) => {
    try {
      const { pages } = req.body as { pages: Array<{ id: string; name: string; access_token: string }> };

      if (!pages || !Array.isArray(pages) || pages.length === 0) {
        res.status(400).json({ error: 'Nessuna pagina selezionata' });
        return;
      }

      // Get existing destinations to avoid duplicates
      const existing = getFacebookDestinations();
      const existingPageIds = new Map(existing.map((d) => [d.page_id, d.id]));

      let added = 0;
      let updated = 0;

      for (const page of pages) {
        const existingId = existingPageIds.get(page.id);

        // If destination already exists, update token but keep mode; otherwise default to stream_key_auto
        const existingRow = existingId ? existing.find((d) => d.id === existingId) : null;
        const destMode = existingRow ? existingRow.mode : 'stream_key_auto';

        upsertFacebook({
          id: existingId || null,
          name: page.name,
          mode: destMode as any,
          pageId: page.id,
          pageAccessToken: page.access_token,
          liveTitle: existingRow?.live_title || 'LIVE',
          streamKey: existingRow?.stream_key || '',
          rtmpUrl: existingRow?.rtmp_url || 'rtmps://live-api-s.facebook.com:443/rtmp/',
        });

        if (existingId) {
          updated++;
        } else {
          added++;
        }
      }

      // Reload config
      reloadDestinations(config);

      // Clear session data
      delete req.session.fbOAuthPages;

      logger.info(`[FB OAuth] Saved ${added} new + ${updated} updated page destinations`);
      res.json({ success: true, added, updated });
    } catch (err) {
      logger.error(`[FB OAuth] Save error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'Errore nel salvataggio' });
    }
  });

  return router;
}
