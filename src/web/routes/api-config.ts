import { Router } from 'express';
import { CookieManager } from '../../instagram/cookie-manager.js';
import { logger } from '../../logging/logger.js';
import type { Config } from '../../config/index.js';

export function createApiConfigRouter(config: Config): Router {
  const router = Router();
  const cookieManager = new CookieManager(config.encryptionKey);

  // Upload Instagram cookies for an account
  router.post('/ig-cookies', (req, res) => {
    try {
      const { accountIndex, cookies } = req.body;

      if (typeof accountIndex !== 'number' || accountIndex < 1 || accountIndex > 3) {
        res.status(400).json({ error: 'accountIndex must be 1, 2, or 3' });
        return;
      }

      if (!cookies || !Array.isArray(cookies)) {
        res.status(400).json({ error: 'cookies must be an array of cookie objects' });
        return;
      }

      // Encrypt cookies
      const encrypted = cookieManager.encryptCookies(cookies);

      // Update in-memory config
      const envKey = `IG_ACCOUNT_${accountIndex}_COOKIES_ENC`;
      process.env[envKey] = encrypted;

      // Update config object
      const existing = config.instagram.find((ig) => ig.name === `Instagram ${accountIndex}`);
      if (existing) {
        existing.cookiesEnc = encrypted;
      } else {
        config.instagram.push({
          name: `Instagram ${accountIndex}`,
          username: process.env[`IG_ACCOUNT_${accountIndex}_USERNAME`] || `ig_account_${accountIndex}`,
          cookiesEnc: encrypted,
        });
      }

      logger.info(`Updated cookies for Instagram account ${accountIndex}`);

      res.json({
        success: true,
        envKey,
        encryptedValue: encrypted,
        message: `Cookies encrypted. Copy the value above and set it as ${envKey} in Railway env vars for persistence.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to update IG cookies: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // Get current config status (no secrets)
  router.get('/', (_req, res) => {
    res.json({
      facebook: config.facebook.map((fb) => ({ name: fb.name, configured: true })),
      instagram: config.instagram.map((ig) => ({
        name: ig.name,
        username: ig.username,
        hasCookies: !!ig.cookiesEnc,
      })),
    });
  });

  return router;
}
