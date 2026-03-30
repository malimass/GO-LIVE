import { Router } from 'express';
import type { Config } from '../../config/index.js';
import type { DistributionManager } from '../../distribution/manager.js';

export function createDashboardRouter(config: Config, distribution: DistributionManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.render('dashboard', {
      isLive: distribution.isLive,
      statuses: distribution.getStatuses(),
      fbCount: config.facebook.length,
      igCount: config.instagram.length,
      igAccounts: config.instagram.map((ig) => ig.username),
    });
  });

  return router;
}
