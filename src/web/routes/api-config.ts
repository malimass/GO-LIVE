import { Router } from 'express';
import { CookieManager } from '../../instagram/cookie-manager.js';
import { logger } from '../../logging/logger.js';
import {
  getFacebookDestinations, upsertFacebook, deleteFacebook,
  getInstagramAccounts, upsertInstagram, updateInstagramCookies, deleteInstagram,
} from '../../db/index.js';
import { reloadDestinations, type Config } from '../../config/index.js';

export function createApiConfigRouter(config: Config): Router {
  const router = Router();
  const cookieManager = new CookieManager(config.encryptionKey);

  // === FACEBOOK ===

  router.get('/facebook', (_req, res) => {
    res.json(getFacebookDestinations());
  });

  router.post('/facebook', (req, res) => {
    try {
      const { id, name, rtmpUrl, streamKey } = req.body;
      if (!name || !streamKey) {
        res.status(400).json({ error: 'name e streamKey sono obbligatori' });
        return;
      }
      upsertFacebook(
        id || null,
        name,
        rtmpUrl || 'rtmps://live-api-s.facebook.com:443/rtmp/',
        streamKey,
      );
      reloadDestinations(config);
      logger.info(`Facebook destination saved: ${name}`);
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
      facebook: getFacebookDestinations(),
      instagram: getInstagramAccounts().map((a) => ({
        ...a,
        cookies_enc: undefined,
        hasCookies: !!a.cookies_enc,
      })),
    });
  });

  return router;
}
