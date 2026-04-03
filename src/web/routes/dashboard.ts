import { Router } from 'express';
import { getFacebookDestinations, getInstagramAccounts } from '../../db/index.js';
import type { DistributionManager } from '../../distribution/manager.js';

export function createDashboardRouter(config: unknown, distribution: DistributionManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const fbDests = getFacebookDestinations().map((fb) => ({
      ...fb,
      page_access_token: undefined,
      hasToken: !!fb.page_access_token,
      hasStreamKey: !!fb.stream_key,
      live_description: (fb as any).live_description || '',
    }));
    const igAccounts = getInstagramAccounts();

    res.render('dashboard', {
      isLive: distribution.isLive,
      statuses: distribution.getStatuses(),
      fbDests,
      igAccounts: igAccounts.map((a) => ({
        ...a,
        cookies_enc: undefined,
        hasCookies: !!a.cookies_enc,
      })),
    });
  });

  return router;
}
