import { Router } from 'express';
import { CookieManager } from '../../instagram/cookie-manager.js';
import { logger } from '../../logging/logger.js';
import {
  getFacebookDestinations, upsertFacebook, updateFacebookCookies, deleteFacebook,
  getInstagramAccounts, upsertInstagram, updateInstagramCookies, deleteInstagram,
} from '../../db/index.js';
import { reloadDestinations, type Config } from '../../config/index.js';

export function createApiConfigRouter(config: Config): Router {
  const router = Router();
  const cookieManager = new CookieManager(config.encryptionKey);

  // === FACEBOOK ===

  router.get('/facebook', (_req, res) => {
    res.json(getFacebookDestinations().map((fb) => ({
      ...fb,
      page_access_token: undefined,
      hasToken: !!fb.page_access_token,
      hasStreamKey: !!fb.stream_key,
    })));
  });

  router.post('/facebook', (req, res) => {
    try {
      const { id, name, mode, pageId, pageAccessToken, rtmpUrl, streamKey, liveTitle } = req.body;
      const fbMode = mode === 'stream_key' ? 'stream_key' : mode === 'cookie' ? 'cookie' : 'api';

      if (!name) {
        res.status(400).json({ error: 'name è obbligatorio' });
        return;
      }

      if (fbMode === 'stream_key') {
        // Stream key mode: need rtmpUrl + streamKey
        if (!streamKey) {
          res.status(400).json({ error: 'Stream Key è obbligatoria' });
          return;
        }
        upsertFacebook({
          id: id || null, name, mode: 'stream_key',
          rtmpUrl: rtmpUrl || 'rtmps://live-api-s.facebook.com:443/rtmp/',
          streamKey, liveTitle,
        });
      } else if (fbMode === 'cookie') {
        // Cookie mode: need pageId + cookies
        if (!pageId) {
          res.status(400).json({ error: 'Page ID è obbligatorio' });
          return;
        }
        upsertFacebook({
          id: id || null, name, mode: 'cookie',
          pageId, liveTitle, liveDescription: req.body.liveDescription,
        });
      } else {
        // API mode: need pageId + pageAccessToken
        if (!pageId) {
          res.status(400).json({ error: 'Page ID è obbligatorio' });
          return;
        }
        let token = pageAccessToken;
        if (id && !token) {
          const existing = getFacebookDestinations().find((fb) => fb.id === id);
          token = existing?.page_access_token || '';
        }
        if (!token) {
          res.status(400).json({ error: 'pageAccessToken è obbligatorio' });
          return;
        }
        upsertFacebook({
          id: id || null, name, mode: 'api',
          pageId, pageAccessToken: token, liveTitle,
        });
      }

      reloadDestinations(config);
      logger.info(`Facebook destination saved: ${name}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/facebook/:id/cookies', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { cookies } = req.body;

      if (!cookies || !Array.isArray(cookies)) {
        res.status(400).json({ error: 'cookies deve essere un array di cookie objects' });
        return;
      }

      const encrypted = cookieManager.encryptCookies(cookies);
      updateFacebookCookies(id, encrypted);
      reloadDestinations(config);
      logger.info(`Cookies updated for Facebook destination #${id}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/facebook/:id', (req, res) => {
    try {
      deleteFacebook(parseInt(req.params.id, 10));
      reloadDestinations(config);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // === INSTAGRAM ===

  router.get('/instagram', (_req, res) => {
    const accounts = getInstagramAccounts().map((a) => ({
      ...a,
      cookies_enc: undefined,
      hasCookies: !!a.cookies_enc,
    }));
    res.json(accounts);
  });

  router.post('/instagram', (req, res) => {
    try {
      const { id, name, username, liveTitle, audience } = req.body;
      if (!name || !username) {
        res.status(400).json({ error: 'name e username sono obbligatori' });
        return;
      }
      upsertInstagram(id || null, name, username, liveTitle, audience);
      reloadDestinations(config);
      logger.info(`Instagram account saved: ${username}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/instagram/:id/cookies', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { cookies } = req.body;

      if (!cookies || !Array.isArray(cookies)) {
        res.status(400).json({ error: 'cookies deve essere un array di cookie objects' });
        return;
      }

      const encrypted = cookieManager.encryptCookies(cookies);
      updateInstagramCookies(id, encrypted);
      reloadDestinations(config);
      logger.info(`Cookies updated for Instagram account #${id}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/instagram/:id', (req, res) => {
    try {
      deleteInstagram(parseInt(req.params.id, 10));
      reloadDestinations(config);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // === STATUS ===
  router.get('/', (_req, res) => {
    res.json({
      facebook: getFacebookDestinations().map((fb) => ({
        ...fb,
        page_access_token: undefined,
        hasToken: !!fb.page_access_token,
      })),
      instagram: getInstagramAccounts().map((a) => ({
        ...a,
        cookies_enc: undefined,
        hasCookies: !!a.cookies_enc,
      })),
    });
  });

  return router;
}
