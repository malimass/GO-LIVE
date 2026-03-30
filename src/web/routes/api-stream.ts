import { Router } from 'express';
import { logger } from '../../logging/logger.js';
import type { DistributionManager } from '../../distribution/manager.js';
import type { Config } from '../../config/index.js';

export function createApiStreamRouter(distribution: DistributionManager, config: Config): Router {
  const router = Router();

  router.post('/stop', async (_req, res) => {
    try {
      if (!distribution.isLive) {
        res.json({ success: false, message: 'Non in live' });
        return;
      }
      await distribution.stopAll();
      logger.info('Distribution stopped manually via dashboard');
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
