import { Router } from 'express';
import type { DistributionManager } from '../../distribution/manager.js';

export function createApiStatusRouter(distribution: DistributionManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      live: distribution.isLive,
      startedAt: distribution.startedAt?.toISOString() || null,
      destinations: distribution.getStatuses(),
    });
  });

  return router;
}
